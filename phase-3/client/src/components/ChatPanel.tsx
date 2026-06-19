import { useState } from 'react';
import type { ChatMessage } from '../types';

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled: boolean;
}

// 聊天面板：訊息走 DataChannel（P2P，不經伺服器）。
export function ChatPanel({ messages, onSend, disabled }: Props) {
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <section className="chat">
      <h2>聊天（DataChannel）</h2>
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg${m.self ? ' self' : ''}`}>
            <span className="who">{m.self ? '我' : m.from}</span>
            {m.text}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <input
          type="text"
          value={text}
          placeholder="輸入訊息…"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button disabled={disabled} onClick={submit}>
          送出
        </button>
      </div>
    </section>
  );
}
