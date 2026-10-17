import { useState } from 'react';
import { team, useTeam } from '../../net/session';
import { DriversCard } from './DriversCard';
import { store } from '../store';

/** Team mode lobby: create or join a room; players replace bots. */
export function TeamPanel() {
  const t = useTeam();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('vsl-name') ?? 'Player';
    } catch {
      return 'Player';
    }
  });
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'online' | 'local'>('online');
  const s = team.session;
  const saveName = (n: string) => {
    setName(n);
    try {
      localStorage.setItem('vsl-name', n);
    } catch {
      /* storage unavailable */
    }
  };
  const inRoom = t.role !== 'none';
  return (
    <div className="panel-grid">
      <section className="card">
        <h3>Team mode</h3>
        <p className="small">
          Every robot is driven by its bot until a player takes it. When someone joins your room they replace a bot (your partner first); when they leave, the bot takes the robot back and replans from where things stand. Robots run their autonomous programs during Autonomous; drivers take over at Driver Control.
        </p>
        {!inRoom ? (
          <>
            <div className="form-grid">
              <label className="field">
                <span>Your name</span>
                <input value={name} maxLength={20} onChange={(e) => saveName(e.target.value)} />
              </label>
              <label className="field">
                <span>Connection</span>
                <select value={kind} onChange={(e) => setKind(e.target.value as 'online' | 'local')}>
                  <option value="online">Online (Supabase Realtime)</option>
                  <option value="local">This browser only (other tabs)</option>
                </select>
              </label>
            </div>
            <div className="row">
              <button className="primary" disabled={t.connecting} onClick={() => void s?.host(name || 'Host', kind)}>
                Create room
              </button>
              <span className="muted small">or join:</span>
              <input aria-label="Room code" placeholder="Room code" value={code} maxLength={8} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: '8em' }} />
              <button disabled={t.connecting || code.length < 4} onClick={() => void s?.join(code, name || 'Player', kind).then(() => store.set({ tab: 'field' }))}>
                Join
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="status verified-optimum">
              Room <strong style={{ letterSpacing: '0.12em' }}>{t.room}</strong> · {t.transport === 'online' ? 'online' : 'this browser'} · you are the {t.role}
            </div>
            <div className="row">
              <button className="link" onClick={() => navigator.clipboard?.writeText(t.room ?? '')}>
                Copy code
              </button>
              <button onClick={() => void s?.leave()}>Leave room</button>
              <button className="primary" onClick={() => store.set({ tab: 'field' })}>
                Go to the field
              </button>
            </div>
            <h4>Players</h4>
            <ul className="small">
              {t.peers.map((p) => (
                <li key={p.peerId}>
                  {p.name} {p.peerId === t.me ? '(you)' : ''} — {p.role}
                </li>
              ))}
            </ul>
          </>
        )}
        {t.status && <p className="small">{t.status}</p>}
        {t.error && <p className="small error">Could not connect: {t.error}</p>}
        <p className="small muted">
          The host runs the physics and streams ~8 snapshots per second; guests send their controls. Online rooms use Supabase Realtime broadcast and presence (no data is stored). “This browser only” links tabs on this computer without a network.
        </p>
      </section>
      <DriversCard />
    </div>
  );
}
