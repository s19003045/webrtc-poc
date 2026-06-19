import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import {
  getDatabase,
  onDisconnect,
  ref as dbRef,
  remove,
  runTransaction as runDatabaseTransaction,
  set as setDatabaseValue,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js';

const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('joinBtn');
const hangupBtn = document.getElementById('hangupBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');
const configHint = document.getElementById('configHint');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const logEl = document.getElementById('log');

let db = null;
let rtdb = null;
let pc = null;
let role = null;
let roomRef = null;
let presenceSlotRef = null;
let localStream = null;
let pendingCandidates = [];
let unsubscribeRoom = null;
let unsubscribeCandidates = null;
let joined = false;
let currentRoomId = null;

const handledRemoteSdpTypes = new Set();
const seenRemoteCandidateIds = new Set();
const clientId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

function roomIdFromInput() {
  return roomInput.value.trim() || 'default';
}

async function loadFirebaseConfig() {
  let module;
  try {
    module = await import('./firebase-config.js');
  } catch {
    throw new Error('找不到 firebase-config.js，請先複製 firebase-config.example.js 並填入 Firebase Web app config');
  }

  const config = module.firebaseConfig;
  const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const missingKeys = requiredKeys.filter((key) => !config?.[key] || String(config[key]).startsWith('YOUR_'));
  if (missingKeys.length > 0) {
    throw new Error(`firebase-config.js 尚未填妥：${missingKeys.join(', ')}`);
  }

  return config;
}

async function ensureFirestore() {
  if (db) return db;

  const firebaseConfig = await loadFirebaseConfig();
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  rtdb = getDatabase(app);
  configHint.textContent = `Firestore project：${firebaseConfig.projectId}`;
  configHint.classList.add('ready');
  return db;
}

async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  localVideo.srcObject = localStream;
  log('✅ 已取得本機鏡頭與麥克風');
}

function localCandidateCollection() {
  return collection(roomRef, role === 'caller' ? 'callerCandidates' : 'calleeCandidates');
}

function remoteCandidateCollection() {
  return collection(roomRef, role === 'caller' ? 'calleeCandidates' : 'callerCandidates');
}

async function sendSignal(data) {
  if (!roomRef || !role) return;
  if (data.sdp) {
    const field = data.sdp.type;
    const payload = {
      type: data.sdp.type,
      sdp: data.sdp.sdp,
    };
    await setDoc(roomRef, {
      [field]: payload,
      status: data.sdp.type === 'offer' ? 'waiting-answer' : 'connected',
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return;
  }

  if (data.candidate) {
    await addDoc(localCandidateCollection(), {
      ...data.candidate,
      from: clientId,
      createdAt: serverTimestamp(),
    });
  }
}

function createPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);
  const connection = pc;

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.onicecandidate = async (event) => {
    if (!event.candidate) return;
    await sendSignal({ candidate: event.candidate.toJSON() });
    log('→ 寫入 ICE candidate 到 Firestore');
  };

  pc.ontrack = (event) => {
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      log('🎥 收到對方的影音串流');
    }
  };

  connection.onconnectionstatechange = () => {
    const state = connection.connectionState;
    log('連線狀態：' + state);
    if (state === 'connected') setStatus('已連線', 'connected');
    else if (state === 'connecting') setStatus('連線中…', 'connecting');
    else if (['disconnected', 'failed', 'closed'].includes(state)) {
      setStatus('已斷線');
    }
  };
}

async function makeOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal({ sdp: pc.localDescription });
  log('→ 寫入 offer 到 Firestore');
}

async function handleRemoteSdp(sdp) {
  if (!pc) return;
  if (handledRemoteSdpTypes.has(sdp.type)) return;
  handledRemoteSdpTypes.add(sdp.type);

  await pc.setRemoteDescription(sdp);
  log(`← 從 Firestore 收到 ${sdp.type}`);

  for (const candidate of pendingCandidates) {
    await pc.addIceCandidate(candidate);
  }
  pendingCandidates = [];

  if (sdp.type === 'offer') {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal({ sdp: pc.localDescription });
    log('→ 寫入 answer 到 Firestore');
  }
}

async function handleRemoteCandidate(candidate) {
  if (!pc) return;
  const iceCandidate = new RTCIceCandidate({
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment,
  });

  if (pc.remoteDescription) {
    await pc.addIceCandidate(iceCandidate);
    log('← 加入對方 ICE candidate');
  } else {
    pendingCandidates.push(iceCandidate);
    log('← ICE candidate 先排隊，等待 remote description');
  }
}

async function reserveRoomRole(roomId) {
  const presencePath = `rooms/${roomId}/presence`;
  const stateRef = dbRef(rtdb, presencePath);

  const result = await runDatabaseTransaction(stateRef, (currentState) => {
    const state = currentState || {};
    const caller = state.caller || null;
    const callee = state.callee || null;
    const callerActive = Boolean(caller?.active);
    const calleeActive = Boolean(callee?.active);

    if (!callerActive) {
      state.caller = {
        clientId,
        active: true,
        joinedAt: Date.now(),
      };
      return state;
    }

    if (!calleeActive) {
      state.callee = {
        clientId,
        active: true,
        joinedAt: Date.now(),
      };
      return state;
    }

    return;
  });

  if (!result.committed) {
    throw new Error('房間目前仍有人在線（Phase 1.1 POC 限 2 人）。請等對方離開或換房名。');
  }

  const state = result.snapshot.val() || {};
  const assignedCaller = state.caller?.clientId === clientId;
  const assignedCallee = state.callee?.clientId === clientId;

  if (assignedCaller) return { role: 'caller', resetSignal: true };
  if (assignedCallee) return { role: 'callee', resetSignal: !state.caller?.active };

  throw new Error('無法取得房間角色。');
}

function listenToRoom() {
  unsubscribeRoom = onSnapshot(roomRef, async (snapshot) => {
    if (!snapshot.exists()) {
      if (joined) stopCall('房間資料已被清理');
      return;
    }

    const room = snapshot.data();

    if (!pc) return;

    if (role === 'caller') {
      if (room.calleeId && !pc.remoteDescription) {
        setStatus('對方已加入，等待 answer…', 'connecting');
      }
      if (room.answer) await handleRemoteSdp(room.answer);
    }

    if (role === 'callee' && room.offer) {
      await handleRemoteSdp(room.offer);
    }
  }, (error) => {
    log('⚠️ 監聽 room 失敗：' + error.message);
  });
}

function listenToRemoteCandidates() {
  unsubscribeCandidates = onSnapshot(remoteCandidateCollection(), async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added' || seenRemoteCandidateIds.has(change.doc.id)) continue;
      seenRemoteCandidateIds.add(change.doc.id);
      await handleRemoteCandidate(change.doc.data());
    }
  }, (error) => {
    log('⚠️ 監聽 ICE candidate 失敗：' + error.message);
  });
}

async function clearRoomSignaling(roomId) {
  await ensureFirestore();
  const targetRoomRef = doc(db, 'rooms', roomId);
  await setDoc(targetRoomRef, {
    offer: deleteField(),
    answer: deleteField(),
    status: 'waiting-callee',
    updatedAt: serverTimestamp(),
  }, { merge: true });
  await deleteCandidateDocs(targetRoomRef, 'callerCandidates');
  await deleteCandidateDocs(targetRoomRef, 'calleeCandidates');
}

async function bindPresence(roleName, roomId) {
  if (!rtdb) throw new Error('Realtime Database 未初始化');
  presenceSlotRef = dbRef(rtdb, `rooms/${roomId}/presence/${roleName}`);
  await setDatabaseValue(presenceSlotRef, {
    clientId,
    active: true,
    joinedAt: Date.now(),
  });
  await onDisconnect(presenceSlotRef).remove();
}

async function joinRoom(roomId) {
  await ensureFirestore();
  currentRoomId = roomId;
  roomRef = doc(db, 'rooms', roomId);

  const reservation = await reserveRoomRole(roomId);
  role = reservation.role;

  log(`已加入 Firestore 房間：${roomId}`);
  log(`我的角色：${role === 'caller' ? '發話方 (Caller)' : '接話方 (Callee)'}`);
  setStatus(role === 'caller' ? '等待對方加入…' : '連線中…', 'connecting');

  await bindPresence(role, roomId);

  if (role === 'caller' || reservation.resetSignal) {
    await clearRoomSignaling(roomId);
  }

  createPeerConnection();
  listenToRoom();
  listenToRemoteCandidates();

  if (role === 'caller') {
    await setDoc(roomRef, {
      sessionOwnerId: clientId,
      callerId: clientId,
      callerJoinedAt: serverTimestamp(),
      status: 'waiting-callee',
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await makeOffer();
  }

  joined = true;
}

function resetPeerState() {
  if (unsubscribeRoom) unsubscribeRoom();
  if (unsubscribeCandidates) unsubscribeCandidates();
  unsubscribeRoom = null;
  unsubscribeCandidates = null;

  if (pc) pc.close();
  pc = null;
  role = null;
  roomRef = null;
  presenceSlotRef = null;
  currentRoomId = null;
  pendingCandidates = [];
  handledRemoteSdpTypes.clear();
  seenRemoteCandidateIds.clear();
}

function stopLocalMedia() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = null;
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
}

function stopCall(statusText = '已掛斷') {
  resetPeerState();
  stopLocalMedia();
  joined = false;
  setStatus(statusText);
  log(statusText);
  joinBtn.disabled = false;
  hangupBtn.disabled = true;
}

async function announceHangup() {
  if (!presenceSlotRef) return;
  await remove(presenceSlotRef);
  if (role === 'caller' && currentRoomId) {
    await clearRoomSignaling(currentRoomId);
  }
}

async function deleteCandidateDocs(targetRoomRef, name) {
  const snapshot = await getDocs(collection(targetRoomRef, name));
  await Promise.all(snapshot.docs.map((candidateDoc) => deleteDoc(candidateDoc.ref)));
}

async function cleanupRoom(roomId) {
  await ensureFirestore();
  const targetRoomRef = doc(db, 'rooms', roomId);
  await deleteCandidateDocs(targetRoomRef, 'callerCandidates');
  await deleteCandidateDocs(targetRoomRef, 'calleeCandidates');
  await deleteDoc(targetRoomRef);
}


async function leaveRoom(statusText = '已掛斷，資源已釋放') {
  try {
    await announceHangup();
  } catch (err) {
    log('⚠️ 離開時清理失敗：' + err.message);
  }
  stopCall(statusText);
}

function handlePageExit() {
  if (!joined) return;
  void leaveRoom('已離開');
}

window.addEventListener('pagehide', handlePageExit);
window.addEventListener('beforeunload', handlePageExit);

joinBtn.onclick = async () => {
  try {
    joinBtn.disabled = true;
    await startLocalMedia();
    await joinRoom(roomIdFromInput());
    hangupBtn.disabled = false;
  } catch (err) {
    log('❌ 加入失敗：' + err.message);
    setStatus('加入失敗');
    stopLocalMedia();
    resetPeerState();
    joinBtn.disabled = false;
    hangupBtn.disabled = true;
  }
};

hangupBtn.onclick = async () => {
  await leaveRoom();
};

resetBtn.onclick = async () => {
  const roomId = roomIdFromInput();
  resetBtn.disabled = true;
  try {
    if (joined) {
      await leaveRoom('已離開並準備清理房間');
    }
    await cleanupRoom(roomId);
    log(`🧹 已清理 Firestore 房間資料：${roomId}`);
    setStatus('房間資料已清理');
  } catch (err) {
    log('❌ 清理失敗：' + err.message);
    setStatus('清理失敗');
  } finally {
    resetBtn.disabled = false;
  }
};
