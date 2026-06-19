// 壓測工具：用「真實的 Pion WebRTC client」模擬大量使用者，經由 Router 路由，
// 驗證 (1) 多房間會分散到多個 SFU 節點、(2) 每個房間內媒體確實互相轉發。
//
// 用法（環境變數）：
//
//	ROUTER_URL        Router 位址（預設 http://localhost:8080）
//	ROOMS             房間數（預設 4）
//	CLIENTS_PER_ROOM  每房人數（預設 3）
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

var rtcConfig = webrtc.Configuration{
	ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return def
}
func randID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type routeResp struct {
	URL   string `json:"url"`
	Node  string `json:"node"`
	Token string `json:"token"`
}

func route(routerURL, room string) (routeResp, error) {
	var rr routeResp
	resp, err := http.Get(routerURL + "/api/route?room=" + room)
	if err != nil {
		return rr, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return rr, fmt.Errorf("router 回 %d", resp.StatusCode)
	}
	return rr, json.NewDecoder(resp.Body).Decode(&rr)
}

// client：一個經 Router 路由、連到所屬 SFU 節點的 Pion client。
type client struct {
	room   string
	node   string
	tracks int32 // 收到幾條轉發 track（atomic）
}

func (c *client) run(routerURL string, done <-chan struct{}) error {
	rr, err := route(routerURL, c.room)
	if err != nil {
		return err
	}
	c.node = rr.Node

	pc, err := webrtc.NewPeerConnection(rtcConfig)
	if err != nil {
		return err
	}
	id := randID()
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video-"+id, "stream-"+id)
	if err != nil {
		return err
	}
	if _, err = pc.AddTrack(track); err != nil {
		return err
	}
	pc.OnTrack(func(_ *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		atomic.AddInt32(&c.tracks, 1)
	})

	conn, _, err := websocket.DefaultDialer.Dial(rr.URL, nil)
	if err != nil {
		_ = pc.Close()
		return err
	}

	var wmu sync.Mutex
	send := func(v any) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = conn.WriteJSON(v)
	}

	pc.OnICECandidate(func(ic *webrtc.ICECandidate) {
		if ic == nil {
			return
		}
		send(map[string]any{"type": "candidate", "candidate": ic.ToJSON()})
	})
	send(map[string]any{"type": "join", "room": c.room, "token": rr.Token})

	go func() { // 持續送 RTP
		tk := time.NewTicker(40 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-done:
				return
			case <-tk.C:
				if track.WriteSample(media.Sample{Data: make([]byte, 200), Duration: 40 * time.Millisecond}) != nil {
					return
				}
			}
		}
	}()

	go func() { // answerer：回應 SFU 的 offer
		for {
			var msg struct {
				Type      string                     `json:"type"`
				SDP       *webrtc.SessionDescription `json:"sdp"`
				Candidate *webrtc.ICECandidateInit   `json:"candidate"`
			}
			if conn.ReadJSON(&msg) != nil {
				return
			}
			switch msg.Type {
			case "offer":
				if msg.SDP == nil {
					continue
				}
				if pc.SetRemoteDescription(*msg.SDP) != nil {
					continue
				}
				ans, err := pc.CreateAnswer(nil)
				if err != nil {
					continue
				}
				if pc.SetLocalDescription(ans) != nil {
					continue
				}
				send(map[string]any{"type": "answer", "sdp": ans})
			case "candidate":
				if msg.Candidate != nil {
					_ = pc.AddICECandidate(*msg.Candidate)
				}
			}
		}
	}()

	<-done
	_ = conn.Close()
	_ = pc.Close()
	return nil
}

func main() {
	routerURL := env("ROUTER_URL", "http://localhost:8080")
	rooms := envInt("ROOMS", 4)
	perRoom := envInt("CLIENTS_PER_ROOM", 3)
	total := rooms * perRoom

	log.Printf("壓測開始：%d 房 × %d 人 = %d 個 client，經 Router %s", rooms, perRoom, total, routerURL)

	done := make(chan struct{})
	var clients []*client
	var wg sync.WaitGroup
	for r := 0; r < rooms; r++ {
		room := fmt.Sprintf("load-%d", r)
		for p := 0; p < perRoom; p++ {
			c := &client{room: room}
			clients = append(clients, c)
			wg.Add(1)
			go func(c *client) {
				defer wg.Done()
				if err := c.run(routerURL, done); err != nil {
					log.Printf("client room=%s 失敗：%v", c.room, err)
				}
			}(c)
			time.Sleep(40 * time.Millisecond) // 稍微錯開，避免同時湧入
		}
	}

	// 給所有人時間完成路由 / 協商 / 媒體流動
	settle := time.Duration(total)*60*time.Millisecond + 8*time.Second
	log.Printf("等待 %s 讓連線與媒體穩定…", settle.Round(time.Second))
	time.Sleep(settle)

	// 統計（連線仍在線時讀取）
	expected := perRoom - 1
	okClients := 0
	nodeRooms := map[string]map[string]bool{} // node -> set(room)
	for _, c := range clients {
		if int(atomic.LoadInt32(&c.tracks)) >= expected {
			okClients++
		}
		if c.node != "" {
			if nodeRooms[c.node] == nil {
				nodeRooms[c.node] = map[string]bool{}
			}
			nodeRooms[c.node][c.room] = true
		}
	}

	close(done)
	waitWithTimeout(&wg, 5*time.Second)

	fmt.Println("\n========== 壓測結果 ==========")
	fmt.Printf("client 總數          ：%d\n", total)
	fmt.Printf("收齊他人 track 的 client：%d / %d（每人應收 %d 條）\n", okClients, total, expected)
	fmt.Println("房間在各節點的分布：")
	nodes := make([]string, 0, len(nodeRooms))
	for n := range nodeRooms {
		nodes = append(nodes, n)
	}
	sort.Strings(nodes)
	for _, n := range nodes {
		rs := make([]string, 0, len(nodeRooms[n]))
		for r := range nodeRooms[n] {
			rs = append(rs, r)
		}
		sort.Strings(rs)
		fmt.Printf("  %s ← %d 間房 %v\n", n, len(rs), rs)
	}
	fmt.Println("==============================")

	if okClients < total {
		os.Exit(1)
	}
}

func waitWithTimeout(wg *sync.WaitGroup, d time.Duration) {
	c := make(chan struct{})
	go func() { wg.Wait(); close(c) }()
	select {
	case <-c:
	case <-time.After(d):
	}
}
