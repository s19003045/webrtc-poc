# Phase 2 — Node 信令 + 靜態頁面（多人 mesh + 聊天 + 螢幕分享）
# build context 為 repo 根目錄（見 docker-compose.yml）
FROM node:20-alpine

WORKDIR /app

COPY phase-2/package*.json ./
RUN npm ci --omit=dev

COPY phase-2/server.js ./
COPY phase-2/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
