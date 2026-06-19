import { useCallback, useEffect, useRef, useState } from 'react';
import { SfuClient } from '../lib/SfuClient';

// 把命令式的 SfuClient 接到 React 宣告式狀態。
export function useSfuRoom() {
  const [remoteStreams, setRemoteStreams] = useState<MediaStream[]>([]);
  const [status, setStatus] = useState('尚未連線');
  const [log, setLog] = useState<string[]>([]);
  const clientRef = useRef<SfuClient | null>(null);

  const join = useCallback((roomId: string, localStream: MediaStream) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const client = new SfuClient(roomId, localStream, url, {
      onRemoteStreamsChange: setRemoteStreams,
      onStatus: setStatus,
      onLog: (line) => setLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${line}`]),
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
    setStatus('已掛斷');
  }, []);

  useEffect(() => () => clientRef.current?.close(), []);

  return { remoteStreams, status, log, join, leave, replaceVideoTrack };
}
