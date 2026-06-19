import { useEffect, useRef } from 'react';

interface Props {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  spotlight?: boolean;
  onSpotlight?: () => void;
}

// 單一視訊格：點一下放大、雙擊全螢幕（與 Phase 3 相同）。
export function VideoTile({ stream, label, muted = false, spotlight = false, onSpotlight }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  const handleDoubleClick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void videoRef.current?.requestFullscreen();
  };

  return (
    <div
      className={`video-tile${spotlight ? ' spotlight' : ''}`}
      onClick={onSpotlight}
      onDoubleClick={handleDoubleClick}
    >
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      <span className="label">{label}</span>
    </div>
  );
}
