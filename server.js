// ─────────────────────────────────────────────────────────────────────────────
// 信令伺服器（Signaling Server）
//
// 重點觀念：這支伺服器「完全不懂 WebRTC」。
// 它只做兩件事：
//   1. 用 Express 把 public/ 裡的靜態網頁送給瀏覽器。
//   2. 用 WebSocket 當「訊息轉發站」，把一個瀏覽器送來的 offer / answer /
//      ICE candidate 原封不動轉給同一個房間裡的另一個瀏覽器。
//
// 影音資料不會經過這裡，連上線後是兩個瀏覽器直接 P2P 傳輸。
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
// 把 public/ 設成靜態目錄，瀏覽器開 http://localhost:3000/ 會拿到 index.html
app.use(express.static(path.join(__dirname, 'public')));

// 用同一個 HTTP server 同時承載 Express 與 WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: Map<roomId, Set<ws>>，記錄每個房間目前有哪些連線
const rooms = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

wss.on('connection', (ws) => {
  // 這條連線目前所在的房間，斷線時用來清理
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 不是合法 JSON 就忽略
    }

    switch (msg.type) {
      // ── 加入房間 ──────────────────────────────────────────────────────────
      case 'join': {
        const roomId = String(msg.room || 'default');

        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        const room = rooms.get(roomId);

        // POC 限制：一間房只允許 2 人
        if (room.size >= 2) {
          send(ws, { type: 'full' });
          return;
        }

        room.add(ws);
        ws.roomId = roomId;

        if (room.size === 1) {
          // 第一個進房的人：先等對方
          send(ws, { type: 'waiting' });
        } else {
          // 第二個進房的人 → 由「後到者」當發話方（initiator），負責 createOffer。
          // 規定好誰當 caller、誰當 callee，就能避免兩邊同時 offer 的 glare 衝突。
          send(ws, { type: 'start', initiator: true });
          // 通知先到的人：對方來了，你當接話方，等著收 offer
          for (const peer of room) {
            if (peer !== ws) send(peer, { type: 'start', initiator: false });
          }
        }
        break;
      }

      // ── 轉發信令（offer / answer / ICE candidate）────────────────────────────
      // 伺服器不解讀 data 內容，只負責轉給房間裡的「另一個人」。
      case 'signal': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        for (const peer of room) {
          if (peer !== ws) send(peer, { type: 'signal', data: msg.data });
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    // 通知還在房間裡的另一個人：對方離開了，請清理連線
    for (const peer of room) send(peer, { type: 'peer-left' });
    if (room.size === 0) rooms.delete(ws.roomId);
  });
});

server.listen(PORT, () => {
  console.log(`✅ WebRTC POC 已啟動：http://localhost:${PORT}`);
  console.log('   開「兩個分頁」各自輸入相同房間名稱，按「加入通話」即可互打。');
});
