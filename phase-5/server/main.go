package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gorilla/websocket"
)

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func short(id string) string {
	if len(id) > 6 {
		return id[:6]
	}
	return id
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(_ *http.Request) bool { return true }, // POC：允許任何來源
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	api, err := buildAPI()
	if err != nil {
		log.Fatal("build webrtc api:", err)
	}
	sfu := newSFU(api)

	// 週期性對所有上傳者要 keyframe，讓晚加入的訂閱者盡快看到畫面
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for range t.C {
			sfu.dispatchKeyFrames()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("upgrade:", err)
			return
		}
		conn := &threadSafeWriter{Conn: c}
		defer conn.Close() //nolint:errcheck
		sfu.handleWS(conn)
	})

	// 服務 Phase 5 自己的 React 前端（dev 用 vite proxy；正式用打包後的 dist）
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = filepath.Join("..", "client", "dist")
	}
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))

	log.Printf("✅ WebRTC POC Phase 5（Go + Pion SFU）http://localhost:%s", port)
	log.Printf("   每人只上傳一路到伺服器，由 SFU 轉發給房內其他人")
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
