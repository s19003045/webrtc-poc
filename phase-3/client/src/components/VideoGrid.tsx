import { useState } from 'react';
import { VideoTile } from './VideoTile';
import type { Participant } from '../types';

interface Props {
  localStream: MediaStream | null;
  participants: Participant[];
  myId: string;
}

function short(id: string): string {
  return id.slice(0, 6);
}

// 視訊格線：本機 + 每位參與者各一格。
// 點選任一格 → spotlight 放大；spotlightId === 'local' 代表放大自己。
export function VideoGrid({ localStream, participants, myId }: Props) {
  const [spotlightId, setSpotlightId] = useState<string | null>(null);

  const toggle = (id: string) => setSpotlightId((cur) => (cur === id ? null : id));

  return (
    <div className={`video-grid${spotlightId ? ' has-spotlight' : ''}`}>
      <VideoTile
        stream={localStream}
        label={`我（${short(myId)}）`}
        muted
        spotlight={spotlightId === 'local'}
        onSpotlight={() => toggle('local')}
      />
      {participants.map((p) => (
        <VideoTile
          key={p.id}
          stream={p.stream}
          label={`對方（${short(p.id)}）· ${p.connectionState}`}
          spotlight={spotlightId === p.id}
          onSpotlight={() => toggle(p.id)}
        />
      ))}
    </div>
  );
}
