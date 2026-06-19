interface Props {
  room: string;
  onRoomChange: (value: string) => void;
  joined: boolean;
  status: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  sharing: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleScreen: () => void;
}

export function Controls(p: Props) {
  return (
    <section className="controls">
      <input
        type="text"
        value={p.room}
        placeholder="房間名稱"
        disabled={p.joined}
        onChange={(e) => p.onRoomChange(e.target.value)}
      />
      {!p.joined ? (
        <button onClick={p.onJoin}>加入通話</button>
      ) : (
        <>
          <button className={p.audioEnabled ? '' : 'active'} onClick={p.onToggleAudio}>
            {p.audioEnabled ? '🎤 靜音' : '🔇 解除靜音'}
          </button>
          <button className={p.videoEnabled ? '' : 'active'} onClick={p.onToggleVideo}>
            {p.videoEnabled ? '📷 關鏡頭' : '📷 開鏡頭'}
          </button>
          <button className={p.sharing ? 'active' : ''} onClick={p.onToggleScreen}>
            {p.sharing ? '🖥️ 停止分享' : '🖥️ 分享螢幕'}
          </button>
          <button className="danger" onClick={p.onLeave}>
            掛斷
          </button>
        </>
      )}
      <span className="status">{p.status}</span>
    </section>
  );
}
