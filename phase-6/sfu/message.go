package main

import (
	"sync"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// SFU 的信令協議。注意與前面 mesh 階段「最大的不同」：
// 這裡是「伺服器當 offerer」—— 伺服器主動發 offer，client 只負責回 answer。
//
//   client → server：join / answer / candidate
//   server → client：offer / candidate

// Inbound：client → server（Phase 6 在 join 多帶一個 Router 簽發的 Token）
type Inbound struct {
	Type      string                     `json:"type"`
	Room      string                     `json:"room,omitempty"`
	Token     string                     `json:"token,omitempty"`     // 入會 JWT
	SDP       *webrtc.SessionDescription `json:"sdp,omitempty"`       // answer
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"` // ICE
}

// Outbound：server → client
type Outbound struct {
	Type      string                     `json:"type"`
	SDP       *webrtc.SessionDescription `json:"sdp,omitempty"`       // offer
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"` // ICE
	Error     string                     `json:"error,omitempty"`     // 錯誤原因（如 unauthorized）
}

// threadSafeWriter：gorilla 的連線不允許並行寫入，但 SFU 會從多個 goroutine
// （signalPeerConnections、OnICECandidate）對同一條連線寫東西，故包一層鎖。
type threadSafeWriter struct {
	*websocket.Conn
	mu sync.Mutex
}

func (w *threadSafeWriter) writeJSON(v any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.Conn.WriteJSON(v)
}
