# Phase 3 — 前端現代化（React + TypeScript + Vite）

把 Phase 2 的原生前端重寫為 **React + TypeScript**，後端**沿用 Phase 2 的多人 mesh 信令協議**。功能不變（多人視訊、聊天、靜音/關鏡頭、螢幕分享、spotlight 放大），重點是架構升級。

## 架構：命令式引擎 + 宣告式 UI

WebRTC API 是命令式、充滿副作用的；React 是宣告式的。硬把 `RTCPeerConnection` 塞進元件會很痛。本階段的分層：

```
┌─────────────────────────────────────────────┐
│ React 元件（宣告式）                          │
│  App / VideoGrid / Controls / ChatPanel ...   │
└───────────────┬───────────────────────────────┘
                │ hooks 訂閱狀態
┌───────────────▼───────────────────────────────┐
│ hooks：useLocalMedia / useRoom                 │
│  把 callbacks → useState，觸發重新渲染          │
└───────────────┬───────────────────────────────┘
                │ 包裝
┌───────────────▼───────────────────────────────┐
│ lib/PeerManager.ts（命令式、框架無關）          │
│  RTCPeerConnection、信令、DataChannel、多連線   │
└────────────────────────────────────────────────┘
```

- **`lib/PeerManager.ts`**：所有 WebRTC + 信令副作用都封裝在這個純 TS class（等於 Phase 2 `client.js` 的型別化版）。可獨立測試、與框架無關。
- **`hooks/useRoom.ts`**：把 PeerManager 的 callbacks 轉成 React state。
- **`hooks/useLocalMedia.ts`**：鏡頭/麥克風取得與開關。
- **`types.ts`**：整套信令協議的 TypeScript 型別。
- **`components/`**：`VideoGrid`、`VideoTile`、`Controls`、`ParticipantList`、`ChatPanel`。

## 啟動（開發模式）

需要**兩個終端機**：

```bash
# 終端機 1：信令伺服器（埠 3000）
cd server
npm install
npm start

# 終端機 2：前端 Vite dev server（埠 5173）
cd client
npm install
npm run dev
```

開瀏覽器到 Vite 顯示的網址（預設 `http://localhost:5173`）。Vite 會把 `/ws` 代理到信令伺服器（見 `vite.config.ts`），所以前端用同源 `ws://localhost:5173/ws` 即可連上。

開多個分頁、相同房間名稱加入即可多人通話。

## 建置（正式模式）

```bash
cd client && npm run build      # 產生 client/dist（tsc 型別檢查 + vite 打包）
cd ../server && npm start       # 由信令伺服器直接服務 dist
```
此時直接開 `http://localhost:3000`。

## 與 Phase 2 的差異

| 面向 | Phase 2 | Phase 3 |
|------|---------|---------|
| 前端 | 原生 HTML/JS | React + TypeScript + Vite |
| WebRTC 邏輯 | `client.js`（命令式散落） | `PeerManager` class（封裝）+ hooks |
| 型別 | 無 | 信令協議與領域型別全面 TypeScript 化 |
| UI | 手動 DOM 操作 | 元件化、狀態驅動渲染 |
| 後端 | Node + ws | **相同**（沿用） |

## 限制、痛點與解法

| 項目 | 限制 / 痛點 | 解決方案 |
|------|-------------|----------|
| 架構上限 | 前端現代化後，底層仍是 Phase 2 mesh；人數與頻寬限制沒有消失。 | 保留同一套功能作為對照；擴展性問題留到 Phase 5 用 SFU 解決。 |
| React 副作用 | `RTCPeerConnection`、WebSocket、MediaStream 都是命令式物件，直接放進 component 會造成重渲染與清理困難。 | 用 `PeerManager` 封裝副作用，hooks 只訂閱狀態變化，元件維持宣告式 UI。 |
| 型別邊界 | 信令訊息是 JSON，容易出現 `type` 寫錯、payload 缺欄位或資料形狀不一致。 | 在 `types.ts` 定義協議型別，讓 `PeerManager` 與 hooks 共用同一套 TypeScript contract。 |
| 開發流程 | 前後端拆成兩個 dev server，WebSocket URL 與正式模式路徑容易不一致。 | Vite 用 `/ws` proxy 到 `:3000`；正式模式由 Node server 服務 `client/dist`。 |
| 資源生命週期 | React unmount、離房、關分頁都可能留下未停止的 tracks 或未關閉的 peer connection。 | 在 hooks 與 `PeerManager.leave()` 中集中停止 tracks、關閉 PC / DataChannel、重設狀態。 |

## 下一步（Phase 4）

後端改用 **Golang** 重寫信令伺服器，前端維持本階段成果。
