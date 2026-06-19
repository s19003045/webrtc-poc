import { useState } from 'react';
import { VideoTile } from './VideoTile';

interface Props {
  localStream: MediaStream | null;
  remoteStreams: MediaStream[];
}

// SFU 的視訊格線：本機一格 + 每一路「伺服器轉發下來的遠端串流」各一格。
// 注意這裡 remoteStreams 是從伺服器來的（不像 mesh 是直接 P2P）。
export function VideoGrid({ localStream, remoteStreams }: Props) {
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const toggle = (id: string) => setSpotlightId((cur) => (cur === id ? null : id));

  return (
    <div className={`video-grid${spotlightId ? ' has-spotlight' : ''}`}>
      <VideoTile
        stream={localStream}
        label="我（本機）"
        muted
        spotlight={spotlightId === 'local'}
        onSpotlight={() => toggle('local')}
      />
      {remoteStreams.map((s, i) => (
        <VideoTile
          key={s.id}
          stream={s}
          label={`參與者 ${i + 1}`}
          spotlight={spotlightId === s.id}
          onSpotlight={() => toggle(s.id)}
        />
      ))}
    </div>
  );
}
