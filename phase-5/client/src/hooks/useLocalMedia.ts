import { useCallback, useState } from 'react';

// 取得本機鏡頭/麥克風，與靜音、關鏡頭開關（沿用 Phase 3 的作法）。
export function useLocalMedia() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const start = useCallback(async (): Promise<MediaStream> => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStream(s);
      setAudioEnabled(true);
      setVideoEnabled(true);
      setError(null);
      return s;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);

  const toggleAudio = useCallback(() => {
    const track = stream?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setAudioEnabled(track.enabled);
    }
  }, [stream]);

  const toggleVideo = useCallback(() => {
    const track = stream?.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setVideoEnabled(track.enabled);
    }
  }, [stream]);

  const stop = useCallback(() => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
  }, [stream]);

  return { stream, error, audioEnabled, videoEnabled, start, stop, toggleAudio, toggleVideo };
}
