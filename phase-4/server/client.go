package main

import (
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second    // 單次寫入逾時
	pongWait       = 60 * time.Second    // 多久沒收到 pong 就視為斷線
	pingPeriod     = (pongWait * 9) / 10 // 主動 ping 的週期
	maxMessageSize = 64 * 1024           // 單一信令訊息上限
	sendBuffer     = 256                 // 每個 client 的送出佇列大小
)

// Client 代表一條 WebSocket 長連線。
// 每個 client 由「兩個 goroutine」服務，這是 Go 處理大量併發連線的核心模式：
//
//	readPump  — 專責讀取，把收到的訊息丟進 hub.inbound
//	writePump — 專責寫出，從 send channel 取資料寫到連線，並負責心跳 ping
//
// 讀寫分離 + 各自一個 goroutine，gorilla/websocket 才能安全運作
// （它允許「一個並行讀者 + 一個並行寫者」）。
type Client struct {
	id   string
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
	room string // 只由 hub 的 run goroutine 讀寫，避免資料競爭
}

// readPump 持續讀取連線訊息，交給 hub 處理。離開時通知 hub 註銷。
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		// 每收到一次 pong 就延後讀取逾時，藉此偵測死連線
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			log.Printf("[READ-ERR] id=%s room=%s err=%v", short(c.id), c.room, err)
			return
		}
		c.hub.inbound <- inbound{client: c, data: data}
	}
}

// writePump 從 send channel 取資料寫出，並定期送 ping 維持連線。
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// hub 關閉了 send channel → 連線收工
				log.Printf("[WRITE-END] id=%s room=%s reason=send-closed", short(c.id), c.room)
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("[WRITE-ERR] id=%s room=%s err=%v", short(c.id), c.room, err)
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("[PING-ERR] id=%s room=%s err=%v", short(c.id), c.room, err)
				return
			}
		}
	}
}
