// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 信令伺服器（多人版）
//
// 與 Phase 1 的關鍵差異：
//   Phase 1 房間只有 2 人，訊息「轉給另一個人」即可。
//   Phase 2 一房可多人，每條連線要有「唯一 peer ID」，訊息要能「指定收件對象」。
//
// 伺服器一樣完全不懂 WebRTC，只是依 peer ID 做點對點轉發。
// 影音/聊天連上後都是瀏覽器之間直接 P2P（full-mesh），不經過這裡。
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 6; // mesh POC 的人數上限（mesh 不適合太多人）

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: Map<roomId, Map<peerId, ws>>
const rooms = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID(); // 每條連線一個唯一 peer ID
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // ── 加入房間 ──────────────────────────────────────────────────────────
      case 'join': {
        const roomId = String(msg.room || 'default');
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);

        if (room.size >= MAX_PER_ROOM) {
          send(ws, { type: 'full' });
          return;
        }

        // 把「目前房內既有成員」清單回給新加入者，
        // 由新加入者主動對每個既有成員發 offer（後到者當 caller，避免 glare）。
        const existingPeers = [...room.keys()];
        room.set(ws.id, ws);
        ws.roomId = roomId;

        send(ws, { type: 'joined', id: ws.id, peers: existingPeers });

        // 通知既有成員：有新人進來了（他們只需等對方的 offer）
        for (const [peerId, peerWs] of room) {
          if (peerId !== ws.id) send(peerWs, { type: 'peer-joined', id: ws.id });
        }
        break;
      }

      // ── 點對點轉發信令（offer / answer / ICE candidate）──────────────────────
      case 'signal': {
        const room = rooms.get(ws.roomId);
        if (!room || !msg.to) return;
        const target = room.get(msg.to);
        if (target) send(target, { type: 'signal', from: ws.id, data: msg.data });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws.id);
    // 通知房內其他人：這個 peer 離開了，請關掉對它的連線與視訊格
    for (const [, peerWs] of room) send(peerWs, { type: 'peer-left', id: ws.id });
    if (room.size === 0) rooms.delete(ws.roomId);
  });
});

server.listen(PORT, () => {
  console.log(`✅ WebRTC POC Phase 2 已啟動：http://localhost:${PORT}`);
  console.log(`   一房上限 ${MAX_PER_ROOM} 人。開多個分頁、輸入相同房間名稱即可多人通話。`);
});
