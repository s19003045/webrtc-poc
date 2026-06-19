# 用 Docker Compose 跑 Phase 1~4

把四個階段各自包成容器，一次全部起來，分別對應不同的 host 埠。

| 服務 | 內容 | 網址 |
|------|------|------|
| phase-1 | Node 信令 + 1:1 視訊 | http://localhost:8081 |
| phase-2 | Node 信令 + 多人 mesh + 聊天 + 螢幕分享 | http://localhost:8082 |
| phase-3 | React/TS 前端 + Node 信令 | http://localhost:8083 |
| phase-4 | React/TS 前端 + **Go** 信令 | http://localhost:8084 |

## 使用

```bash
# 建置並啟動全部（背景執行）
docker compose up -d --build

# 查看狀態 / healthcheck
docker compose ps

# 看某個服務的日誌
docker compose logs -f phase-4

# 只跑其中一個
docker compose up -d --build phase-2

# 全部關閉並移除容器
docker compose down
```

啟動後用瀏覽器開對應網址，**開多個分頁、輸入相同房間名稱**即可測試（Phase 1 為 1:1，其餘多人）。

## 說明

- 四個容器內部都聽 `3000`，對外映射到 `8081`~`8084`，彼此不衝突。
- `phase-3`、`phase-4` 用**多階段建置**：先用 node 把 React 前端打包成 `dist`，再交給各自的後端（Node / Go）服務。Phase 4 的前端沿用 Phase 3。
- build context 是 repo 根目錄（這樣 Phase 4 才能同時取用 `phase-3/client` 與 `phase-4/server`），並用 `.dockerignore` 排除 `node_modules`、`dist`、`.git`。
- 用 `http://localhost:...` 存取時瀏覽器視為安全來源，`getUserMedia` 可正常取得攝影機。

> ⚠️ 若要從**別台機器**用區網 IP（非 localhost）連，瀏覽器會因非 HTTPS 擋掉攝影機。屆時需在前面加一層 TLS 反向代理（如 Caddy/Traefik/Nginx），這超出本 POC 範圍。
