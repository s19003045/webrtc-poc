package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus/promhttp"
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

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(_ *http.Request) bool { return true }, // POC：允許任何來源
}

func main() {
	port := env("PORT", "3000")
	nodeID := env("NODE_ID", "node-"+short(newID()))
	nodeAddr := env("NODE_ADDR", "ws://localhost:"+port+"/ws") // Router 回給 client 的對外位址
	redisAddr := os.Getenv("REDIS_ADDR")                       // 空 = 單機模式（不接 cluster）
	jwtSecret := os.Getenv("JWT_SECRET")                       // 空 = 不驗 JWT

	api, err := buildAPI()
	if err != nil {
		log.Fatal("build webrtc api:", err)
	}
	sfu := newSFU(api, jwtSecret)

	// 週期性對所有上傳者要 keyframe，讓晚加入的訂閱者盡快看到畫面
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for range t.C {
			sfu.dispatchKeyFrames()
		}
	}()

	// 週期性更新 Prometheus 指標
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			updateMetrics(sfu)
		}
	}()

	// 若有設 Redis，就加入叢集（註冊節點、回報負載、刷新房間歸屬）
	if redisAddr != "" {
		cluster := newCluster(redisAddr, nodeID, nodeAddr, sfu)
		go cluster.run(context.Background())
		log.Printf("已加入叢集：node=%s addr=%s redis=%s", nodeID, nodeAddr, redisAddr)
	}

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
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("✅ Phase 6 SFU 節點 %s（Go + Pion）http://localhost:%s", nodeID, port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
