import { useEffect, useState } from 'react';
import { runner } from '../simRunner';
import { localInput, KEY_HELP, PAD_HELP } from '../input';
import { team, useTeam } from '../../net/session';
import { useApp } from '../store';

/**
 * Who drives each robot: its bot, you (keyboard / gamepad), or a team-mode player.
 * Take over any robot; hand it back and its bot replans from the current field.
 */
export function DriversCard() {
  const [, tick] = useState(0);
  useEffect(() => runner.subscribe(() => tick((x) => x + 1)), []);
  const t = useTeam();
  const slots = useApp((s) => s.slots).filter((s) => s.enabled);
  const [pad, setPad] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setPad(localInput.gamepad), 1000);
    return () => clearInterval(id);
  }, []);
  const guest = t.role === 'guest';
  const label = (slot: string) => {
    if (guest) {
      const o = t.roster[slot];
      return o?.peerId ? (o.peerId === t.me ? 'You' : o.name) : 'Bot';
    }
    const d = runner.driverOf(slot);
    return d.kind === 'bot' ? 'Bot' : d.kind === 'local' ? 'You' : d.name;
  };
  const mine = (slot: string) => (guest ? t.roster[slot]?.peerId === t.me : runner.driverOf(slot).kind === 'local');
  const free = (slot: string) => (guest ? !t.roster[slot]?.peerId : runner.driverOf(slot).kind === 'bot');
  const take = (slot: string) => (t.role === 'none' ? runner.setDriver(slot, { kind: 'local', name: 'You' }) : team.claimSlot(slot));
  const release = (slot: string) => (t.role === 'none' ? runner.setDriver(slot, { kind: 'bot' }) : team.releaseSlot());
  return (
    <div className="card drivers">
      <h4>Drivers</h4>
      <table className="table small">
        <tbody>
          {slots.map((s) => (
            <tr key={s.slot}>
              <td>
                <span className={`dot ${s.alliance}`} /> {s.slot}
              </td>
              <td>{label(s.slot)}</td>
              <td style={{ textAlign: 'right' }}>
                {mine(s.slot) ? (
                  <button className="link" onClick={() => release(s.slot)}>
                    Hand back to bot
                  </button>
                ) : free(s.slot) ? (
                  <button className="link" onClick={() => take(s.slot)}>
                    Drive
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Robots run their autonomous programs during Autonomous; drivers take over in Driver Control (all match in Driver Skills).{' '}
        {pad ? <>Gamepad: {pad.slice(0, 32)}.</> : <>Connect a gamepad or use the keyboard.</>}
      </p>
      <details className="small">
        <summary>Controls</summary>
        <table className="table small keys">
          <tbody>
            {(pad ? PAD_HELP : KEY_HELP).map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
