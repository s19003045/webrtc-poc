# Phase 4 — Go 信令後端

把 Phase 3 的 Node 信令伺服器用 **Golang** 重寫。**前端完全沿用 Phase 3**（不需任何改動），因為信令協議與 WebSocket 路徑（`/ws`）、預設埠（3000）都保持一致。

- **後端**：Go + [gorilla/websocket](https://github.com/gorilla/websocket)
- **前端**：Phase 3 的 React + TypeScript（原封不動）
- **難度提升點**：用 Go 的併發模型穩定承載大量併發長連線

## 併發架構（這階段的重點）

```
每條連線 = 2 個 goroutine                單一 Hub goroutine
┌─────────────────────────┐            ┌──────────────────────────┐
│ readPump  ──inbound chan─┼───────────▶│                          │
│ writePump ◀──send chan───┼────────────│  Run(): for select {     │
└─────────────────────────┘            │    unregister / inbound  │
┌─────────────────────────┐            │  }                        │
│ readPump  ──inbound chan─┼───────────▶│  rooms map 只由它觸碰     │
│ writePump ◀──send chan───┼────────────│  → 免 mutex               │
└─────────────────────────┘            └──────────────────────────┘
```

- **每條 WebSocket 連線兩個 goroutine**：`readPump`（只讀）、`writePump`（只寫 + 心跳 ping），對應 gorilla 的「一讀者一寫者」限制。
- **唯一的 Hub goroutine** 擁有所有房間狀態（`rooms` map）。所有變更都透過 channel 送進來依序處理，所以 map 永遠只被一個 goroutine 觸碰，**完全不需要 mutex**——這就是 Go 的「share memory by communicating」。
- 連線生命週期、ping/pong 偵測死連線、慢速客戶端的非阻塞送出（佇列滿就斷線）都已處理。

檔案分工：

| 檔案 | 內容 |
|------|------|
| `message.go` | 信令協議的 Go struct（強型別；Data 用 `json.RawMessage` 原樣轉發） |
| `client.go` | `Client` 與 `readPump` / `writePump` 兩個 goroutine |
| `hub.go` | `Hub` 事件迴圈、房間註冊表、join/signal/leave 處理 |
| `main.go` | HTTP/WebSocket 進入點、靜態檔服務 |

## 啟動（開發模式）

需要**兩個終端機**（與 Phase 3 相同，只是後端換成 Go）：

```bash
# 終端機 1：Go 信令伺服器（埠 3000）
cd server
go run .

# 終端機 2：沿用 Phase 3 的前端（埠 5173）
cd ../../phase-3/client
npm run dev
```

開瀏覽器到 `http://localhost:5173`。Phase 3 的 `vite.config.ts` 已把 `/ws` 代理到 `:3000`，所以前端不知道後端從 Node 換成了 Go——這正是重點。

## 啟動（正式模式：Go 直接服務前端）

```bash
cd ../../phase-3/client && npm run build   # 產生 dist
cd ../../phase-4/server && go run .         # 預設服務 ../../phase-3/client/dist
```
直接開 `http://localhost:3000`。可用 `STATIC_DIR` 環境變數覆寫靜態目錄。

## 與 Phase 3 的差異

| 面向 | Phase 3 | Phase 4 |
|------|---------|---------|
| 後端語言 | Node.js + ws | **Go + gorilla/websocket** |
| 併發模型 | 單執行緒事件迴圈 | goroutine（每連線 2 條）+ 單 Hub goroutine |
| 房間狀態 | JS 物件 | Go map，由單一 goroutine 序列化存取（免鎖） |
| 心跳 | 無 | ping/pong 偵測死連線 |
| 前端 | React + TS | **相同**（沿用） |

## 限制、痛點與解法

| 項目 | 限制 / 痛點 | 解決方案 |
|------|-------------|----------|
| 架構上限 | 後端改成 Go 只提升信令承載能力，媒體仍然是 client 之間的 mesh。 | 保持協議相容，將媒體擴展性問題推進到 Phase 5 SFU。 |
| WebSocket 併發 | gorilla/websocket 要求同一連線最多一個 reader 與一個 writer；多 goroutine 直接寫會競態。 | 每條連線拆成 `readPump` / `writePump`，所有寫入都走 client 的 `send` channel。 |
| 房間狀態競態 | 多連線同時 join、signal、leave 時，直接操作 `rooms` map 需要大量鎖。 | 單一 `Hub` goroutine 擁有房間狀態，事件透過 channel 序列化處理，避免 mutex。 |
| 慢速客戶端 | 某個 client 寫入卡住時，可能拖慢整個房間廣播。 | 使用有緩衝的送出佇列；佇列滿代表 client 太慢，主動斷線清理。 |
| 相容性 | 前端沿用 Phase 3，任何協議欄位或 `/ws` 行為不一致都會破壞既有 client。 | `message.go` 強型別化外層欄位，`Data` 用 `json.RawMessage` 原樣轉發，保留路徑與預設埠。 |

## 關於 Redis（刻意延後到 Phase 6）

ROADMAP 原本把 Redis 列在本階段。實作時評估後決定**延後到 Phase 6**：Redis 的價值在「跨節點共享房間狀態」，而那正是 Phase 6（水平擴展、多 SFU 節點）的主題。在單節點階段引入 Redis 只會多一個外部相依、卻沒有實際被用到的場景。

本階段已預留擴展點：房間狀態集中在 `Hub` 一處，未來把 `rooms` 這層換成 Redis-backed 的實作即可，對外介面不變。

## 下一步（Phase 5）

後端從「只轉發信令」進化為 **SFU**（用 Pion 收發/轉發媒體），突破 mesh 的人數上限。
