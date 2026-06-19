package main

import (
	"encoding/json"
	"log"
)

const maxPerRoom = 6 // mesh POC 的一房人數上限

// inbound 把「哪個 client 送來什麼原始位元組」一起交給 hub。
type inbound struct {
	client *Client
	data   []byte
}

// Hub 是「唯一」擁有所有房間狀態的 goroutine。
//
// 設計核心：所有狀態變更（加入/離開/轉發）都透過 channel 送進 Run() 這一個
// goroutine 依序處理，因此 rooms 這個 map 永遠只被一個 goroutine 觸碰，
// 完全不需要 mutex —— 這就是 Go 的「share memory by communicating」。
// 要擴展到多節點時（Phase 6），把這層房間狀態換成 Redis 即可，介面不變。
type Hub struct {
	unregister chan *Client
	inbound    chan inbound

	rooms map[string]map[string]*Client // room -> (peerID -> client)；僅 Run() 觸碰
}

func NewHub() *Hub {
	return &Hub{
		unregister: make(chan *Client),
		inbound:    make(chan inbound),
		rooms:      make(map[string]map[string]*Client),
	}
}

// Run 是 hub 的事件迴圈，整個程式只跑這一個 goroutine。
func (h *Hub) Run() {
	for {
		select {
		case c := <-h.unregister:
			h.handleLeave(c)
		case in := <-h.inbound:
			h.handleMessage(in.client, in.data)
		}
	}
}

func (h *Hub) handleMessage(c *Client, data []byte) {
	var msg Inbound
	if err := json.Unmarshal(data, &msg); err != nil {
		return // 不是合法 JSON 就忽略
	}
	switch msg.Type {
	case "join":
		h.handleJoin(c, msg.Room)
	case "signal":
		h.handleSignal(c, msg)
	}
}

func (h *Hub) handleJoin(c *Client, room string) {
	if room == "" {
		room = "default"
	}
	members := h.rooms[room]
	if members == nil {
		members = make(map[string]*Client)
		h.rooms[room] = members
	}
	if len(members) >= maxPerRoom {
		h.sendJSON(c, Outbound{Type: "full"})
		return
	}

	// 既有成員清單（在加入自己之前先取），交給新加入者主動發 offer
	peers := make([]string, 0, len(members))
	for id := range members {
		peers = append(peers, id)
	}

	members[c.id] = c
	c.room = room

	h.sendJSON(c, Joined{Type: "joined", ID: c.id, Peers: peers})
	for id, peer := range members {
		if id != c.id {
			h.sendJSON(peer, Outbound{Type: "peer-joined", ID: c.id})
		}
	}
	log.Printf("join room=%s id=%s (房內 %d 人)", room, short(c.id), len(members))
}

// handleSignal 把信令點對點轉給房內指定的 peer（不解讀內容）。
func (h *Hub) handleSignal(c *Client, msg Inbound) {
	members := h.rooms[c.room]
	if members == nil || msg.To == "" {
		return
	}
	if target := members[msg.To]; target != nil {
		h.sendJSON(target, Outbound{Type: "signal", From: c.id, Data: msg.Data})
	}
}

// handleLeave 在連線結束時清理，並通知房內其他人。每個 client 只會被呼叫一次。
func (h *Hub) handleLeave(c *Client) {
	if members := h.rooms[c.room]; members != nil {
		if _, ok := members[c.id]; ok {
			delete(members, c.id)
			for _, peer := range members {
				h.sendJSON(peer, Outbound{Type: "peer-left", ID: c.id})
			}
			if len(members) == 0 {
				delete(h.rooms, c.room)
			}
			log.Printf("leave room=%s id=%s", c.room, short(c.id))
		}
	}
	// unregister 每個 client 僅送一次，故此處 close 一定安全；writePump 會因此收工
	close(c.send)
}

// sendJSON 以非阻塞方式把訊息（Joined 或 Outbound）序列化後塞進 client 的送出佇列。
// 佇列滿（慢速/失效客戶端）就關閉連線，由其 readPump → unregister 走正常清理流程。
func (h *Hub) sendJSON(c *Client, msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
		log.Printf("client %s 送出佇列已滿，關閉連線", short(c.id))
		c.conn.Close()
	}
}

func short(id string) string {
	if len(id) > 6 {
		return id[:6]
	}
	return id
}
