package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// TestSFUForwardsMedia：用兩個「真實」的 Pion WebRTC client 連到 SFU，
// 各自上傳一條 VP8 track，驗證雙方都收到對方經由 SFU 轉發來的 track。
// 這才是 Phase 5 的重點——伺服器確實在轉發媒體（不是只轉發信令）。
func TestSFUForwardsMedia(t *testing.T) {
	api, err := buildAPI()
	if err != nil {
		t.Fatal(err)
	}
	sfu := newSFU(api)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := &threadSafeWriter{Conn: c}
		defer conn.Close() //nolint:errcheck
		sfu.handleWS(conn)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	aGot := make(chan struct{}, 1)
	bGot := make(chan struct{}, 1)
	startTestClient(t, wsURL, "itest", "A", sendOnce(aGot))
	time.Sleep(300 * time.Millisecond) // 讓 A 先就緒
	startTestClient(t, wsURL, "itest", "B", sendOnce(bGot))

	got := map[string]bool{}
	timeout := time.After(20 * time.Second)
	for len(got) < 2 {
		select {
		case <-aGot:
			got["A"] = true
			t.Log("✅ A 收到對方（B）經 SFU 轉發的 track")
		case <-bGot:
			got["B"] = true
			t.Log("✅ B 收到對方（A）經 SFU 轉發的 track")
		case <-timeout:
			t.Fatalf("逾時：只有 %v 收到轉發 track", got)
		}
	}
}

// TestSFUExternalForwardsMedia：對「外部 / 容器化」的 SFU 做端對端驗證。
// 設定 SFU_WS_URL（如 ws://localhost:8085/ws）才會執行，否則自動 skip。
// 可用 SFU_CLIENTS 指定人數（預設 2），例如設 6 來驗證 Docker 版的多人轉發。
func TestSFUExternalForwardsMedia(t *testing.T) {
	url := os.Getenv("SFU_WS_URL")
	if url == "" {
		t.Skip("設定 SFU_WS_URL（如 ws://localhost:8085/ws）後才會對外部 SFU 執行")
	}
	n := 2
	if s := os.Getenv("SFU_CLIENTS"); s != "" {
		if v, err := strconv.Atoi(s); err == nil && v >= 2 {
			n = v
		}
	}
	// 用唯一房名，避免容器內殘留上一輪的 peer
	room := fmt.Sprintf("ext-%d", time.Now().UnixNano())
	runManyClients(t, url, room, n)
}

// TestSFUManyClients：連 6 個真實 client 進同一房，驗證「每個人」都收到其他 5 人的 track。
// 這是針對「第 6 人只看到自己（拿到 0 條 track）」這個 bug 的回歸測試。
func TestSFUManyClients(t *testing.T) {
	wsURL, cleanup := newTestSFUServer(t)
	defer cleanup()
	runManyClients(t, wsURL, "many", 6)
}

// runManyClients 讓 n 個 client 陸續加入同一房，驗證「每個人」都收到其他 n-1 人的 track。
func runManyClients(t *testing.T, wsURL, room string, n int) {
	t.Helper()
	counts := make([]int32, n)
	for i := 0; i < n; i++ {
		i := i
		startTestClient(t, wsURL, room, fmt.Sprintf("%s-%d", room, i), func() {
			atomic.AddInt32(&counts[i], 1)
		})
		time.Sleep(400 * time.Millisecond) // 模擬使用者陸續加入
	}

	deadline := time.Now().Add(time.Duration(n)*5*time.Second + 10*time.Second)
	for {
		done := true
		for i := 0; i < n; i++ {
			if atomic.LoadInt32(&counts[i]) < int32(n-1) {
				done = false
			}
		}
		if done {
			break
		}
		if time.Now().After(deadline) {
			for i := 0; i < n; i++ {
				t.Logf("client %d 收到 %d 條（期望 %d）", i, atomic.LoadInt32(&counts[i]), n-1)
			}
			t.Fatal("有 client 沒收齊其他人的 track（人數一多就餓死的 bug 應已修正）")
		}
		time.Sleep(300 * time.Millisecond)
	}
	for i := 0; i < n; i++ {
		t.Logf("client %d 收到 %d 條 track ✅", i, atomic.LoadInt32(&counts[i]))
	}
}

// sendOnce 把一個 channel 包成「收到 track 時送一次訊號」的 callback。
func sendOnce(ch chan struct{}) func() {
	return func() {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// newTestSFUServer 起一個 in-process 的 SFU（httptest），回傳 ws 端點與清理函式。
func newTestSFUServer(t *testing.T) (string, func()) {
	t.Helper()
	api, err := buildAPI()
	if err != nil {
		t.Fatal(err)
	}
	sfu := newSFU(api)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := &threadSafeWriter{Conn: c}
		defer conn.Close() //nolint:errcheck
		sfu.handleWS(conn)
	})
	srv := httptest.NewServer(mux)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	return wsURL, srv.Close
}

// startTestClient 模擬一個瀏覽器：上傳一條 VP8 track、當 answerer 回應 SFU 的 offer，
// 每收到一條 SFU 轉發來的 track 就呼叫 onTrack。
func startTestClient(t *testing.T, wsURL, room, name string, onTrack func()) {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtcConfig)
	if err != nil {
		t.Fatal(err)
	}

	// track ID 必須唯一（真實瀏覽器是唯一 GUID），否則伺服器端會把不同人的
	// track 當成同一條而不轉發。
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video-"+name, "stream-"+name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}

	pc.OnTrack(func(_ *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		onTrack()
	})

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}

	var writeMu sync.Mutex
	writeJSON := func(v any) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.WriteJSON(v)
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		writeJSON(map[string]any{"type": "candidate", "candidate": init})
	})

	writeJSON(map[string]any{"type": "join", "room": room})

	// 持續送 RTP，讓對端的 OnTrack 被觸發（OnTrack 在收到第一個 RTP 封包時觸發）
	go func() {
		tick := time.NewTicker(40 * time.Millisecond)
		defer tick.Stop()
		for range tick.C {
			if err := track.WriteSample(media.Sample{
				Data:     make([]byte, 200),
				Duration: 40 * time.Millisecond,
			}); err != nil {
				return
			}
		}
	}()

	// 當 answerer：讀 SFU 的 offer/candidate，回 answer
	go func() {
		for {
			var msg Inbound
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			switch msg.Type {
			case "offer":
				if msg.SDP == nil {
					continue
				}
				if err := pc.SetRemoteDescription(*msg.SDP); err != nil {
					continue
				}
				answer, err := pc.CreateAnswer(nil)
				if err != nil {
					continue
				}
				if err := pc.SetLocalDescription(answer); err != nil {
					continue
				}
				writeJSON(map[string]any{"type": "answer", "sdp": answer})
			case "candidate":
				if msg.Candidate != nil {
					_ = pc.AddICECandidate(*msg.Candidate)
				}
			}
		}
	}()
}
