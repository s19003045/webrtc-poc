# Phase 6 Router（Go）+ React 前端。build context = phase-6（需同時取用 client 與 router）

# ── 1) 建置前端 ──
FROM node:20-alpine AS client
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── 2) 建置 Router ──
FROM golang:1.26-alpine AS gobuild
WORKDIR /src
COPY router/go.mod router/go.sum ./
RUN go mod download
COPY router/ ./
RUN CGO_ENABLED=0 go build -o /router .

# ── 3) 執行 ──
FROM alpine:3.20
WORKDIR /app
COPY --from=gobuild /router /app/router
COPY --from=client /client/dist /app/dist
ENV STATIC_DIR=/app/dist
ENV PORT=8080
EXPOSE 8080
CMD ["/app/router"]
