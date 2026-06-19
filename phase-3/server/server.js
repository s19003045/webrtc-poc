// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 信令伺服器
//
// 與 Phase 2 完全相同的多人 mesh 信令協議（join / signal / peer-joined / ...），
// 差別只在：靜態檔案改成提供 React 打包後的 client/dist。
// 開發時前端跑 Vite（5173），透過 vite proxy 把 /ws 轉到這台（3000）。
// 正式部署時可 `npm run build` 後由這台直接服務 dist。
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 6;

const app = express();
// 提供前端打包輸出（dev 時可能還不存在，會回 404，由 Vite 服務頁面）
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: Map<roomId, Map<peerId, ws>>
const rooms = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || 'default');
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);

        if (room.size >= MAX_PER_ROOM) {
          send(ws, { type: 'full' });
          return;
        }

        const existingPeers = [...room.keys()];
        room.set(ws.id, ws);
        ws.roomId = roomId;

        send(ws, { type: 'joined', id: ws.id, peers: existingPeers });
        for (const [peerId, peerWs] of room) {
          if (peerId !== ws.id) send(peerWs, { type: 'peer-joined', id: ws.id });
        }
        break;
      }

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
    for (const [, peerWs] of room) send(peerWs, { type: 'peer-left', id: ws.id });
    if (room.size === 0) rooms.delete(ws.roomId);
  });
});

server.listen(PORT, () => {
  console.log(`✅ WebRTC POC Phase 3 信令伺服器：http://localhost:${PORT}`);
  console.log('   開發：另開終端機在 client/ 跑 `npm run dev`（Vite 會把 /ws 轉到這裡）。');
});
