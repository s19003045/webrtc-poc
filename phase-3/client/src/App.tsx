import { useRef, useState } from 'react';
import { useLocalMedia } from './hooks/useLocalMedia';
import { useRoom } from './hooks/useRoom';
import { Controls } from './components/Controls';
import { VideoGrid } from './components/VideoGrid';
import { ParticipantList } from './components/ParticipantList';
import { ChatPanel } from './components/ChatPanel';

export default function App() {
  const [room, setRoom] = useState('test');
  const [joined, setJoined] = useState(false);
  const [sharing, setSharing] = useState(false);

  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const media = useLocalMedia();
  const room$ = useRoom();

  const handleJoin = async () => {
    try {
      const stream = await media.start();
      cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
      room$.join(room.trim() || 'default', stream);
      setJoined(true);
    } catch {
      // 失敗訊息已存在 media.error
    }
  };

  const handleLeave = () => {
    if (sharing) stopScreen();
    room$.leave();
    media.stop();
    setJoined(false);
  };

  // 本機預覽切換成指定的 video 軌（鏡頭 ↔ 螢幕）
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
      room$.replaceVideoTrack(track); // 換掉送給每個 peer 的 video 軌
      swapLocalPreview(track); // 本機預覽也跟著顯示螢幕
      track.onended = () => stopScreen(); // 從瀏覽器原生 UI 停止分享時自動切回
      setSharing(true);
    } catch {
      // 使用者取消分享
    }
  };

  const stopScreen = () => {
    const cam = cameraTrackRef.current;
    if (cam) {
      room$.replaceVideoTrack(cam);
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

  return (
    <div className="app">
      <header>
        <h1>WebRTC Phase 3 — React + TypeScript</h1>
        <p className="hint">
          開多個分頁、輸入相同房間名稱加入即可多人通話（mesh，上限 6 人）。點一下畫面可放大，雙擊進全螢幕。
        </p>
      </header>

      <Controls
        room={room}
        onRoomChange={setRoom}
        joined={joined}
        status={room$.status}
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

      <div className="layout">
        <VideoGrid localStream={media.stream} participants={room$.participants} myId={room$.myId} />
        <aside className="sidebar">
          <ParticipantList myId={room$.myId} participants={room$.participants} />
          <ChatPanel messages={room$.messages} onSend={room$.sendMessage} disabled={!joined} />
        </aside>
      </div>

      <section className="log">
        <h2>連線流程紀錄</h2>
        <pre>{room$.log.join('\n')}</pre>
      </section>
    </div>
  );
}
