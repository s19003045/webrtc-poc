# WebRTC 視訊系統演進藍圖（Roadmap）

從教學用 POC，分階段演進為可承載**數千人同時上線、多會議空間**的正式視訊系統。

**最終目標技術棧**：前端 React.js + TypeScript，後端 Golang，SFU 架構，可水平擴展。

---

## 核心觀念：為什麼一定要分這幾個 phase

達成「數千人」的關鍵不是把現有架構放大，而是**換架構**：

- **Mesh（全網狀 P2P）會在人數一多就爆掉**。N 人房間裡，每個人要維持 N−1 條連線、把自己的影像上傳 N−1 次。N=5 就已經很吃力，數千人完全不可能。
- 要規模化，必須改用 **SFU（Selective Forwarding Unit）**：每個人只上傳「一路」影像到伺服器，由伺服器轉發給房內其他人。上傳頻寬從 O(N) 降為 O(1)，伺服器才有辦法靠水平擴展承載大量使用者。

所以路線是：**先用 mesh 把 WebRTC 觀念吃透（Phase 1–2）→ 把技術棧換成目標的 React/TS + Go（Phase 3–4）→ 改成 SFU 架構突破規模上限（Phase 5）→ 規模化與營運（Phase 6）。**

---

## Phase 1 — 1:1 P2P 基礎 ✅（已完成）

> 資料夾：`phase-1/`　技術：Node.js + Express + ws + 原生前端

- 1 對 1 視訊通話，full-mesh 的最小情形
- 掌握核心觀念：`getUserMedia`、`RTCPeerConnection`、SDP offer/answer、ICE/STUN、信令伺服器
- **產出**：本機開兩分頁即可互打的視訊 POC

---

## Phase 1.1 — Firestore 信令替代版 ✅（已完成）

> 資料夾：`phase-1.1/`　技術：Cloud Firestore + 原生前端

- 保留 Phase 1 的 1:1 P2P WebRTC 流程
- 用 Firestore 文件與子集合取代自架 WebSocket signaling server
- 交換資料仍只有 SDP offer/answer 與 ICE candidate，影音不經過 Firestore
- **產出**：不維護 signaling server 也能完成初始交握的教學版 POC

---

## Phase 2 — 多人 Mesh + 體驗強化 ✅（已完成）

> 資料夾：`phase-2/`　技術：沿用 Node + 原生前端（刻意先不換棧，專注在 WebRTC 本身）
> 難度提升點：同時管理「多條」PeerConnection

- 3~5 人 full-mesh 通話：一個人對房內每個其他人各開一條 `RTCPeerConnection`
- **DataChannel** 文字聊天（在同一條連線上傳資料，不碰媒體）
- 控制項：靜音、關鏡頭、**螢幕分享**（`getDisplayMedia`）
- 房間成員列表，加入/離開即時更新
- 加入 **TURN 伺服器**（coturn），讓跨網路 / 嚴格 NAT 也能連
- **重點體會**：親身感受 mesh 的 N² 連線成本，理解為什麼後面非換 SFU 不可

---

## Phase 3 — 前端現代化（React + TypeScript）✅（已完成）

> 資料夾：`phase-3/`　技術：React + TypeScript + Vite，後端沿用 Phase 2
> 難度提升點：把命令式的 WebRTC 流程包進 React 的宣告式狀態模型

- 用 React + TS + Vite 重寫前端，元件化（`VideoGrid` / `Controls` / `ChatPanel` / `ParticipantList`）
- 把 WebRTC 邏輯封裝成自訂 hooks（`useLocalMedia`、`usePeerConnection`、`useSignaling`）
- 用 TypeScript 型別定義整套信令協議（offer / answer / candidate / join / leave）
- **產出**：目標前端棧定案，可維護的元件化架構

---

## Phase 4 — Go 信令後端 ✅（已完成）

> 資料夾：`phase-4/`　技術：Golang（gorilla/websocket），前端沿用 Phase 3
> 難度提升點：用 Go 的併發模型處理大量長連線

- 用 Go 重寫信令伺服器：每條連線兩個 goroutine（讀/寫）、單一 Hub goroutine 用 channel 序列化房間狀態（免鎖）
- 房間註冊表（room registry）與成員生命週期管理、ping/pong 心跳
- 結構化、強型別的信令協議
- **Redis 延後到 Phase 6**：跨節點共享狀態是多節點擴展才需要的，單節點階段先預留擴展點即可
- **產出**：目標後端棧定案，能穩定承載大量併發長連線

---

## Phase 5 — SFU 架構（核心轉折，用 Pion）✅（已完成）

> 資料夾：`phase-5/`　技術：Go + [pion/webrtc](https://github.com/pion/webrtc)
> 難度提升點：伺服器本身要參與 WebRTC，收發與轉發媒體

- 用 Pion 在 Go 建一個最小 SFU：每個 client 上傳一路 → 伺服器轉發給房內其他人
- 處理 track 的訂閱與轉發、參與者進出時的重新協商
- 入門 **Simulcast**（同一路送多種畫質，讓弱網者收低畫質）
- **這是突破人數上限的關鍵一步**：單房可容納遠多於 mesh 的參與者
- **決策點**：學習階段自建 SFU 把原理吃透；正式追求數千人規模時，可評估直接採用 **LiveKit**（Go、基於 Pion、專為規模化設計），用自建的理解去駕馭它

---

## Phase 6 — 規模化與營運 ✅（已完成）

> 資料夾：`phase-6/`　技術：多 SFU 節點 + Router + Redis + JWT + Prometheus + 壓測
> 目標：真正達成「數千人同時上線、多會議空間」

- 水平擴展：多個 SFU 節點 + 房間路由 / 負載平衡（同房使用者導到同節點）
- 分散式房間狀態（Redis），跨節點協調
- 認證授權：入會用 JWT token
- TURN 叢集
- 可觀測性：Prometheus + Grafana，監控連線品質、頻寬、丟包
- 壓力測試到數千併發；頻寬自適應（simulcast/SVC）
- 可選：雲端錄影、轉播

---

## 一覽表

| Phase | 主題 | 前端 | 後端 | 架構 | 規模 |
|-------|------|------|------|------|------|
| 1 ✅ | 1:1 基礎 | 原生 JS | Node | Mesh | 2 人 |
| 2 ✅ | 多人 + 強化 | 原生 JS | Node | Mesh | 3~6 人 |
| 3 ✅ | 前端現代化 | **React+TS** | Node | Mesh | 3~6 人 |
| 4 ✅ | Go 後端 | React+TS | **Go** | Mesh | 數十條連線 |
| 5 ✅ | SFU 轉折 | React+TS | Go + Pion | **SFU** | 單房數十~上百 |
| 6 ✅ | 規模化 | React+TS | Go 多節點 + Router | SFU 叢集 + Redis | **數千人 / 多房** |
