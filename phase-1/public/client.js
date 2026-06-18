// ─────────────────────────────────────────────────────────────────────────────
// 前端 WebRTC 邏輯（對照觀念講解）
//
//   getUserMedia 拿畫面 → RTCPeerConnection 當引擎
//   → SDP 協商規格、ICE 協商路徑（都靠 WebSocket 信令轉發）
//   → 連上後影音直接 P2P 傳輸
// ─────────────────────────────────────────────────────────────────────────────

// ── DOM ──────────────────────────────────────────────────────────────────────
const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('joinBtn');
const hangupBtn = document.getElementById('hangupBtn');
const statusEl = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const logEl = document.getElementById('log');

// ── 全域狀態 ──────────────────────────────────────────────────────────────────
let ws = null;            // 信令用的 WebSocket
let pc = null;            // RTCPeerConnection，整個 WebRTC 的引擎
let localStream = null;   // 自己的鏡頭/麥克風串流
let isInitiator = false;  // 我是不是發話方（負責 createOffer）

// 在 setRemoteDescription 完成前先收到的 ICE candidate 要先排隊，
// 否則 addIceCandidate 會報錯（這是新手常踩的坑）。
let pendingCandidates = [];

// 只用一組免費的公開 STUN 伺服器，幫忙查出自己的對外 IP。
// 本機兩個分頁互打其實連 STUN 都用不到，但放著讓你看到正式設定長怎樣。
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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

function sendSignal(data) {
  // 把任何要給對方的東西（offer / answer / candidate）包進 signal 丟給伺服器轉發
  ws.send(JSON.stringify({ type: 'signal', data }));
}

// ── 步驟 1：拿到自己的鏡頭畫面 ───────────────────────────────────────────────
async function startLocalMedia() {
  // 注意：getUserMedia 只在 https 或 localhost 能用，會跳出權限視窗
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  localVideo.srcObject = localStream;
  log('✅ 已取得本機鏡頭與麥克風');
}

// ── 步驟 2：建立 RTCPeerConnection 引擎並掛上事件 ─────────────────────────────
function createPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);

  // 把自己的每一條影音軌道加進連線，這些才會被傳給對方
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  // 每找到一個可能的連線路徑（candidate）就透過信令傳給對方（Trickle ICE）
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal({ candidate: e.candidate });
      log('→ 送出 ICE candidate');
    }
  };

  // 收到對方的影音 → 塞進遠端 <video>，這時才會看到對方的臉
  pc.ontrack = (e) => {
    if (remoteVideo.srcObject !== e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
      log('🎥 收到對方的影音串流');
    }
  };

  // 監聽連線狀態，方便觀察與 debug
  pc.onconnectionstatechange = () => {
    log(`連線狀態：${pc.connectionState}`);
    if (pc.connectionState === 'connected') setStatus('已連線', 'connected');
    else if (pc.connectionState === 'connecting') setStatus('連線中…', 'connecting');
    else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setStatus('已斷線');
    }
  };
}

// ── 步驟 3a：發話方產生 offer ────────────────────────────────────────────────
async function makeOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);  // local = 自己產的
  sendSignal({ sdp: pc.localDescription });
  log('→ 送出 offer');
}

// ── 步驟 3b：收到對方的 SDP（offer 或 answer）────────────────────────────────
async function handleRemoteSdp(sdp) {
  await pc.setRemoteDescription(sdp);    // remote = 對方傳來的
  log(`← 收到 ${sdp.type}`);

  // 排隊中的 candidate 現在可以安全加入了
  for (const c of pendingCandidates) await pc.addIceCandidate(c);
  pendingCandidates = [];

  // 如果收到的是 offer，代表我是接話方，要回一個 answer
  if (sdp.type === 'offer') {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ sdp: pc.localDescription });
    log('→ 送出 answer');
  }
}

// ── 步驟 3c：收到對方的 ICE candidate ────────────────────────────────────────
async function handleRemoteCandidate(candidate) {
  if (pc.remoteDescription) {
    await pc.addIceCandidate(candidate);
  } else {
    // remoteDescription 還沒設好，先排隊（避坑！）
    pendingCandidates.push(candidate);
  }
}

// ── 連到信令伺服器並處理它轉來的訊息 ─────────────────────────────────────────
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
      case 'waiting':
        setStatus('等待對方加入…', 'connecting');
        log('🕓 你是第一個進房的人，等待對方加入');
        break;

      case 'start':
        // 伺服器決定了角色：initiator=true 的人負責先發 offer
        isInitiator = msg.initiator;
        setStatus('連線中…', 'connecting');
        log(`對方已就緒，我的角色：${isInitiator ? '發話方 (Caller)' : '接話方 (Callee)'}`);
        createPeerConnection();
        if (isInitiator) await makeOffer();
        break;

      case 'signal':
        // 伺服器把對方的 offer/answer/candidate 轉過來了
        if (msg.data.sdp) await handleRemoteSdp(msg.data.sdp);
        else if (msg.data.candidate) await handleRemoteCandidate(msg.data.candidate);
        break;

      case 'peer-left':
        log('👋 對方離開了');
        setStatus('對方已離開');
        remoteVideo.srcObject = null;
        if (pc) { pc.close(); pc = null; }
        break;

      case 'full':
        log('⛔ 房間已滿（POC 限 2 人）');
        setStatus('房間已滿');
        break;
    }
  };

  ws.onclose = () => log('信令連線關閉');
  ws.onerror = () => log('⚠️ 信令連線發生錯誤');
}

// ── 按鈕：加入通話 ───────────────────────────────────────────────────────────
joinBtn.onclick = async () => {
  try {
    joinBtn.disabled = true;
    await startLocalMedia();          // 先拿鏡頭
    connectSignaling(roomInput.value.trim() || 'default');  // 再連信令
    hangupBtn.disabled = false;
  } catch (err) {
    log('❌ 無法取得鏡頭/麥克風：' + err.message);
    setStatus('無法取得鏡頭');
    joinBtn.disabled = false;
  }
};

// ── 按鈕：掛斷 ───────────────────────────────────────────────────────────────
hangupBtn.onclick = () => {
  if (pc) { pc.close(); pc = null; }
  if (ws) { ws.close(); ws = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  pendingCandidates = [];
  setStatus('已掛斷');
  log('已掛斷，資源已釋放');
  joinBtn.disabled = false;
  hangupBtn.disabled = true;
};
