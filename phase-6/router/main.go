// Router：Phase 6 水平擴展的「牽線」層。
//
//   1. 用 Redis 做「房間親和性路由」：同一個房間永遠導到同一個 SFU 節點，
//      新房間則指派給「目前負載最低」的活節點。
//   2. 簽發入會 JWT（夾帶 room claim），SFU 節點據此驗證。
//   3. 服務前端靜態檔。
//
// 前端流程：先 GET /api/route?room=X 拿到 { url, token }，再連到那個 SFU 節點。
package main

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"log"
	"net/http"
	"os"
	"sort"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type nodeInfo struct {
	ID   string
	Addr string `json:"addr"`
	Load int    `json:"load"`
}

type Router struct {
	rdb       *redis.Client
	jwtSecret string
}

// aliveNodes 掃描 Redis 裡所有還活著的節點（node:* 未過期者）。
func (rt *Router) aliveNodes(ctx context.Context) ([]nodeInfo, error) {
	var nodes []nodeInfo
	iter := rt.rdb.Scan(ctx, 0, "node:*", 100).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		val, err := rt.rdb.Get(ctx, key).Result()
		if err != nil {
			continue
		}
		var n nodeInfo
		if err := json.Unmarshal([]byte(val), &n); err != nil {
			continue
		}
		n.ID = key[len("node:"):]
		nodes = append(nodes, n)
	}
	return nodes, iter.Err()
}

// pickNode：房間已指派且該節點還活著就沿用；否則挑負載最低的活節點並寫回 Redis。
func (rt *Router) pickNode(ctx context.Context, room string) (nodeInfo, error) {
	nodes, err := rt.aliveNodes(ctx)
	if err != nil {
		return nodeInfo{}, err
	}
	alive := map[string]nodeInfo{}
	for _, n := range nodes {
		alive[n.ID] = n
	}

	// 既有指派
	if id, err := rt.rdb.Get(ctx, "room:"+room).Result(); err == nil {
		if n, ok := alive[id]; ok {
			rt.rdb.Expire(ctx, "room:"+room, 60*time.Second) // 沿用並續命
			return n, nil
		}
	}

	if len(nodes) == 0 {
		return nodeInfo{}, redis.Nil
	}
	// 負載最低優先；負載相同時用 hash(room+node) 分散，
	// 避免冷啟動（大家負載都是 0）時所有新房間都擠到同一個節點。
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Load != nodes[j].Load {
			return nodes[i].Load < nodes[j].Load
		}
		return affinity(room, nodes[i].ID) < affinity(room, nodes[j].ID)
	})
	pick := nodes[0]
	rt.rdb.Set(ctx, "room:"+room, pick.ID, 60*time.Second)
	return pick, nil
}

// affinity：room 與 node 的穩定雜湊分數，用於負載相同時把房間分散到不同節點。
func affinity(room, node string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(room + "|" + node))
	return h.Sum64()
}

func (rt *Router) issueToken(room string) (string, error) {
	if rt.jwtSecret == "" {
		return "", nil
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"room": room,
		"exp":  time.Now().Add(time.Hour).Unix(),
	})
	return tok.SignedString([]byte(rt.jwtSecret))
}

func (rt *Router) handleRoute(w http.ResponseWriter, r *http.Request) {
	room := r.URL.Query().Get("room")
	if room == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}
	node, err := rt.pickNode(r.Context(), room)
	if err != nil {
		http.Error(w, "no available sfu node", http.StatusServiceUnavailable)
		log.Printf("route room=%s 失敗：%v", room, err)
		return
	}
	token, err := rt.issueToken(room)
	if err != nil {
		http.Error(w, "token error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"url":   node.Addr,
		"node":  node.ID,
		"token": token,
	})
	log.Printf("route room=%s → node=%s (load=%d)", room, node.ID, node.Load)
}

func main() {
	port := env("PORT", "8080")
	rt := &Router{
		rdb:       redis.NewClient(&redis.Options{Addr: env("REDIS_ADDR", "localhost:6379")}),
		jwtSecret: os.Getenv("JWT_SECRET"),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/route", rt.handleRoute)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	// 服務前端（Phase 6 client 打包後的 dist）
	staticDir := env("STATIC_DIR", "../client/dist")
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))

	log.Printf("✅ Phase 6 Router http://localhost:%s（Redis 房間路由 + JWT）", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
