# Phase 5 — Pion SFU（Go）+ React/TS 前端（多階段建置）
# build context 為 repo 根目錄（見 docker-compose.yml）

# ── 1) 建置 React 前端 → dist ──
FROM node:20-alpine AS client
WORKDIR /client
COPY phase-5/client/package*.json ./
RUN npm ci
COPY phase-5/client/ ./
RUN npm run build

# ── 2) 建置 Go SFU（靜態連結）──
FROM golang:1.26-alpine AS gobuild
WORKDIR /src
COPY phase-5/server/go.mod phase-5/server/go.sum ./
RUN go mod download
COPY phase-5/server/ ./
RUN CGO_ENABLED=0 go build -o /server .

# ── 3) 極簡執行環境 ──
FROM alpine:3.20
WORKDIR /app
COPY --from=gobuild /server /app/server
COPY --from=client /client/dist /app/dist
ENV STATIC_DIR=/app/dist
ENV PORT=3000
# UDP_PORT / NAT1TO1_IP 由 docker-compose 注入（SFU 媒體用）
EXPOSE 3000
EXPOSE 50000/udp
CMD ["/app/server"]
