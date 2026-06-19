import type { Participant } from '../types';

interface Props {
  myId: string;
  participants: Participant[];
}

function short(id: string): string {
  return id.slice(0, 6);
}

// 成員列表 + 連線數。連線數 = 本機維持的連線（N-1），讓 mesh 的 N² 成本可視化。
export function ParticipantList({ myId, participants }: Props) {
  return (
    <section className="participants">
      <h2>
        成員 <span className="badge">{participants.length} 條連線</span>
      </h2>
      <ul>
        <li className="me">我（{short(myId)}）</li>
        {participants.map((p) => (
          <li key={p.id}>
            對方（{short(p.id)}）· {p.connectionState}
          </li>
        ))}
      </ul>
    </section>
  );
}
