// ─────────────────────────────────────────────────────────────────────────────
// PeerManager — 命令式的 WebRTC + 信令引擎（框架無關的純 TypeScript class）
//
// 這是 Phase 2 client.js 的型別化重構：把所有 RTCPeerConnection、信令收發、
// DataChannel、多連線管理都封裝在這裡。React 端不直接碰這些副作用，只透過
// callbacks 訂閱「參與者快照 / 聊天訊息 / 狀態」來宣告式渲染。
//
// 多人 mesh 規則同 Phase 2：後加入者對每個既有成員主動發 offer（避免 glare）。
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ClientMessage,
  Participant,
  ServerMessage,
  SignalData,
} from '../types';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // 跨網際網路 / 嚴格 NAT 時改用自架 coturn：
    // { urls: 'turn:YOUR_TURN_HOST:3478', username: 'user', credential: 'pass' },
  ],
};

function short(id: string): string {
  return id.slice(0, 6);
}

interface PeerEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
}

export interface PeerManagerCallbacks {
  /** 參與者清單有任何變動（新增/移除/收到串流/連線狀態改變）時觸發 */
  onParticipantsChange: (participants: Participant[]) => void;
  onChatMessage: (from: string, text: string) => void;
  onJoined: (myId: string) => void;
  onStatus: (status: string) => void;
  onLog?: (line: string) => void;
}

export class PeerManager {
  private ws: WebSocket | null = null;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly pending = new Map<string, RTCIceCandidateInit[]>();

  constructor(
    private readonly roomId: string,
    private readonly localStream: MediaStream,
    private readonly signalingUrl: string,
    private readonly cb: PeerManagerCallbacks,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.signalingUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.log(`已連上信令伺服器，加入房間：${this.roomId}`);
      this.send({ type: 'join', room: this.roomId });
    };
    ws.onmessage = (ev) => {
      void this.onMessage(JSON.parse(ev.data as string) as ServerMessage);
    };
    ws.onclose = () => this.log('信令連線關閉');
    ws.onerror = () => this.log('⚠️ 信令連線錯誤');
  }

  sendChat(text: string): void {
    for (const { dc } of this.peers.values()) {
      if (dc && dc.readyState === 'open') dc.send(text);
    }
  }

  /** 螢幕分享：把每條連線送出的 video 軌即時換掉，不需重新協商 */
  replaceVideoTrack(track: MediaStreamTrack): void {
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      void sender?.replaceTrack(track);
    }
  }

  close(): void {
    for (const { pc } of this.peers.values()) pc.close();
    this.peers.clear();
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
    this.emit();
  }

  // ── 信令分派 ──────────────────────────────────────────────────────────────
  private async onMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case 'joined':
        this.cb.onJoined(msg.id);
        this.log(`已加入，ID ${short(msg.id)}，房內既有 ${msg.peers.length} 人`);
        if (msg.peers.length === 0) this.cb.onStatus('等待對方加入…');
        // 我是後到者 → 對每個既有成員主動發 offer
        for (const peerId of msg.peers) await this.callPeer(peerId);
        break;
      case 'peer-joined':
        this.log(`🟢 ${short(msg.id)} 加入`);
        break;
      case 'signal':
        await this.handleSignal(msg.from, msg.data);
        break;
      case 'peer-left':
        this.log(`👋 ${short(msg.id)} 離開`);
        this.removePeer(msg.id);
        break;
      case 'full':
        this.cb.onStatus('房間已滿');
        break;
    }
  }

  // ── 對某個 peer 建立連線 ──────────────────────────────────────────────────
  private createPeerConnection(peerId: string, isInitiator: boolean): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry: PeerEntry = {
      pc,
      dc: null,
      stream: null,
      connectionState: pc.connectionState,
    };
    this.peers.set(peerId, entry);
    this.pending.set(peerId, []);

    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.send({ type: 'signal', to: peerId, data: { candidate: e.candidate.toJSON() } });
      }
    };
    pc.ontrack = (e) => {
      entry.stream = e.streams[0] ?? null;
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      entry.connectionState = pc.connectionState;
      this.log(`與 ${short(peerId)} 的連線：${pc.connectionState}`);
      this.updateStatus();
      this.emit();
    };

    if (isInitiator) {
      this.setupDataChannel(peerId, pc.createDataChannel('chat'));
    } else {
      pc.ondatachannel = (e) => this.setupDataChannel(peerId, e.channel);
    }

    this.emit();
    return pc;
  }

  private setupDataChannel(peerId: string, dc: RTCDataChannel): void {
    const entry = this.peers.get(peerId);
    if (entry) entry.dc = dc;
    dc.onmessage = (e) => this.cb.onChatMessage(short(peerId), e.data as string);
  }

  private async callPeer(peerId: string): Promise<void> {
    const pc = this.createPeerConnection(peerId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: 'signal', to: peerId, data: { sdp: offer } });
    this.log(`→ 對 ${short(peerId)} 送出 offer`);
  }

  private async handleSignal(from: string, data: SignalData): Promise<void> {
    if ('sdp' in data) {
      let entry = this.peers.get(from);
      // 收到 offer 但還沒有連線 → 我是接話方，補建立
      if (!entry && data.sdp.type === 'offer') {
        this.createPeerConnection(from, false);
        entry = this.peers.get(from);
      }
      if (!entry) return;
      const { pc } = entry;

      await pc.setRemoteDescription(data.sdp);
      this.log(`← 收到 ${short(from)} 的 ${data.sdp.type}`);

      for (const c of this.pending.get(from) ?? []) await pc.addIceCandidate(c);
      this.pending.set(from, []);

      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ type: 'signal', to: from, data: { sdp: answer } });
        this.log(`→ 對 ${short(from)} 送出 answer`);
      }
    } else {
      const entry = this.peers.get(from);
      if (entry && entry.pc.remoteDescription) {
        await entry.pc.addIceCandidate(data.candidate);
      } else {
        // remoteDescription 還沒設好，先排隊（per-peer 避坑）
        const q = this.pending.get(from) ?? [];
        q.push(data.candidate);
        this.pending.set(from, q);
      }
    }
  }

  private removePeer(peerId: string): void {
    this.peers.get(peerId)?.pc.close();
    this.peers.delete(peerId);
    this.pending.delete(peerId);
    this.emit();
  }

  // ── 內部工具 ──────────────────────────────────────────────────────────────
  private emit(): void {
    this.cb.onParticipantsChange(this.snapshot());
  }

  private snapshot(): Participant[] {
    return [...this.peers.entries()].map(([id, e]) => ({
      id,
      stream: e.stream,
      connectionState: e.connectionState,
    }));
  }

  private updateStatus(): void {
    const states = [...this.peers.values()].map((e) => e.connectionState);
    if (states.includes('connected')) this.cb.onStatus('通話中');
    else if (states.includes('connecting')) this.cb.onStatus('連線中…');
  }

  private send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private log(line: string): void {
    this.cb.onLog?.(line);
  }
}
