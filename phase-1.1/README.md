# Phase 1.1 — Firestore 信令版 1:1 視訊通話

Phase 1 使用 Node + WebSocket server 交換 offer / answer / ICE candidate。本階段把「信令伺服器」改成 Cloud Firestore：前端仍是原生 WebRTC API，影音仍然直接 P2P 傳輸，Firestore 只負責保存與即時同步初始交握資料；Realtime Database 只負責 presence。

## 架構差異

| 面向 | Phase 1 | Phase 1.1 |
|------|---------|-----------|
| 靜態頁面 | Express 提供 | 任意靜態 hosting / localhost |
| 信令通道 | WebSocket server 轉發 | Firestore document + subcollection |
| 媒體路徑 | 瀏覽器 P2P | 相同，Firestore 不傳影音 |
| 房間限制 | server 控制 2 人 | RTDB presence 保留 caller / callee |

## Firestore 資料結構

```text
rooms/{roomId}
  offer: { type, sdp }
  answer: { type, sdp }
  callerId, calleeId, status, closedAt

rooms/{roomId}/callerCandidates/{candidateId}
rooms/{roomId}/calleeCandidates/{candidateId}
```

第一個加入房間的人是 caller，建立 room 並寫入 offer。第二個加入的人是 callee，讀取 offer 後寫入 answer。雙方用 `onSnapshot()` 監聽對方的 ICE candidate 子集合。

## 決策紀錄

| 階段 | 痛點 | 決策 / 解法 |
|------|------|------------|
| 先用純 Firestore | 想把 server 拿掉，所以一開始把 room 狀態、離開回收都放進 Firestore。 | 可行，但會變成持續寫入或依賴手動清理，不夠省。 |
| 嘗試 heartbeat | 為了處理 tab 被關掉的情況，曾用 Firestore heartbeat 追蹤存活。 | 這會持續增加寫入量，和「降低 Firestore 用量」的目標衝突。 |
| 改成 RTDB presence | 需要一個更便宜、能處理突然斷線的 presence 機制。 | 改用 Realtime Database 的 `onDisconnect()`，只在加入 / 離開時寫入，tab 關掉也能回收。 |
| 保留 Firestore | 仍需要初始交握與 ICE 交換。 | Firestore 保留給 offer / answer / candidate，維持資料模型簡單。 |

## Firebase 設定

1. 在 Firebase Console 建立 project 與 Web app。
2. 啟用 Firestore Database。
3. 啟用 Realtime Database（只用來做 presence）。
4. 複製設定檔：

```bash
cp public/firebase-config.example.js public/firebase-config.js
```

5. 將 Firebase Web app config 填進 `public/firebase-config.js`。
6. POC 可暫用下列 rules；正式環境不可直接使用：

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, write: if true;
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
}
```

## 啟動

這個 phase 不需要 signaling server，只需要把靜態檔案用 `localhost` 提供給瀏覽器：

```bash
npm start
```

`npm start` 會執行 `python3 -m http.server ${PORT:-3000} --directory public`，預設使用 3000 埠。

如果 3000 埠已被其他服務占用，可改用：

```bash
PORT=3001 npm start
```

按「掛斷」會立即清掉該 room 的 presence 與 Firestore signaling；若不小心直接關掉 tab，Realtime Database 的 `onDisconnect()` 會自動回收該位子，下一個人可用同一房名重新加入。若房間資料卡住，可按「清理房間資料」手動刪除該 room 與 candidate 文件。

## 限制、痛點與解法

| 項目 | 限制 / 痛點 | 解決方案 |
|------|-------------|----------|
| 仍需靜態 hosting | Firestore 只取代 signaling，不提供 HTML。 | 用 Firebase Hosting、GitHub Pages，或本機 `python3 -m http.server`。 |
| NAT 穿透 | 媒體仍是 P2P，嚴格 NAT 仍可能失敗。 | 正式測試需加入 TURN，例如 coturn。 |
| 資料清理 | Firestore 不知道瀏覽器是否突然關閉，可能留下 stale room。 | UI 提供「清理房間資料」；正式環境可用 TTL 或 Cloud Functions 清理。 |
| 安全規則 | POC rules 開放任意讀寫，任何人可操作 room。 | 正式環境需加入 Firebase Auth、房間密碼或短效 token。 |
| 延遲與成本 | Firestore listener 適合低頻信令，不適合高頻媒體或大量多人狀態。 | 只交換 SDP / ICE；多人或 SFU 階段改回專用 signaling。 |

## 檔案結構

| 檔案 | 作用 |
|------|------|
| `public/index.html` | 頁面結構 |
| `public/client.js` | WebRTC + Firestore signaling 邏輯 |
| `public/style.css` | 樣式 |
| `public/firebase-config.example.js` | Firebase config 範本 |
| `package.json` | 本機靜態 server 啟動指令 |
