// ─────────────────────────────────────────────────────────────────────────────
// SfuClient — 連到 SFU 的前端引擎
//
// 與前面 mesh 階段「最大的不同」：
//   • 只跟「伺服器」開一條 PeerConnection（不是對每個人各開一條）
//   • 只「上傳一路」自己的影音；其他人的影音由伺服器轉發下來
//   • 協商模型翻轉：「伺服器當 offerer」，client 只負責回 answer
//
// 所以這支比 mesh 的 PeerManager 簡單很多：收到 offer → 回 answer、收 candidate。
// ─────────────────────────────────────────────────────────────────────────────

import type { ClientMessage, ServerMessage } from '../types';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export interface SfuClientCallbacks {
  /** 目前收到的所有「遠端」串流（每個其他參與者一個）有變動時觸發 */
  onRemoteStreamsChange: (streams: MediaStream[]) => void;
  onStatus: (status: string) => void;
  onLog?: (line: string) => void;
}

export class SfuClient {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private readonly remoteStreams = new Map<string, MediaStream>();
  private pending: RTCIceCandidateInit[] = [];

  constructor(
    private readonly roomId: string,
    private readonly localStream: MediaStream,
    private readonly signalingUrl: string,
    private readonly token: string,
    private readonly cb: SfuClientCallbacks,
  ) {}

  connect(): void {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;

    // 上傳本機影音：只有「一路」往伺服器
    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }

    // 伺服器轉發下來的他人影音 → 依 stream 分組顯示
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream || this.remoteStreams.has(stream.id)) return;
      this.remoteStreams.set(stream.id, stream);
      this.log(`🎥 收到一路遠端串流（目前 ${this.remoteStreams.size} 路）`);
      this.emit();
      // 對方離開 / 停止 → 該 stream 的 track 被移除，清掉它的格子
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) {
          this.remoteStreams.delete(stream.id);
          this.log('👋 一路遠端串流結束');
          this.emit();
        }
      };
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'candidate', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      this.cb.onStatus(pc.connectionState === 'connected' ? '已連線 SFU' : pc.connectionState);
    };

    const ws = new WebSocket(this.signalingUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.log(`已連上 SFU，加入房間：${this.roomId}`);
      this.send({ type: 'join', room: this.roomId, token: this.token });
    };
    ws.onmessage = (ev) => void this.onMessage(JSON.parse(ev.data as string) as ServerMessage);
    ws.onclose = () => this.log('信令連線關閉');
    ws.onerror = () => this.log('⚠️ 信令連線錯誤');
  }

  private async onMessage(msg: ServerMessage): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    if (msg.type === 'offer') {
      // 伺服器發來 offer（初次協商，或有人加入/離開時重新協商）→ 回 answer
      await pc.setRemoteDescription(msg.sdp);
      for (const c of this.pending) await pc.addIceCandidate(c);
      this.pending = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ type: 'answer', sdp: answer });
      this.log('← 收到 offer，→ 回 answer');
    } else if (msg.type === 'candidate') {
      if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
      else this.pending.push(msg.candidate); // remoteDescription 還沒設好，先排隊
    } else if (msg.type === 'error') {
      this.log(`⛔ 伺服器拒絕：${msg.error}`);
      this.cb.onStatus(`錯誤：${msg.error}`);
    }
  }

  /** 螢幕分享：把上傳的 video 軌即時換掉，不需重新協商 */
  replaceVideoTrack(track: MediaStreamTrack): void {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video');
    void sender?.replaceTrack(track);
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
    this.ws?.close();
    this.ws = null;
    this.remoteStreams.clear();
    this.emit();
  }

  private emit(): void {
    this.cb.onRemoteStreamsChange([...this.remoteStreams.values()]);
  }

  private send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private log(line: string): void {
    this.cb.onLog?.(line);
  }
}
