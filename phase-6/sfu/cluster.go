package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cluster：把這個 SFU 節點接上 Redis，讓 Router 能做「房間親和性路由」。
//
// 寫進 Redis 的東西：
//   node:{nodeID}  -> {addr,load}   每 5 秒刷新、EX 15（過期即視為節點死亡）
//   room:{roomID}  -> nodeID        本節點有人的房間，每 5 秒刷新、EX 60
//
// Router 讀 node:* 挑負載最低者、讀 room:{id} 決定既有房間在哪個節點。
// 房間空了就不再刷新 → room:{id} 自動過期 → 下次由 Router 重新指派（自我修復）。
type Cluster struct {
	rdb    *redis.Client
	nodeID string
	addr   string
	sfu    *SFU
}

func newCluster(redisAddr, nodeID, addr string, sfu *SFU) *Cluster {
	return &Cluster{
		rdb:    redis.NewClient(&redis.Options{Addr: redisAddr}),
		nodeID: nodeID,
		addr:   addr,
		sfu:    sfu,
	}
}

func (c *Cluster) run(ctx context.Context) {
	// 先試 ping，連不上就只警告（節點仍可單機運作）
	if err := c.rdb.Ping(ctx).Err(); err != nil {
		log.Printf("⚠️ 連不上 Redis（%v），節點以單機模式運作", err)
	}
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	c.heartbeat(ctx) // 啟動就先註冊一次
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.heartbeat(ctx)
		}
	}
}

func (c *Cluster) heartbeat(ctx context.Context) {
	names, peers, _ := c.sfu.snapshot()

	// 註冊/刷新本節點，load = 目前總連線數
	payload, _ := json.Marshal(map[string]any{"addr": c.addr, "load": peers})
	if err := c.rdb.Set(ctx, "node:"+c.nodeID, payload, 15*time.Second).Err(); err != nil {
		return // Redis 暫時不可用就跳過這輪
	}

	// 刷新本節點目前有人的房間（空房不刷新 → 自動過期）
	pipe := c.rdb.Pipeline()
	for _, name := range names {
		pipe.Set(ctx, "room:"+name, c.nodeID, 60*time.Second)
	}
	_, _ = pipe.Exec(ctx)
}
