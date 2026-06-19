# Phase 4 — Go 信令後端 + 沿用 Phase 3 前端（多階段建置）
# build context 為 repo 根目錄（見 docker-compose.yml）

# ── 1) 建置 Phase 3 的 React 前端 → dist ──
FROM node:20-alpine AS client
WORKDIR /client
COPY phase-3/client/package*.json ./
RUN npm ci
COPY phase-3/client/ ./
RUN npm run build

# ── 2) 建置 Go 信令伺服器（靜態連結，免 CGO）──
FROM golang:1.26-alpine AS gobuild
WORKDIR /src
COPY phase-4/server/go.mod phase-4/server/go.sum ./
RUN go mod download
COPY phase-4/server/ ./
RUN CGO_ENABLED=0 go build -o /server .

# ── 3) 極簡執行環境 ──
FROM alpine:3.20
WORKDIR /app
COPY --from=gobuild /server /app/server
COPY --from=client /client/dist /app/dist
# Go 伺服器用 STATIC_DIR 找前端（覆寫預設的相對路徑）
ENV STATIC_DIR=/app/dist
ENV PORT=3000
EXPOSE 3000
CMD ["/app/server"]
