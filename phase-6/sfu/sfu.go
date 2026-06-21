package main

import (
	"errors"
	"io"
	"log"
	"sync"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

var webrtcConfig = webrtc.Configuration{
	ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
}

// peer：一個已連到 SFU 的參與者 = 一條 WebSocket + 一個伺服器端 PeerConnection。
//
//	pending / haveRemote：只在該連線的讀取 goroutine 中被存取（候選排隊），不需鎖。
//	negotiated / needsReneg：協商狀態，一律在持有 Room.lock 時存取。
type peer struct {
	id         string
	pc         *webrtc.PeerConnection
	ws         *threadSafeWriter
	pending    []webrtc.ICECandidateInit
	haveRemote bool
	negotiated bool // 是否完成過初次協商
	needsReneg bool // 協商進行中時 track 集合有變動，待回到 stable 後再同步
}

// Room：一個會議空間。
// SFU 精神：每個人上傳的 track 只進伺服器一次，登記在 trackLocals，
// 再由 signalPeerConnections 轉發（AddTrack）給房內其他所有人。
type Room struct {
	lock        sync.Mutex
	peers       []*peer
	trackLocals map[string]*webrtc.TrackLocalStaticRTP
}

func newRoom() *Room {
	return &Room{trackLocals: map[string]*webrtc.TrackLocalStaticRTP{}}
}

// SFU：管理多個房間（多會議空間）。
type SFU struct {
	lock      sync.Mutex
	rooms     map[string]*Room
	api       *webrtc.API // 帶有固定 UDP 埠 / NAT 設定的 WebRTC API
	jwtSecret string      // 非空時，join 需附上 Router 簽發的有效 JWT
}

func newSFU(api *webrtc.API, jwtSecret string) *SFU {
	return &SFU{rooms: map[string]*Room{}, api: api, jwtSecret: jwtSecret}
}

func (s *SFU) room(id string) *Room {
	s.lock.Lock()
	defer s.lock.Unlock()
	r := s.rooms[id]
	if r == nil {
		r = newRoom()
		s.rooms[id] = r
	}
	return r
}

// snapshot 回傳目前「有人的」房間名稱、總連線數、總轉發 track 數。
// 給 Redis 心跳（回報負載 / 刷新房間）與 Prometheus 指標共用。
// 鎖序：先在 s.lock 下複製 rooms，再逐一鎖各 Room（與其他路徑一致，不會死鎖）。
func (s *SFU) snapshot() (names []string, peers, tracks int) {
	s.lock.Lock()
	snap := make(map[string]*Room, len(s.rooms))
	for k, v := range s.rooms {
		snap[k] = v
	}
	s.lock.Unlock()

	for name, r := range snap {
		r.lock.Lock()
		n := len(r.peers)
		t := len(r.trackLocals)
		r.lock.Unlock()
		if n > 0 {
			names = append(names, name)
			peers += n
			tracks += t
		}
	}
	return names, peers, tracks
}

// peerRef：給指標收集用的單一連線快照（房間名 + 短 id + 它的 PeerConnection）。
type peerRef struct {
	room string
	id   string
	pc   *webrtc.PeerConnection
}

// peerRefs 列舉目前所有房間的所有連線，供 per-peer stats 收集。
// 鎖序與 snapshot 一致：先在 s.lock 下複製 rooms，再逐一鎖各 Room。
// 回傳後在房鎖外呼叫 pc.GetStats()（Pion 的 GetStats 可安全併發呼叫）。
func (s *SFU) peerRefs() []peerRef {
	s.lock.Lock()
	snap := make([]*Room, 0, len(s.rooms))
	names := make([]string, 0, len(s.rooms))
	for name, r := range s.rooms {
		snap = append(snap, r)
		names = append(names, name)
	}
	s.lock.Unlock()

	var refs []peerRef
	for i, r := range snap {
		r.lock.Lock()
		for _, p := range r.peers {
			refs = append(refs, peerRef{room: names[i], id: short(p.id), pc: p.pc})
		}
		r.lock.Unlock()
	}
	return refs
}

// addTrack：某人上傳了一條 track → 建立可轉發的 local track，登記後通知大家重新協商。
func (r *Room) addTrack(t *webrtc.TrackRemote) *webrtc.TrackLocalStaticRTP {
	r.lock.Lock()
	defer func() {
		r.lock.Unlock()
		r.signalPeerConnections()
	}()
	// 用與來源相同的 ID / StreamID，方便等下避免把某人自己的 track 轉回給他自己
	local, err := webrtc.NewTrackLocalStaticRTP(t.Codec().RTPCodecCapability, t.ID(), t.StreamID())
	if err != nil {
		log.Println("new local track:", err)
		return nil
	}
	r.trackLocals[t.ID()] = local
	return local
}

func (r *Room) removeTrack(t *webrtc.TrackLocalStaticRTP) {
	r.lock.Lock()
	defer func() {
		r.lock.Unlock()
		r.signalPeerConnections()
	}()
	delete(r.trackLocals, t.ID())
}

// signalPeerConnections：SFU 的核心。對房內每個 peer 同步它「應該轉發」的 track 集合。
//
// 重點（相對 Pion 範例的改良，避免人一多就卡住）：
//   - 逐一處理每個 peer，互不影響——「正在協商中」的 peer 會被跳過並標記 needsReneg，
//     而不是讓整個迴圈從頭重來。否則排在最後的新加入者會被前面忙碌的 peer 餓死，
//     拿到 0 條 track（就是「第 6 人只看到自己」的成因）。
//   - track 集合沒變、且已完成初次協商的 peer 不重發 offer，避免協商風暴。
func (r *Room) signalPeerConnections() {
	r.lock.Lock()
	defer func() {
		r.lock.Unlock()
		r.dispatchKeyFrame()
	}()

	// 先移除已關閉的連線
	alive := r.peers[:0]
	for _, p := range r.peers {
		if p.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			continue
		}
		alive = append(alive, p)
	}
	r.peers = alive

	for _, p := range r.peers {
		r.syncPeer(p)
	}
}

// syncPeer：把單一 peer 帶到「應有的轉發 track 集合」，必要時對它重新協商。
// 呼叫時必須持有 r.lock。
func (r *Room) syncPeer(p *peer) {
	// 上一輪 offer 還沒收到 answer（非 stable）→ 先標記，等 answer 回來再同步，
	// 千萬不要在這裡硬發 offer（會 glare），也不要因此卡住其他 peer。
	if p.pc.SignalingState() != webrtc.SignalingStateStable {
		p.needsReneg = true
		return
	}

	changed := false
	existing := map[string]bool{}
	for _, sender := range p.pc.GetSenders() {
		if sender.Track() == nil {
			continue
		}
		id := sender.Track().ID()
		existing[id] = true
		// 對應的上傳已消失（有人離開）→ 移除這個轉發
		if _, ok := r.trackLocals[id]; !ok {
			if err := p.pc.RemoveTrack(sender); err == nil {
				changed = true
			}
		}
	}
	// 不要把某人自己上傳的 track 轉回給他：receivers 的 track 也算「已存在」
	for _, receiver := range p.pc.GetReceivers() {
		if receiver.Track() == nil {
			continue
		}
		existing[receiver.Track().ID()] = true
	}
	// 補上還沒轉發給它的 track
	for id, local := range r.trackLocals {
		if !existing[id] {
			if _, err := p.pc.AddTrack(local); err == nil {
				changed = true
			}
		}
	}

	// track 沒變且已協商過 → 不必再 offer（避免無謂的協商風暴）
	if !changed && p.negotiated {
		p.needsReneg = false
		return
	}

	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		p.needsReneg = true
		return
	}
	if err := p.pc.SetLocalDescription(offer); err != nil {
		p.needsReneg = true
		return
	}
	if err := p.ws.writeJSON(Outbound{Type: "offer", SDP: &offer}); err != nil {
		return
	}
	p.needsReneg = false
}

// onAnswer：收到 peer 的 answer。設好 remote、補加排隊的 candidate，
// 若協商期間 track 有變動（needsReneg）就趁現在 stable 再同步一次。
func (r *Room) onAnswer(p *peer, sdp webrtc.SessionDescription) {
	r.lock.Lock()
	defer func() {
		r.lock.Unlock()
		r.dispatchKeyFrame()
	}()

	if err := p.pc.SetRemoteDescription(sdp); err != nil {
		log.Println("set remote description:", err)
		return
	}
	p.negotiated = true
	p.haveRemote = true
	for _, c := range p.pending {
		_ = p.pc.AddICECandidate(c)
	}
	p.pending = nil

	if p.needsReneg {
		r.syncPeer(p)
	}
}

// dispatchKeyFrame：對所有上傳者發 PLI 要求 keyframe，讓剛訂閱的人盡快看到畫面。
func (r *Room) dispatchKeyFrame() {
	r.lock.Lock()
	defer r.lock.Unlock()
	for _, p := range r.peers {
		for _, receiver := range p.pc.GetReceivers() {
			if receiver.Track() == nil {
				continue
			}
			_ = p.pc.WriteRTCP([]rtcp.Packet{
				&rtcp.PictureLossIndication{MediaSSRC: uint32(receiver.Track().SSRC())},
			})
		}
	}
}

// dispatchKeyFrames：對所有房間發 keyframe 請求（由背景 ticker 週期呼叫）。
func (s *SFU) dispatchKeyFrames() {
	s.lock.Lock()
	rooms := make([]*Room, 0, len(s.rooms))
	for _, r := range s.rooms {
		rooms = append(rooms, r)
	}
	s.lock.Unlock()
	for _, r := range rooms {
		r.dispatchKeyFrame()
	}
}

// handleWS：每條連線的處理流程。
func (s *SFU) handleWS(conn *threadSafeWriter) {
	// 第一則訊息必須是 join，決定房間
	var first Inbound
	if err := conn.ReadJSON(&first); err != nil || first.Type != "join" {
		return
	}
	roomID := first.Room
	if roomID == "" {
		roomID = "default"
	}

	// 驗證 Router 簽發的入會 JWT（JWT_SECRET 未設定則跳過，方便 dev / 測試）
	if s.jwtSecret != "" {
		if err := validateToken(s.jwtSecret, first.Token, roomID); err != nil {
			_ = conn.writeJSON(Outbound{Type: "error", Error: "unauthorized"})
			log.Printf("拒絕未授權的 join room=%s: %v", roomID, err)
			return
		}
	}

	room := s.room(roomID)

	pc, err := s.api.NewPeerConnection(webrtcConfig)
	if err != nil {
		log.Println("new peer connection:", err)
		return
	}
	defer pc.Close() //nolint:errcheck

	// 準備「接收」client 的上傳：各加一個 recvonly transceiver。
	// 之後 client 回 answer 時，它 addTrack 的鏡頭/麥克風就會對應到這兩個 transceiver。
	for _, typ := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := pc.AddTransceiverFromKind(typ, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			log.Println("add transceiver:", err)
			return
		}
	}

	p := &peer{id: newID(), pc: pc, ws: conn}
	room.lock.Lock()
	room.peers = append(room.peers, p)
	room.lock.Unlock()
	log.Printf("join room=%s peer=%s (房內 %d 人)", roomID, short(p.id), len(room.peers))

	// 伺服器找到的 ICE candidate → 傳給 client
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		_ = conn.writeJSON(Outbound{Type: "candidate", Candidate: &init})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			_ = pc.Close()
			room.signalPeerConnections()
		default:
		}
	})

	// 收到 client 上傳的 track → 登記成可轉發的 local track，並持續把 RTP 複製過去
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("room=%s peer=%s 收到上傳 track kind=%s codec=%s", roomID, short(p.id), t.Kind(), t.Codec().MimeType)
		local := room.addTrack(t)
		if local == nil {
			return
		}
		defer room.removeTrack(local)

		buf := make([]byte, 1500)
		for {
			i, _, readErr := t.Read(buf)
			if readErr != nil {
				return
			}
			if _, err := local.Write(buf[:i]); err != nil && !errors.Is(err, io.ErrClosedPipe) {
				return
			}
		}
	})

	// 初次協商：讓 client 開始上傳（此時可能還沒有別人的 track）
	room.signalPeerConnections()

	// 持續讀取 client 的 answer / candidate
	for {
		var msg Inbound
		if err := conn.ReadJSON(&msg); err != nil {
			break
		}
		switch msg.Type {
		case "answer":
			if msg.SDP == nil {
				continue
			}
			room.onAnswer(p, *msg.SDP)
		case "candidate":
			if msg.Candidate == nil {
				continue
			}
			if p.haveRemote {
				_ = pc.AddICECandidate(*msg.Candidate)
			} else {
				// remoteDescription 還沒設好，先排隊（候選可能比 answer 先到）
				p.pending = append(p.pending, *msg.Candidate)
			}
		}
	}
}
