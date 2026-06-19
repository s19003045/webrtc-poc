// ─────────────────────────────────────────────────────────────────────────────
// 信令協議型別（對應後端 server/server.js）
// 用 TypeScript 把整套 client ↔ server 訊息明確定型，避免拼錯欄位。
// ─────────────────────────────────────────────────────────────────────────────

/** 信令攜帶的內容：不是 SDP（offer/answer）就是 ICE candidate */
export type SignalData =
  | { sdp: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit };

// ── client → server ──
export interface JoinMessage {
  type: 'join';
  room: string;
}
export interface ClientSignalMessage {
  type: 'signal';
  to: string;
  data: SignalData;
}
export type ClientMessage = JoinMessage | ClientSignalMessage;

// ── server → client ──
export interface JoinedMessage {
  type: 'joined';
  id: string;
  peers: string[];
}
export interface PeerJoinedMessage {
  type: 'peer-joined';
  id: string;
}
export interface ServerSignalMessage {
  type: 'signal';
  from: string;
  data: SignalData;
}
export interface PeerLeftMessage {
  type: 'peer-left';
  id: string;
}
export interface FullMessage {
  type: 'full';
}
export type ServerMessage =
  | JoinedMessage
  | PeerJoinedMessage
  | ServerSignalMessage
  | PeerLeftMessage
  | FullMessage;

// ── UI 用的領域型別 ──
export interface Participant {
  id: string;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
}
export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  self: boolean;
}
