# Phase 6 SFU 節點（Go + Pion）。build context = phase-6/sfu
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -o /sfu .

FROM alpine:3.20
COPY --from=build /sfu /sfu
EXPOSE 3000
# UDP 媒體埠由 compose 以 UDP_PORT 指定並發布
CMD ["/sfu"]
