// SFU 信令協議（伺服器當 offerer）。
// client → server：join / answer / candidate
// server → client：offer / candidate

export type ClientMessage =
  | { type: 'join'; room: string }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

export type ServerMessage =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };
