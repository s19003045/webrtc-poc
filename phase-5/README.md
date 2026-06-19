# Phase 5 — SFU 架構（Go + Pion）

整個專案的**關鍵轉折**：後端從「只轉發信令」進化為 **SFU（Selective Forwarding Unit）**，伺服器本身參與 WebRTC、收發與轉發媒體。這是突破 mesh 人數上限的關鍵一步。

- **後端**：Go + [pion/webrtc v4](https://github.com/pion/webrtc)（SFU）
- **前端**：React + TypeScript（為 SFU 重寫的 client 引擎）

## Mesh vs SFU：差在哪

```
        Mesh（Phase 1~4）                    SFU（Phase 5）
   每人對每人各開一條連線               每人只跟伺服器開「一條」連線
   每人上傳 N-1 份自己的影像            每人只上傳「一份」到伺服器
   上傳頻寬 O(N) → 數千人不可能          上傳頻寬 O(1) → 可水平擴展

     A ─── B                                A      B
     │ ╳ │           vs                     └──┐┌──┘
     C ─── D                                  [SFU] 轉發
                                            ┌──┘└──┐
                                              C      D
```

關鍵差異：**伺服器這次「真的參與 WebRTC」**——它終結每個人的 PeerConnection、收 RTP、再轉發給房內其他人。協商模型也翻轉成「**伺服器當 offerer**」，client 只負責回 answer。

## 伺服器核心（`server/sfu.go`）

以 Pion 官方 `sfu-ws` 範例為基礎，加上多房間支援：

- 每個 client 上傳的 track → 建成 `TrackLocalStaticRTP` 登記在 `Room.trackLocals`，並把收到的 RTP 持續複製過去。
- `signalPeerConnections()`：SFU 的核心。確保每個 peer 都在轉發「房內所有人的、但還沒發給它、且非它自己」的 track，然後對它重新協商（伺服器發 offer）。
- 用 `existing`（senders + receivers 的 track ID）避免把某人自己的影像轉回給他自己。
- 週期性 PLI（keyframe 請求），讓晚加入者盡快看到畫面。
- 多房間：`SFU.rooms` 以房間名稱區隔不同會議空間。

## 前端核心（`client/src/lib/SfuClient.ts`）

比 mesh 的 `PeerManager` 簡單很多——只跟伺服器開一條 PC，收到 offer 就回 answer：

- `addTrack` 上傳本機影音（只有一路）。
- `ontrack` 收伺服器轉發下來的他人影音，依 stream 分組顯示。
- 收到 `offer` → `setRemote` → `createAnswer` → 送 `answer`；收 `candidate` → `addIceCandidate`。

## 啟動（開發模式）

需要兩個終端機：

```bash
# 終端機 1：Pion SFU（埠 3000）
cd server
go run .

# 終端機 2：React 前端（埠 5173）
cd ../client
npm install
npm run dev
```

開 `http://localhost:5173`，**多個分頁、相同房間名稱**加入即可。畫面上方會顯示「我上傳 1 路、從 SFU 下載 N 路」，直觀呈現 SFU 的精神。

## 啟動（正式模式：Go 直接服務前端）

```bash
cd ../client && npm run build
cd ../server && go run .          # 預設服務 ../client/dist
```
開 `http://localhost:3000`。

## 房間人數

程式**沒有設硬上限**。真正的上限是伺服器頻寬/CPU：單房 N 人時每個人要下載 N−1 路，全房總下載量 O(N²)，這個最小 SFU 實務上單房約數十～上百人。

> 早期版本因為協商邏輯（沿用 Pion 範例）有缺陷，人一多就會讓「最後加入者」被前面忙碌的 peer 餓死、拿到 0 條 track（俗稱「第 6 人只看到自己」）。已改寫 `signalPeerConnections` → `syncPeer`/`onAnswer`：跳過正在協商中的 peer（而非整個迴圈重來）、且只在 track 真的變動時才重新協商。見 `TestSFUManyClients` 回歸測試。

## 驗證

- 整合測試：`cd server && go test -v`
  - `TestSFUForwardsMedia`：兩個真實 Pion client，驗證雙方都收到對方經 SFU 轉發的 track（證明真的在轉發媒體，不只信令）。
  - `TestSFUManyClients`：6 個 client 進同房，驗證「每個人」都收到其他 5 人的 track（第 6 人 bug 的回歸測試）。
  - `TestSFUExternalForwardsMedia`：對外部/容器化 SFU 跑同樣驗證，可用 `SFU_WS_URL` 與 `SFU_CLIENTS` 指定，例如：
    `SFU_WS_URL=ws://localhost:8085/ws SFU_CLIENTS=6 go test -run TestSFUExternalForwardsMedia -v`
- 瀏覽器手動：開 3+ 個分頁同房，確認彼此看得到畫面、靜音/關鏡頭/螢幕分享/spotlight 正常。

## Docker（已納入 compose）

前面 1~4 階段媒體是 P2P，伺服器只做信令，容器開一個 TCP 埠即可。**SFU 不同**：伺服器要與每個 client 交換 RTP(UDP)，所以需要額外設定才能在 Docker 內運作：

- **固定 UDP 埠**（`UDP_PORT`）：讓 Pion 的 ICE 綁在固定 UDP 埠（見 `api.go` 的 UDP Mux），Docker 才能對外發布這個媒體埠。
- **對外發布 IP**（`NAT1TO1_IP`）：告訴 Pion 對外用「可達的 IP」當候選（取代容器內 IP）。同機瀏覽器用 `127.0.0.1`；別台機器連則改成本機區網 IP。

根目錄的 `docker-compose.yml` 已含 `phase-5`（HTTP 8085 + UDP 50000）。啟動後開 http://localhost:8085。

驗證 Docker 版媒體確實轉發（已實測通過）：

```bash
SFU_WS_URL=ws://localhost:8085/ws go test -run TestSFUExternalForwardsMedia -v
```
用兩個真實 Pion client 連到容器化 SFU，確認雙方都收到對方經容器轉發的 track。

## 下一步（Phase 6）

水平擴展到數千人、多節點：多 SFU 節點 + 房間路由、Redis 共享狀態、TURN 叢集、監控與壓測。
**決策點**：學習階段自建 SFU 已把原理吃透；正式追求數千人規模時，可評估直接採用 [LiveKit](https://livekit.io)（Go、基於 Pion、為規模化而生）。
