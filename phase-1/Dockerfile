# Phase 1 — Node 信令 + 靜態頁面（1:1 視訊）
# build context 為 repo 根目錄（見 docker-compose.yml）
FROM node:20-alpine

WORKDIR /app

# 先裝相依（利用 layer 快取：原始碼變動時不必重裝）
COPY phase-1/package*.json ./
RUN npm ci --omit=dev

# 再複製原始碼
COPY phase-1/server.js ./
COPY phase-1/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
