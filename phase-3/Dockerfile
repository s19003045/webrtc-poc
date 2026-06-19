# Phase 3 — React/TS 前端 + Node 信令（多階段建置）
# build context 為 repo 根目錄（見 docker-compose.yml）

# ── 1) 建置 React 前端 → dist ──
FROM node:20-alpine AS client
WORKDIR /client
COPY phase-3/client/package*.json ./
RUN npm ci
COPY phase-3/client/ ./
RUN npm run build

# ── 2) Node 信令伺服器，服務上一步打包好的前端 ──
FROM node:20-alpine
WORKDIR /app/server
COPY phase-3/server/package*.json ./
RUN npm ci --omit=dev
COPY phase-3/server/server.js ./
# server.js 以 path.join(__dirname, '..', 'client', 'dist') 找前端，
# __dirname = /app/server，故 dist 放在 /app/client/dist
COPY --from=client /client/dist /app/client/dist

EXPOSE 3000
CMD ["node", "server.js"]
