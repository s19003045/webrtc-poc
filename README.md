# WebRTC POC Roadmap Project

這個專案把一個視訊系統從最小可行的 1:1 WebRTC POC，逐步演進到可做多房、多節點擴展的 SFU 叢集。重點不是一次堆滿功能，而是把每個架構轉折拆成可單獨理解、可單獨執行的 phase。

最終目標技術棧：

- 前端：React + TypeScript
- 後端：Go
- 媒體架構：SFU
- 規模化：多節點路由 + Redis + 觀測與壓測

## 專案結構

| 資料夾 | 主題 | 核心技術 |
|--------|------|----------|
| `phase-1/` | 1:1 P2P 基礎 | Node + Express + `ws` + 原生 WebRTC |
| `phase-1.1/` | Firestore 信令替代版 | Firestore + Realtime Database presence |
| `phase-2/` | 多人 mesh + 聊天 + 螢幕分享 | Node + 原生前端 |
| `phase-3/` | 前端現代化 | React + TypeScript + Vite |
| `phase-4/` | Go 信令後端 | Go + gorilla/websocket |
| `phase-5/` | 單節點 SFU | Go + Pion + React |
| `phase-6/` | 多節點與營運 | Router + 多 SFU + Redis + JWT + Prometheus |

另外：

- `ROADMAP.md`：整體演進脈絡與 phase 摘要
- `DOCKER.md`：Phase 1~5 的 Docker Compose 使用方式
- `docker-compose.yml`：根目錄的多 phase container 啟動設定

## 為什麼要分 phase

這個專案的主線很明確：

1. 先用 mesh 把 WebRTC 核心流程吃透：`getUserMedia`、SDP、ICE、信令。
2. 再把前後端技術棧換成比較接近正式系統的 React + TypeScript + Go。
3. 最後從 mesh 改成 SFU，解決人數擴展問題，並在 Phase 6 補上路由、共享狀態、認證與觀測。

關鍵原因是：mesh 在人數一多時一定會失效。N 人房間裡，每個人都要維持 N−1 條連線、上傳 N−1 份自己的媒體；真正可擴展的方向只能是 SFU。

## 快速開始

### Phase 1

```bash
cd phase-1
npm install
npm start
```

開 `http://localhost:3000`，用兩個分頁輸入相同房間名稱測試。

### Phase 1.1

```bash
cd phase-1.1
cp public/firebase-config.example.js public/firebase-config.js
npm start
```

這個 phase 不需要自架 signaling server，但需要先在 Firebase 啟用：

- Firestore Database
- Realtime Database

### Phase 2

```bash
cd phase-2
npm install
npm start
```

適合開 3 個以上分頁測 mesh 多人通話、聊天與螢幕分享。

### Phase 3

```bash
cd phase-3/server
npm install
npm start
```

另一個終端機：

```bash
cd phase-3/client
npm install
npm run dev
```

### Phase 4

```bash
cd phase-4/server
go run .
```

前端沿用 `phase-3/client`。

### Phase 5

```bash
cd phase-5/server
go run .
```

另一個終端機：

```bash
cd phase-5/client
npm install
npm run dev
```

### Phase 6

```bash
cd phase-6
docker compose up -d --build
```

這一階段透過 Router 將房間分散到多個 SFU 節點，並用 Redis 做共享狀態。

## 測試與驗證

- `phase-5/server`: `go test -v`
- `phase-6/loadtest`: 用真實 Pion client 做多房壓測
- 前端 phase 主要靠多分頁手動驗證：加入、離開、重連、螢幕分享、房間切換

如果你想驗證 Docker 化版本，先看 `DOCKER.md`；如果你想理解整個架構為什麼這樣演進，先看 `ROADMAP.md`。

## 建議閱讀順序

如果你第一次看這個 repo，建議順序是：

1. `ROADMAP.md`
2. `phase-1/README.md`
3. `phase-2/README.md`
4. `phase-3/README.md`
5. `phase-4/README.md`
6. `phase-5/README.md`
7. `phase-6/README.md`

這樣會最容易理解每一個技術決策背後的限制、痛點與解法。
