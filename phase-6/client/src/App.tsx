import { useRef, useState } from 'react';
import { useLocalMedia } from './hooks/useLocalMedia';
import { useSfuRoom } from './hooks/useSfuRoom';
import { Controls } from './components/Controls';
import { VideoGrid } from './components/VideoGrid';

export default function App() {
  const [room, setRoom] = useState('test');
  const [joined, setJoined] = useState(false);
  const [sharing, setSharing] = useState(false);

  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const media = useLocalMedia();
  const sfu = useSfuRoom();

  const handleJoin = async () => {
    try {
      const stream = await media.start();
      cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
      await sfu.join(room.trim() || 'default', stream);
      setJoined(true);
    } catch {
      // 失敗訊息已存在 media.error
    }
  };

  const handleLeave = () => {
    if (sharing) stopScreen();
    sfu.leave();
    media.stop();
    setJoined(false);
  };

  const swapLocalPreview = (track: MediaStreamTrack) => {
    const stream = media.stream;
    if (!stream) return;
    stream.getVideoTracks().forEach((t) => {
      if (t !== track) stream.removeTrack(t);
    });
    if (!stream.getVideoTracks().includes(track)) stream.addTrack(track);
  };

  const startScreen = async () => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = screen;
      const track = screen.getVideoTracks()[0];
      sfu.replaceVideoTrack(track); // 換掉上傳到 SFU 的 video 軌
      swapLocalPreview(track);
      track.onended = () => stopScreen();
      setSharing(true);
    } catch {
      // 使用者取消
    }
  };

  const stopScreen = () => {
    const cam = cameraTrackRef.current;
    if (cam) {
      sfu.replaceVideoTrack(cam);
      swapLocalPreview(cam);
    }
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setSharing(false);
  };

  const toggleScreen = () => {
    if (sharing) stopScreen();
    else void startScreen();
  };

  const participantCount = (joined ? 1 : 0) + sfu.remoteStreams.length;

  return (
    <div className="app">
      <header>
        <h1>WebRTC Phase 6 — 多節點 SFU 叢集</h1>
        <p className="hint">
          先由 Router 用 Redis 把房間指派到某個 SFU 節點（房間親和性），再連到該節點。
          多房間會分散到多個節點以水平擴展。開多個分頁、相同房間名稱加入即可。
        </p>
      </header>

      <Controls
        room={room}
        onRoomChange={setRoom}
        joined={joined}
        status={sfu.status}
        audioEnabled={media.audioEnabled}
        videoEnabled={media.videoEnabled}
        sharing={sharing}
        onJoin={handleJoin}
        onLeave={handleLeave}
        onToggleAudio={media.toggleAudio}
        onToggleVideo={media.toggleVideo}
        onToggleScreen={toggleScreen}
      />

      {media.error && <p className="error">無法取得鏡頭/麥克風：{media.error}</p>}

      <p className="meta">
        房內人數：<strong>{participantCount}</strong>
        　｜　我上傳：<strong>1 路</strong>
        　｜　從 SFU 下載：<strong>{sfu.remoteStreams.length} 路</strong>
        {sfu.node && <>　｜　SFU 節點：<strong>{sfu.node}</strong></>}
      </p>

      <VideoGrid localStream={media.stream} remoteStreams={sfu.remoteStreams} />

      <section className="log">
        <h2>連線流程紀錄</h2>
        <pre>{sfu.log.join('\n')}</pre>
      </section>
    </div>
  );
}
