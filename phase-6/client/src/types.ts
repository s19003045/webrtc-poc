// SFU 信令協議（伺服器當 offerer）。Phase 6 在 join 多帶 Router 簽發的 token。
// client → server：join(+token) / answer / candidate
// server → client：offer / candidate / error

export type ClientMessage =
  | { type: 'join'; room: string; token: string }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

export type ServerMessage =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | { type: 'error'; error: string };

// Router /api/route 的回應：要連哪個 SFU 節點、入會 token、節點代號。
export interface RouteResponse {
  url: string;
  node: string;
  token: string;
}
