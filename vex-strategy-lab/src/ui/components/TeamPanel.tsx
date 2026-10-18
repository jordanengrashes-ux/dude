import { useState } from 'react';
import { PUBLIC_ROOM, team, useTeam } from '../../net/session';
import { DriversCard } from './DriversCard';
import { store } from '../store';

/** The player's name (saved in this browser), e.g. "Player-K7Q". */
export function savedPlayerName(): string {
  try {
    let n = localStorage.getItem('vsl-name');
    if (!n) {
      n = `Player-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      localStorage.setItem('vsl-name', n);
    }
    return n;
  } catch {
    return 'Player';
  }
}

/** Link that joins this room (the public game: the site itself). */
export function inviteLink(room: string): string {
  const u = new URL(window.location.href);
  u.search = '';
  if (room !== PUBLIC_ROOM) u.searchParams.set('room', room);
  return u.href;
}

/** Team mode lobby: create or join a room; players replace bots. */
export function TeamPanel() {
  const t = useTeam();
  const [name, setName] = useState(savedPlayerName);
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
          Everyone who opens the site joins one shared public game — in Practice too, nothing to create (if you're practicing when someone joins, the app switches to a match for both of you). When the public game is full you can watch it or start a private game: its invite link brings your friends in. Every robot is driven by its bot until a player takes it: a joining player replaces a bot (your partner first) and the match starts; when they leave, the bot takes the robot back and replans from where things stand. Press W A S D on the field to drive your own robot in 3rd person. Robots run their autonomous programs during Autonomous; drivers take over at Driver Control.
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
              {t.room === PUBLIC_ROOM ? <strong>Public game</strong> : <>Private room <strong style={{ letterSpacing: '0.12em' }}>{t.room}</strong></>} · {t.transport === 'online' ? 'online' : 'this browser'} · you are the {t.role}
            </div>
            <div className="row">
              <input aria-label="Invite link" readOnly value={inviteLink(t.room ?? '')} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
              <button onClick={() => navigator.clipboard?.writeText(inviteLink(t.room ?? ''))}>Copy invite link</button>
            </div>
            <div className="row">
              {t.room === PUBLIC_ROOM ? (
                <button onClick={() => void s?.goPrivate(name || 'Host')} title="A new room of your own: send its invite link to friends">
                  Start a private game
                </button>
              ) : (
                <button onClick={() => void s?.leave().then(() => s?.autoStart(name || 'Player', null))} title="Back to the game everyone shares">
                  Join the public game
                </button>
              )}
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
