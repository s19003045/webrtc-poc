# Phase 6 — 規模化與營運（多節點 SFU 叢集）

目標：從「單節點 SFU」走向「**數千人同時上線、多會議空間**」。核心是**水平擴展**。

關鍵觀念：**SFU 是有狀態的**——一個房間的媒體在某個節點上。要擴展不是把單節點放大，而是**用多個節點 + 房間親和性路由**：把同一個房間的人導到同一個 SFU 節點，很多房間分散到很多節點。只要單房人數有上限，房間數可以靠加節點無限擴展。

## 架構

```
                      ┌──────────────┐
  瀏覽器 ─1.路由查詢─▶│   Router     │  GET /api/route?room=X
         ◀─url+token─│ (Go + Redis) │  → {url: 該房的 SFU 節點, token: JWT}
                      └──────┬───────┘
                             │            ┌─────────┐
                  2.連到指定節點+JWT        │  Redis  │ room:{id}→node、node:{id}→{addr,load}
                             ▼            └────┬────┘
  瀏覽器 ─ws信令/UDP媒體─▶ SFU node-1 ─註冊/回報負載─┤
  瀏覽器 ─ws信令/UDP媒體─▶ SFU node-2 ─註冊/回報負載─┘
                             │
                        /metrics → Prometheus
```

| 元件 | 資料夾 | 職責 |
|------|--------|------|
| **Router** | `router/` | 用 Redis 做房間親和性路由（既有房間→原節點；新房間→負載最低、tie-break 用 hash 分散）、簽發入會 JWT、服務前端 |
| **SFU 節點** | `sfu/` | Phase 5 SFU + 向 Redis 註冊/心跳/回報負載 + 驗 JWT + Prometheus `/metrics`。可跑多個 |
| **Redis** | — | 叢集共享狀態：`node:{id}→{addr,load}`（EX 15）、`room:{id}→node`（EX 60，節點刷新） |
| **前端** | `client/` | Phase 5 前端 + 先 `GET /api/route` 再連到指派的節點（帶 token） |
| **壓測** | `loadtest/` | 用真實 Pion client 模擬大量使用者，驗證分散與轉發 |
| **Prometheus** | — | 抓各節點 `/metrics`（房間數 / 連線數 / track 數） |

## 啟動

```bash
docker compose -f docker-compose.yml up -d --build
```

| 服務 | 網址 |
|------|------|
| 前端（經 Router） | http://localhost:8086 |
| SFU 節點 1 / 2 | ws://localhost:8101/ws（媒體 UDP 7001）、:8102（7002） |
| Prometheus | http://localhost:9090 |

開多個分頁、相同房間名稱加入——畫面上方會顯示這個房間被指派到哪個節點。不同房間會分散到不同節點。

## 壓力測試

```bash
cd loadtest
ROUTER_URL=http://localhost:8086 ROOMS=6 CLIENTS_PER_ROOM=4 go run .
```

會啟動 `ROOMS × CLIENTS_PER_ROOM` 個真實 Pion client，經 Router 路由、上傳並驗證每人都收到同房其他人的 track，最後印出「房間在各節點的分布」。**實測 6 房 × 4 人 = 24 client 全數收齊、房間分散到兩個節點。**

## 驗證（已實測通過）

- **多節點轉發**：壓測 24/24 client 收齊他人 track。
- **房間親和性 + 分散**：同房永遠同節點；多房分散到 sfu-1 / sfu-2。
- **JWT 強制**：直連節點但不帶 token → 被拒（`unauthorized`）。
- **可觀測性**：`curl localhost:8101/metrics` 有 `sfu_rooms/peers/tracks`；Prometheus 兩個節點 target 皆 `up`。

## 決策紀錄

| 階段 | 痛點 | 決策 / 解法 |
|------|------|------------|
| 怎麼擴展有狀態的 SFU | 單房媒體綁在一個節點，無法像無狀態服務隨意打散。 | 不追求「單房跨節點」，改用**房間親和性路由**：同房導同節點、多房分散到多節點。單房有上限、房間數靠加節點擴展。 |
| 路由要不要 proxy 媒體 | Router 若代理 WS/媒體會成為瓶頸與單點。 | Router 只回「該連哪個節點」，client **直接**連 SFU 節點；Router 不碰媒體。 |
| 共享狀態放哪 | 多節點要協調 room→node、節點存活。 | 用 Redis：`node:*` 帶 TTL 當存活心跳、`room:*` 帶 TTL 由節點刷新（空房自動過期、自我修復）。 |
| 冷啟動全擠同一節點 | 「負載最低」在大家負載都 0 時會把新房間全導到同一節點（負載每 5 秒才更新）。 | tie-break 改用 `hash(room+node)`：負載相同就按房名分散，負載有差仍是最低負載優先。 |
| 入會授權 | 任何人都能連節點加入任意房間。 | Router 簽發夾帶 room 的短效 JWT，節點驗章 + 比對 room；`JWT_SECRET` 未設則跳過（dev）。 |
| 怎麼驗證規模 | 沒有瀏覽器農場可測多人多房。 | 用 Pion 寫壓測工具，真實建立 WebRTC 連線經 Router 路由，量測轉發成功率與節點分布。 |

## 限制、痛點與解法

| 項目 | 限制 / 痛點 | 解決方案 |
|------|-------------|----------|
| 單房上限 | 房間親和性下，**單一房間**仍受單節點頻寬/CPU 限制（下載總量 O(N²)）。 | 加 simulcast/SVC 做頻寬自適應；超大房需「SFU 串接（cascading）」讓多節點接力轉發——本階段未實作。 |
| 負載資訊延遲 | 節點負載每 5 秒才回報，瞬間大量新房間的分配不夠即時。 | hash tie-break 緩解；更精準可在 Router 指派時樂觀累加 pending load，或改用一致性雜湊。 |
| 媒體 NAT | 每個節點都要對外發布固定 UDP 埠 + `NAT1TO1_IP`；跨機要填區網/公網 IP。 | 已用 `UDP_PORT` + `NAT1TO1_IP`；正式環境配合 TURN 叢集處理嚴格 NAT。 |
| TURN | 嚴格 NAT / 企業防火牆下，純 STUN 仍可能連不上。 | 正式部署需自架 coturn 叢集（本階段未含）。 |
| 觀測深度 | 目前只有節點層級的房間/連線/track 數，沒有每連線的丟包、RTT、頻寬。 | 接 Pion 的 stats、輸出更細的 per-peer 指標，並用 Grafana 視覺化（本階段只到 Prometheus 抓取）。 |
| 安全與營運 | JWT secret 寫死於 compose、無房間 ACL、無錄影、無自動擴縮。 | 正式環境用 secret 管理、房間權限、雲端錄影、依負載自動增減節點。 |
| 自建 vs 採用 | 自建叢集要長期維護路由、擴縮、容錯、媒體優化。 | **決策點**：原理已吃透；真要上數千人正式服務，建議直接採用 [LiveKit](https://livekit.io)（Go、基於 Pion、內建多節點/錄影/SDK）。 |

## 與 Phase 5 的差異

| 面向 | Phase 5 | Phase 6 |
|------|---------|---------|
| 節點數 | 單一 SFU | 多個 SFU 節點 + Router |
| 房間落點 | 都在同一程序 | Redis 房間親和性路由，分散到多節點 |
| 共享狀態 | 程序內記憶體 | Redis（節點註冊 + room→node） |
| 認證 | 無 | 入會 JWT |
| 觀測 | 無 | Prometheus `/metrics` |
| 規模 | 單房數十~上百 | **多房分散到多節點 → 數千人 / 多會議空間** |
