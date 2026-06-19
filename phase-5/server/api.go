package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"strconv"

	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// buildAPI 建立 Pion 的 *webrtc.API。
//
// 為什麼需要這層設定（而不是用 webrtc.NewPeerConnection 預設）：
// SFU 的伺服器要直接跟 client 交換 RTP(UDP)。預設 Pion 會用「臨時 UDP 埠」+
// 「容器內部 IP」當候選位址——放進 Docker 後外部根本連不到。因此：
//   - UDP_PORT   ：把 ICE 綁在「固定 UDP 埠」，Docker 才能對外發布這個媒體埠
//   - NAT1TO1_IP ：告訴 Pion 對外要用「可達的 IP」當候選（取代容器內 IP）
//
// 兩者都沒設時就是一般本機開發（go run）行為，用臨時埠 + 本機候選。
func buildAPI() (*webrtc.API, error) {
	// 註冊預設 codec 與 interceptor（自訂 SettingEngine 時這些不會自動帶入）
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, err
	}

	se := webrtc.SettingEngine{}

	if portStr := os.Getenv("UDP_PORT"); portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return nil, fmt.Errorf("invalid UDP_PORT %q: %w", portStr, err)
		}
		udpListener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: port})
		if err != nil {
			return nil, fmt.Errorf("listen udp :%d: %w", port, err)
		}
		mux := webrtc.NewICEUDPMux(logging.NewDefaultLoggerFactory().NewLogger("ice-udp-mux"), udpListener)
		se.SetICEUDPMux(mux)
		log.Printf("ICE 固定 UDP 埠：%d", port)
	}

	if natIP := os.Getenv("NAT1TO1_IP"); natIP != "" {
		se.SetNAT1To1IPs([]string{natIP}, webrtc.ICECandidateTypeHost)
		log.Printf("對外發布 IP（NAT 1-to-1）：%s", natIP)
	}

	return webrtc.NewAPI(
		webrtc.WithMediaEngine(m),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	), nil
}
