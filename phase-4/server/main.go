package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gorilla/websocket"
)

// newID 用標準庫 crypto/rand 產生連線的唯一 peer id（免額外相依）。
func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// POC：dev 時前端在 5173、後端在 3000（跨來源），先允許任何來源。
	// 正式環境務必收緊成白名單。
	CheckOrigin: func(_ *http.Request) bool { return true },
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	hub := NewHub()
	go hub.Run() // 唯一的 hub goroutine

	mux := http.NewServeMux()

	// WebSocket 信令端點，對應前端的 ws://host/ws（與 Phase 3 vite proxy 一致）。
	// 每條連線開兩個 goroutine（讀/寫），其餘交給 hub。
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("upgrade error:", err)
			return
		}
		client := &Client{
			id:   newID(),
			hub:  hub,
			conn: conn,
			send: make(chan []byte, sendBuffer),
		}
		go client.writePump()
		go client.readPump()
	})

	// 服務 Phase 3 打包後的前端（沿用 Phase 3；正式模式用）。
	// 可用 STATIC_DIR 覆寫；預設指向 phase-3/client/dist。
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = filepath.Join("..", "..", "phase-3", "client", "dist")
	}
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))

	log.Printf("✅ WebRTC POC Phase 4（Go 信令）http://localhost:%s", port)
	log.Printf("   前端沿用 Phase 3：在 phase-3/client 跑 `npm run dev`，vite proxy 已指向 :3000")
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
