# Phase 2 — 多人 Mesh 視訊 + 聊天 + 螢幕分享

在 Phase 1（1:1）的基礎上，擴展為 **3~6 人的 full-mesh 多人通話**，並加上 DataChannel 文字聊天、靜音/關鏡頭、螢幕分享、成員列表。

- **架構**：full-mesh P2P（每個人對其他每個人各開一條連線）
- **技術棧**：Node.js + Express + `ws` + 原生前端（與 Phase 1 相同，刻意不換棧，專注在「多連線管理」）

## 啟動

```bash
npm install
npm start
```

開 `http://localhost:3000`。

## 測試方式

開 **3 個以上分頁**，各自輸入**相同房間名稱**（預設 `test`）→ 按「加入通話」→ 允許攝影機。彼此會出現多格畫面，可：
- 文字聊天（透過 DataChannel，不經伺服器）
- 靜音 / 關鏡頭 / 分享螢幕
- 關掉某分頁，其視訊格會從其他人畫面消失

> ⚠️ `getUserMedia` / `getDisplayMedia` 只在 `https` 或 `localhost` 可用。

## 與 Phase 1 的關鍵差異

| 面向 | Phase 1（1:1） | Phase 2（多人 mesh） |
|------|----------------|----------------------|
| 連線數 | 固定 1 條 | 每人維持 N−1 條，用 `Map<peerId, pc>` 管理 |
| 信令 | 轉給「另一個人」 | 每連線有唯一 **peer ID**，訊息帶 `to` 點對點轉發 |
| 誰發 offer | 規定誰是 caller | **後加入者**對每個既有成員發 offer（無 glare） |
| ICE 排隊 | 單一佇列 | 每個 peer 各一個佇列 |
| 視訊格 | 固定 2 格 | 依成員動態增減 |
| 額外功能 | 無 | 聊天、靜音、關鏡頭、螢幕分享（`replaceTrack`） |

## 重點體會：mesh 的 N² 成本

側欄會顯示「你目前維持的連線數」。房間 N 人時，**每個 client 維持 N−1 條連線、上傳 N−1 份自己的影像**，整個房間共有 N×(N−1)/2 條連線。

- 5 人 → 每人 4 條，全房 10 條
- 10 人 → 每人 9 條，上傳頻寬約是 1:1 的 9 倍

這就是 mesh 無法擴展到數千人的根本原因，也是後續 **Phase 5 改用 SFU** 的動機：改成每人只上傳「一路」到伺服器轉發。

## TURN（跨網路時才需要）

本機 / 區網用 STUN 即可。要跨網際網路、遇到嚴格 NAT 時，在 `public/client.js` 的 `rtcConfig.iceServers` 取消 TURN 範例的註解，並填入自架 [coturn](https://github.com/coturn/coturn) 的位址與帳密。本階段不含 coturn 的架設。
