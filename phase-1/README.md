# WebRTC 1:1 視訊通話 POC

最小可行的點對點（P2P）視訊通話範例，用來理解 WebRTC 的核心流程。

- **信令伺服器**：Node.js + Express（靜態頁面）+ `ws`（WebSocket 轉發）
- **前端**：原生 WebRTC API（無框架），方便看清底層每一步
- **NAT 穿透**：使用 Google 免費公開 STUN（本機測試其實用不到）

## 啟動

```bash
npm install
npm start
```

看到 `✅ WebRTC POC 已啟動：http://localhost:3000` 即成功。

## 測試方式

1. 開**第一個分頁** → `http://localhost:3000` → 輸入房間名稱（例如 `test`）→ 按「加入通話」→ 允許攝影機權限。
2. 開**第二個分頁** → 同一網址 → 輸入**相同**房間名稱 → 按「加入通話」。
3. 兩邊的「對方」視窗會出現畫面，下方「連線流程紀錄」可看到 offer / answer / ICE 的完整過程。

> ⚠️ `getUserMedia` 只在 `https` 或 `localhost` 可用。用區網 IP（如 `192.168.x.x`）開會被瀏覽器擋掉攝影機權限。要跨機測試需改用 HTTPS。

## 連線流程（對照程式碼）

```
A 加入（第一個）            → 伺服器回 waiting
B 加入（第二個）            → 伺服器指派 B=發話方、A=接話方
B: createOffer → setLocal  → 信令送 offer 給 A
A: setRemote(offer)
A: createAnswer → setLocal → 信令送 answer 回 B
B: setRemote(answer)
雙方並行: onicecandidate → 信令 → addIceCandidate (Trickle ICE)
→ connectionState = connected → ontrack 顯示對方畫面 🎉
```

## 檔案結構

| 檔案 | 作用 |
|------|------|
| `server.js` | 信令伺服器：靜態服務 + WebSocket 訊息轉發（完全不懂 WebRTC） |
| `public/index.html` | 頁面結構 |
| `public/client.js` | 前端 WebRTC 核心邏輯（getUserMedia / RTCPeerConnection / SDP / ICE） |
| `public/style.css` | 樣式 |

## 決策紀錄

| 階段 | 痛點 | 決策 / 解法 |
|------|------|------------|
| 選信令傳輸 | 兩個瀏覽器要交換 SDP / ICE，但 WebRTC 規格不規定怎麼傳。 | 用最小的 `ws`（不引 socket.io），讓信令協議一目了然，專注理解 WebRTC 本身。 |
| 選前端形式 | 想清楚看見 `getUserMedia` / `RTCPeerConnection` 的每一步。 | 用原生 JS、不上框架，避免框架抽象遮住底層流程（框架留到 Phase 3）。 |
| 誰先發 offer | 兩邊同時 `createOffer` 會 glare 衝突。 | 規定「房間裡第二個進來的人當 caller」，單向發 offer。 |
| ICE candidate 時序 | candidate 可能比對方的 SDP 先到，太早 `addIceCandidate` 會出錯。 | 在 `setRemoteDescription` 之前先把 candidate 排隊，設好後再補加。 |
| NAT 穿透 | 完整 TURN 需要自架伺服器。 | 本機 / 區網用 Google 公開 STUN 即可，TURN 留到真的跨網路再加。 |

## 限制、痛點與解法

| 項目 | 限制 / 痛點 | 解決方案 |
|------|-------------|----------|
| 房間人數 | 每房只支援 2 人；第三人加入會被拒絕。 | 多人需求改成 Phase 2 的 peer ID + mesh 信令；更大規模改用 Phase 5 SFU。 |
| NAT 穿透 | 只設定公開 STUN；嚴格 NAT、企業網路或跨國網路可能無法 P2P 連線。 | 正式環境補上 TURN（例如 coturn），並用 HTTPS 提供頁面。 |
| 信令完整度 | 伺服器只做最小轉發，沒有登入、重連、房間保護或長連線心跳。 | 加入 session / auth、ping-pong 健康檢查、斷線清理與可重入的 join 流程。 |
| 協商順序 | offer / answer / ICE 都是非同步；ICE 可能比 remote description 更早到。 | 前端維持 ICE candidate 佇列，等 `setRemoteDescription` 完成後再補上。 |
| 協商衝突 | 固定第二位加入者發 offer，避開初始 glare，但無法處理雙方同時重新協商。 | 後續功能需導入 Perfect Negotiation、rollback，或使用 `replaceTrack` 減少重新協商。 |

## 下一步可以延伸的方向

- **TURN 伺服器**（如 coturn）：跨網際網路、嚴格 NAT 連不上時的中繼。
- **DataChannel**：在同一條連線上傳文字 / 檔案。
- **Perfect Negotiation**：處理雙方同時 offer 的 glare 衝突。
- **多人（SFU）**：3 人以上改用 mediasoup / Janus / LiveKit 等媒體伺服器。
