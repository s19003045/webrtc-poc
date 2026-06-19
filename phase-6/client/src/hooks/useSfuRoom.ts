import { useCallback, useEffect, useRef, useState } from 'react';
import { SfuClient } from '../lib/SfuClient';
import type { RouteResponse } from '../types';

// 把命令式的 SfuClient 接到 React 宣告式狀態。
export function useSfuRoom() {
  const [remoteStreams, setRemoteStreams] = useState<MediaStream[]>([]);
  const [status, setStatus] = useState('尚未連線');
  const [node, setNode] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const clientRef = useRef<SfuClient | null>(null);

  const pushLog = (line: string) =>
    setLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${line}`]);

  // Phase 6：先問 Router「這個房間在哪個 SFU 節點」，拿到 url + token 再連線。
  const join = useCallback(async (roomId: string, localStream: MediaStream) => {
    setStatus('查詢路由…');
    const res = await fetch(`/api/route?room=${encodeURIComponent(roomId)}`);
    if (!res.ok) {
      setStatus('沒有可用的 SFU 節點');
      pushLog(`⛔ Router 路由失敗（${res.status}）`);
      return;
    }
    const route = (await res.json()) as RouteResponse;
    setNode(route.node);
    pushLog(`🧭 Router 指派房間 ${roomId} → 節點 ${route.node}（${route.url}）`);

    const client = new SfuClient(roomId, localStream, route.url, route.token, {
      onRemoteStreamsChange: setRemoteStreams,
      onStatus: setStatus,
      onLog: pushLog,
    });
    client.connect();
    clientRef.current = client;
  }, []);

  const replaceVideoTrack = useCallback((track: MediaStreamTrack) => {
    clientRef.current?.replaceVideoTrack(track);
  }, []);

  const leave = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    setRemoteStreams([]);
    setNode('');
    setStatus('已掛斷');
  }, []);

  useEffect(() => () => clientRef.current?.close(), []);

  return { remoteStreams, status, node, log, join, leave, replaceVideoTrack };
}
