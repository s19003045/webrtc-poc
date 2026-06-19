import { useCallback, useEffect, useRef, useState } from 'react';
import { PeerManager } from '../lib/PeerManager';
import type { ChatMessage, Participant } from '../types';

function makeId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

// 把命令式的 PeerManager 接到 React 宣告式狀態：
// PeerManager 透過 callbacks 推送變化，這裡轉成 useState 觸發重新渲染。
export function useRoom() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [myId, setMyId] = useState('');
  const [status, setStatus] = useState('尚未連線');
  const [log, setLog] = useState<string[]>([]);
  const managerRef = useRef<PeerManager | null>(null);

  const join = useCallback((roomId: string, localStream: MediaStream) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const manager = new PeerManager(roomId, localStream, url, {
      onParticipantsChange: setParticipants,
      onChatMessage: (from, text) =>
        setMessages((m) => [...m, { id: makeId(), from, text, self: false }]),
      onJoined: setMyId,
      onStatus: setStatus,
      onLog: (line) => setLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${line}`]),
    });
    manager.connect();
    managerRef.current = manager;
  }, []);

  const sendMessage = useCallback((text: string) => {
    managerRef.current?.sendChat(text);
    setMessages((m) => [...m, { id: makeId(), from: '我', text, self: true }]);
  }, []);

  const replaceVideoTrack = useCallback((track: MediaStreamTrack) => {
    managerRef.current?.replaceVideoTrack(track);
  }, []);

  const leave = useCallback(() => {
    managerRef.current?.close();
    managerRef.current = null;
    setParticipants([]);
    setMyId('');
    setStatus('已掛斷');
  }, []);

  // 元件卸載時確保連線關閉
  useEffect(() => () => managerRef.current?.close(), []);

  return { participants, messages, myId, status, log, join, leave, sendMessage, replaceVideoTrack };
}
