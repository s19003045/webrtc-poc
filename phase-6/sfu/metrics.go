package main

import (
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Prometheus 指標：由 /metrics 端點輸出，給 Prometheus 抓取、Grafana 畫圖。
//
// 兩個層級：
//   - 節點層級（gauge）：房間數 / 總連線數 / 轉發 track 數。看整體負載。
//   - 連線層級（gaugeVec，label = node/room/peer）：每個參與者的上行/下行頻寬、
//     丟包、RTT、jitter。看「誰的網路在掉封包」這種逐連線的品質問題。
//
// 連線層級指標是高基數且短命的：peer 一離線就必須刪掉它的 series，
// 否則 Prometheus 的 series 會無上限累積（見 peerStatsCollector.collect 的清理）。
var (
	gaugeRooms = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_rooms", Help: "目前節點上的房間數",
	})
	gaugePeers = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_peers", Help: "目前節點上的總連線數（參與者）",
	})
	gaugeTracks = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_tracks", Help: "目前節點上轉發中的 track 數",
	})

	peerLabels = []string{"node", "room", "peer"}

	// 上/下行 bitrate 與 RTT 一律取自「選定的 ICE candidate-pair」（傳輸層）。
	//
	// 為什麼不用 inbound/outbound-rtp 的 bytes？因為 Pion v4 的 pc.GetStats() 只 collect
	// receiver（inbound），不 collect sender，所以 outbound-rtp / remote-inbound-rtp 根本不會
	// 出現在報告裡——下行 bytes 與 RTCP-based RTT 都拿不到。改用 candidate-pair：它的
	// bytesSent/bytesReceived 是傳輸層實際收發量（涵蓋該連線轉發的所有 track），
	// currentRoundTripTime 是 STUN 量到的 RTT，不依賴對端的 RTCP Receiver Report。

	// 上行：SFU 在這條連線收到的位元率（client→SFU），由 candidate-pair bytesReceived 取差分。
	gaugePeerUplinkBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "sfu_peer_uplink_bitrate_bps", Help: "該連線上行位元率（client→SFU，傳輸層），bit/s",
	}, peerLabels)
	// 下行：SFU 轉發給這條連線的位元率（SFU→client），由 candidate-pair bytesSent 取差分。
	gaugePeerDownlinkBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "sfu_peer_downlink_bitrate_bps", Help: "該連線下行位元率（SFU→client，傳輸層），bit/s",
	}, peerLabels)
	// RTT：candidate-pair 的 currentRoundTripTime（秒，STUN 量測，不需 RTCP）。
	gaugePeerRTT = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "sfu_peer_rtt_seconds", Help: "該連線往返時間 RTT（秒，ICE/STUN 量測）",
	}, peerLabels)
	// 上行累積丟包：SFU 端在 inbound-rtp 觀察到的 packetsLost（client→SFU 路徑）。
	gaugePeerUplinkLost = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "sfu_peer_uplink_packets_lost", Help: "該連線上行累積丟包數（SFU 端觀察）",
	}, peerLabels)
	// 上行 jitter：inbound-rtp 的 jitter（秒），取各 media stream 的最大值。
	gaugePeerUplinkJitter = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "sfu_peer_uplink_jitter_seconds", Help: "該連線上行抖動 jitter（秒）",
	}, peerLabels)
)

func updateMetrics(s *SFU) {
	names, peers, tracks := s.snapshot()
	gaugeRooms.Set(float64(len(names)))
	gaugePeers.Set(float64(peers))
	gaugeTracks.Set(float64(tracks))
}

// peerSample：上一輪取樣，用來把累積位元組換算成位元率。
type peerSample struct {
	t        time.Time
	room     string
	bytesIn  uint64
	bytesOut uint64
}

// peerStatsCollector：週期性對每個連線呼叫 pc.GetStats()，把逐連線品質指標餵給 Prometheus。
// last 同時保存上輪取樣（算差分）與 label（離線時刪 series）。只由單一 ticker goroutine 存取，免鎖。
type peerStatsCollector struct {
	node string
	last map[string]peerSample // key = peer 短 id
}

func newPeerStatsCollector(node string) *peerStatsCollector {
	return &peerStatsCollector{node: node, last: map[string]peerSample{}}
}

func (c *peerStatsCollector) collect(s *SFU) {
	now := time.Now()
	current := map[string]bool{}

	for _, ref := range s.peerRefs() {
		current[ref.id] = true
		report := ref.pc.GetStats()

		var bytesIn, bytesOut uint64 // 取自選定的 candidate-pair（傳輸層收/發）
		var rtt float64
		var pairScore uint64 // 挑「實際在用」的 pair：優先 nominated，其次流量最大者
		var uplinkLost int32
		var uplinkJitter float64

		for _, stat := range report {
			switch st := stat.(type) {
			case webrtc.InboundRTPStreamStats: // 逐 media stream 的上行品質
				uplinkLost += st.PacketsLost
				if st.Jitter > uplinkJitter {
					uplinkJitter = st.Jitter
				}
			case webrtc.ICECandidatePairStats: // 傳輸層收發量 + RTT
				if st.State != webrtc.StatsICECandidatePairStateSucceeded {
					continue
				}
				score := st.BytesReceived + st.BytesSent
				if st.Nominated {
					score = ^uint64(0) // nominated 一定優先
				}
				if score >= pairScore {
					pairScore = score
					bytesIn, bytesOut, rtt = st.BytesReceived, st.BytesSent, st.CurrentRoundTripTime
				}
			}
		}

		// 位元率 =（本輪位元組 − 上輪位元組）× 8 ÷ 間隔秒數
		if prev, ok := c.last[ref.id]; ok {
			if dt := now.Sub(prev.t).Seconds(); dt > 0 {
				gaugePeerUplinkBps.WithLabelValues(c.node, ref.room, ref.id).Set(deltaBps(bytesIn, prev.bytesIn, dt))
				gaugePeerDownlinkBps.WithLabelValues(c.node, ref.room, ref.id).Set(deltaBps(bytesOut, prev.bytesOut, dt))
			}
		}
		gaugePeerUplinkLost.WithLabelValues(c.node, ref.room, ref.id).Set(float64(uplinkLost))
		gaugePeerUplinkJitter.WithLabelValues(c.node, ref.room, ref.id).Set(uplinkJitter)
		if rtt > 0 { // STUN 首次量到前為 0，先不報，避免誤判成「RTT 0ms」
			gaugePeerRTT.WithLabelValues(c.node, ref.room, ref.id).Set(rtt)
		}

		c.last[ref.id] = peerSample{t: now, room: ref.room, bytesIn: bytesIn, bytesOut: bytesOut}
	}

	// 清理：上輪有、這輪不在了的 peer → 刪掉它所有 label series（控制基數）
	for id, prev := range c.last {
		if !current[id] {
			c.deletePeer(prev.room, id)
			delete(c.last, id)
		}
	}
}

func (c *peerStatsCollector) deletePeer(room, id string) {
	for _, v := range []*prometheus.GaugeVec{
		gaugePeerUplinkBps, gaugePeerDownlinkBps, gaugePeerRTT,
		gaugePeerUplinkLost, gaugePeerUplinkJitter,
	} {
		v.DeleteLabelValues(c.node, room, id)
	}
}

// deltaBps：把位元組差分換成 bit/s；計數器若回繞（理論上不會）就回 0。
func deltaBps(cur, prev uint64, dt float64) float64 {
	if cur < prev {
		return 0
	}
	return float64(cur-prev) * 8 / dt
}
