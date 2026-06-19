package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Prometheus 指標：節點上的房間數、總連線數、轉發中的 track 數。
// 由 /metrics 端點輸出，給 Prometheus 抓取、Grafana 畫圖。
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
)

func updateMetrics(s *SFU) {
	names, peers, tracks := s.snapshot()
	gaugeRooms.Set(float64(len(names)))
	gaugePeers.Set(float64(peers))
	gaugeTracks.Set(float64(tracks))
}
