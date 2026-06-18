// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 前端：多人 Mesh WebRTC
//
// 與 Phase 1 的核心差異：要同時管理「多條」RTCPeerConnection。
// 房間 N 人時，每個人對其他每一個人各開一條連線（full-mesh），
// 所以本機要維持 N-1 條 pc，並用 Map<peerId, ...> 來追蹤。
//
// 避免 glare 的規則：「後加入者」對每個既有成員主動發 offer（當 caller）。
// ─────────────────────────────────────────────────────────────────────────────

// ── DOM ──────────────────────────────────────────────────────────────────────
const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('joinBtn');
const micBtn = document.getElementById('micBtn');
const camBtn = document.getElementById('camBtn');
const screenBtn = document.getElementById('screenBtn');
const hangupBtn = document.getElementById('hangupBtn');
const statusEl = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const videosEl = document.getElementById('videos');
const participantListEl = document.getElementById('participantList');
const peerCountEl = document.getElementById('peerCount');
const messagesEl = document.getElementById('messages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const logEl = document.getElementById('log');

// ── 全域狀態 ──────────────────────────────────────────────────────────────────
let ws = null;
let myId = null;
let localStream = null;
let cameraTrack = null;       // 原始鏡頭 video track，螢幕分享結束後切回用
let isSharingScreen = false;

// peers: Map<peerId, { pc: RTCPeerConnection, dc: RTCDataChannel|null }>
const peers = new Map();
// 每個 peer 各自的 ICE candidate 排隊區（remoteDescription 設好前先暫存）
const pendingCandidates = new Map();

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // 跨網際網路 / 嚴格 NAT 時才需要 TURN，請改成自己的 coturn：
    // {
    //   urls: 'turn:YOUR_TURN_HOST:3478',
    //   username: 'user',
    //   credential: 'pass',
    // },
  ],
};

// ── 小工具 ────────────────────────────────────────────────────────────────────
function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

function short(id) {
  return id ? id.slice(0, 6) : '';
}

function sendSignal(to, data) {
  ws.send(JSON.stringify({ type: 'signal', to, data }));
}

// ── 成員列表 / 連線數（讓 mesh 的 N² 成本可視化）────────────────────────────
function refreshParticipants() {
  participantListEl.innerHTML = '';
  const me = document.createElement('li');
  me.className = 'me';
  me.textContent = `我（${short(myId)}）`;
  participantListEl.appendChild(me);
  for (const peerId of peers.keys()) {
    const li = document.createElement('li');
    li.textContent = `對方（${short(peerId)}）`;
    participantListEl.appendChild(li);
  }
  // 本機維持的連線數 = N-1；整個房間的 mesh 連線總數 = N*(N-1)/2
  peerCountEl.textContent = `${peers.size} 條連線`;
}

// ── 遠端視訊格的動態建立 / 移除 ──────────────────────────────────────────────
function ensureRemoteVideo(peerId) {
  let box = document.getElementById('box-' + peerId);
  if (box) return box.querySelector('video');
  box = document.createElement('div');
  box.className = 'video-box';
  box.id = 'box-' + peerId;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = `對方（${short(peerId)}）`;
  box.appendChild(video);
  box.appendChild(label);
  videosEl.appendChild(box);
  return video;
}

function removeRemoteVideo(peerId) {
  const box = document.getElementById('box-' + peerId);
  if (box) box.remove();
}

// ── 步驟 1：拿到自己的鏡頭畫面 ───────────────────────────────────────────────
async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  cameraTrack = localStream.getVideoTracks()[0];
  localVideo.srcObject = localStream;
  log('✅ 已取得本機鏡頭與麥克風');
}

// ── 步驟 2：對某個 peer 建立 RTCPeerConnection ───────────────────────────────
function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(peerId, { pc, dc: null });
  pendingCandidates.set(peerId, []);

  // 把自己的影音軌道加進這條連線
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  // Trickle ICE：找到路徑就傳給「這個」peer
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { candidate: e.candidate });
  };

  // 收到這個 peer 的影音 → 放進它專屬的視訊格
  pc.ontrack = (e) => {
    const video = ensureRemoteVideo(peerId);
    if (video.srcObject !== e.streams[0]) {
      video.srcObject = e.streams[0];
      log(`🎥 收到 ${short(peerId)} 的影音`);
    }
  };

  pc.onconnectionstatechange = () => {
    log(`與 ${short(peerId)} 的連線：${pc.connectionState}`);
    updateOverallStatus();
  };

  // 聊天用的 DataChannel：發起方建立、接收方用 ondatachannel 收
  if (isInitiator) {
    const dc = pc.createDataChannel('chat');
    setupDataChannel(peerId, dc);
  } else {
    pc.ondatachannel = (e) => setupDataChannel(peerId, e.channel);
  }

  refreshParticipants();
  return pc;
}

function setupDataChannel(peerId, dc) {
  const entry = peers.get(peerId);
  if (entry) entry.dc = dc;
  dc.onopen = () => log(`💬 與 ${short(peerId)} 的聊天通道已開啟`);
  dc.onmessage = (e) => addMessage(short(peerId), e.data, false);
}

// 連線總狀態：只要有任一條連上，就視為通話中
function updateOverallStatus() {
  const states = [...peers.values()].map((p) => p.pc.connectionState);
  if (states.includes('connected')) setStatus('通話中', 'connected');
  else if (states.includes('connecting')) setStatus('連線中…', 'connecting');
}

// ── 步驟 3：發話方對某 peer 發起 offer ───────────────────────────────────────
async function callPeer(peerId) {
  const pc = createPeerConnection(peerId, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(peerId, { sdp: pc.localDescription });
  log(`→ 對 ${short(peerId)} 送出 offer`);
}

// ── 步驟 4：處理某 peer 轉來的信令 ───────────────────────────────────────────
async function handleSignal(from, data) {
  if (data.sdp) {
    let entry = peers.get(from);
    // 收到 offer 但還沒有對應連線 → 我是接話方，補建立
    if (!entry && data.sdp.type === 'offer') {
      createPeerConnection(from, false);
      entry = peers.get(from);
    }
    if (!entry) return;
    const pc = entry.pc;

    await pc.setRemoteDescription(data.sdp);
    log(`← 收到 ${short(from)} 的 ${data.sdp.type}`);

    // 補上排隊中的 candidate
    const queued = pendingCandidates.get(from) || [];
    for (const c of queued) await pc.addIceCandidate(c);
    pendingCandidates.set(from, []);

    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { sdp: pc.localDescription });
      log(`→ 對 ${short(from)} 送出 answer`);
    }
  } else if (data.candidate) {
    const entry = peers.get(from);
    if (entry && entry.pc.remoteDescription) {
      await entry.pc.addIceCandidate(data.candidate);
    } else {
      // remoteDescription 還沒設好，先排隊（per-peer 避坑）
      const q = pendingCandidates.get(from) || [];
      q.push(data.candidate);
      pendingCandidates.set(from, q);
    }
  }
}

// ── 移除某個離開的 peer ──────────────────────────────────────────────────────
function removePeer(peerId) {
  const entry = peers.get(peerId);
  if (entry) entry.pc.close();
  peers.delete(peerId);
  pendingCandidates.delete(peerId);
  removeRemoteVideo(peerId);
  refreshParticipants();
}

// ── 聊天訊息顯示 ─────────────────────────────────────────────────────────────
function addMessage(who, text, isSelf) {
  const div = document.createElement('div');
  div.className = 'msg' + (isSelf ? ' self' : '');
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = isSelf ? '我' : who;
  div.appendChild(w);
  div.appendChild(document.createTextNode(text));
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function broadcastMessage(text) {
  for (const { dc } of peers.values()) {
    if (dc && dc.readyState === 'open') dc.send(text);
  }
  addMessage('我', text, true);
}

// ── 連到信令伺服器 ───────────────────────────────────────────────────────────
function connectSignaling(room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    log('已連上信令伺服器，加入房間：' + room);
    ws.send(JSON.stringify({ type: 'join', room }));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'joined':
        myId = msg.id;
        log(`✅ 已加入，我的 ID：${short(myId)}，房內既有 ${msg.peers.length} 人`);
        refreshParticipants();
        // 我是後到者 → 主動對每個既有成員發 offer
        for (const peerId of msg.peers) await callPeer(peerId);
        if (msg.peers.length === 0) setStatus('等待對方加入…', 'connecting');
        break;

      case 'peer-joined':
        // 有新人進來，我只需等對方的 offer（不主動發起）
        log(`🟢 ${short(msg.id)} 加入房間`);
        break;

      case 'signal':
        await handleSignal(msg.from, msg.data);
        break;

      case 'peer-left':
        log(`👋 ${short(msg.id)} 離開房間`);
        removePeer(msg.id);
        break;

      case 'full':
        log('⛔ 房間已滿');
        setStatus('房間已滿');
        break;
    }
  };

  ws.onclose = () => log('信令連線關閉');
  ws.onerror = () => log('⚠️ 信令連線錯誤');
}

// ── 按鈕：加入 ───────────────────────────────────────────────────────────────
joinBtn.onclick = async () => {
  try {
    joinBtn.disabled = true;
    await startLocalMedia();
    connectSignaling(roomInput.value.trim() || 'default');
    micBtn.disabled = camBtn.disabled = screenBtn.disabled = false;
    hangupBtn.disabled = false;
    chatInput.disabled = sendBtn.disabled = false;
  } catch (err) {
    log('❌ 無法取得鏡頭/麥克風：' + err.message);
    setStatus('無法取得鏡頭');
    joinBtn.disabled = false;
  }
};

// ── 按鈕：靜音 ───────────────────────────────────────────────────────────────
micBtn.onclick = () => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;  // 切換軌道啟用狀態即影響所有連線
  micBtn.textContent = track.enabled ? '🎤 靜音' : '🔇 解除靜音';
  micBtn.classList.toggle('active', !track.enabled);
};

// ── 按鈕：關鏡頭 ─────────────────────────────────────────────────────────────
camBtn.onclick = () => {
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = track.enabled ? '📷 關鏡頭' : '📷 開鏡頭';
  camBtn.classList.toggle('active', !track.enabled);
};

// ── 按鈕：螢幕分享（用 replaceTrack 換掉送給每個 peer 的 video 軌）──────────────
screenBtn.onclick = async () => {
  try {
    if (!isSharingScreen) {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      replaceVideoTrackForAll(screenTrack);
      localVideo.srcObject = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
      isSharingScreen = true;
      screenBtn.textContent = '🖥️ 停止分享';
      screenBtn.classList.add('active');
      log('🖥️ 開始分享螢幕');
      // 使用者從瀏覽器原生 UI 停止分享時，自動切回鏡頭
      screenTrack.onended = stopScreenShare;
    } else {
      stopScreenShare();
    }
  } catch (err) {
    log('⚠️ 螢幕分享取消或失敗：' + err.message);
  }
};

function stopScreenShare() {
  replaceVideoTrackForAll(cameraTrack);
  localVideo.srcObject = localStream;
  isSharingScreen = false;
  screenBtn.textContent = '🖥️ 分享螢幕';
  screenBtn.classList.remove('active');
  log('🖥️ 已停止分享，切回鏡頭');
}

// 對每條連線的 video sender 換軌，不需重新協商即可即時切換畫面來源
function replaceVideoTrackForAll(track) {
  for (const { pc } of peers.values()) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(track);
  }
}

// ── 聊天送出 ─────────────────────────────────────────────────────────────────
function doSend() {
  const text = chatInput.value.trim();
  if (!text) return;
  broadcastMessage(text);
  chatInput.value = '';
}
sendBtn.onclick = doSend;
chatInput.onkeydown = (e) => { if (e.key === 'Enter') doSend(); };

// ── 按鈕：掛斷 ───────────────────────────────────────────────────────────────
hangupBtn.onclick = () => {
  for (const peerId of [...peers.keys()]) removePeer(peerId);
  if (ws) { ws.close(); ws = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  localVideo.srcObject = null;
  myId = null;
  setStatus('已掛斷');
  log('已掛斷，資源已釋放');
  joinBtn.disabled = false;
  micBtn.disabled = camBtn.disabled = screenBtn.disabled = true;
  hangupBtn.disabled = true;
  chatInput.disabled = sendBtn.disabled = true;
  refreshParticipants();
};
