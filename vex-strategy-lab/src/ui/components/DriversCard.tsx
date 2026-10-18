import { useEffect, useState } from 'react';
import { runner } from '../simRunner';
import { ACTIONS, keyName, localInput, padName, type ActionId, type PadLayout } from '../input';
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
  // robots on the field (practice has only yours)
  const onField = new Set(runner.sim?.robots.map((r) => r.id) ?? []);
  const slots = useApp((s) => s.slots).filter((s) => s.enabled && (t.role === 'guest' || onField.has(s.slot)));
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
      <ControlsEditor pad={pad} />
    </div>
  );
}

/** Every action with its two keys and controller button; click one and press the new key / button. */
function ControlsEditor({ pad }: { pad: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => localInput.onBindings(() => tick((x) => x + 1)), []);
  useEffect(() => () => localInput.startCapture(null), []);
  const b = localInput.bindings;
  const cap = localInput.capture;
  const cell = (action: ActionId, which: 0 | 1 | 'pad') => {
    const waiting = cap !== null && cap.action === action && (which === 'pad' ? cap.kind === 'pad' : cap.kind === 'key' && cap.slot === which);
    const bound = which === 'pad' ? b.pad[action] !== null : b.keys[action][which] !== null;
    const name = which === 'pad' ? padName(b.pad[action]) : keyName(b.keys[action][which]);
    return (
      <td>
        <button
          className={`bind${waiting ? ' waiting' : ''}${bound ? '' : ' unbound'}`}
          title={waiting ? 'Esc cancels · Delete clears' : 'Click, then press the new ' + (which === 'pad' ? 'controller button' : 'key')}
          onClick={(e) => {
            e.currentTarget.blur(); // Space / Enter must not click it again
            localInput.startCapture(waiting ? null : which === 'pad' ? { kind: 'pad', action } : { kind: 'key', action, slot: which });
          }}
        >
          {waiting ? (which === 'pad' ? 'press a button…' : 'press a key…') : name}
        </button>
      </td>
    );
  };
  return (
    <details className="small controls">
      <summary>Controls (click one to change it)</summary>
      <table className="table small keys">
        <thead>
          <tr>
            <th>Action</th>
            <th>Key</th>
            <th>Key 2</th>
            <th>Controller</th>
          </tr>
        </thead>
        <tbody>
          {ACTIONS.map((a) => (
            <tr key={a.id}>
              <td>{a.label}</td>
              {cell(a.id, 0)}
              {cell(a.id, 1)}
              {cell(a.id, 'pad')}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row controls-foot">
        <label>
          Controller sticks{' '}
          <select value={b.padLayout} onChange={(e) => localInput.setPadLayout(e.target.value as PadLayout)}>
            <option value="split">Split: left stick drives, right stick turns</option>
            <option value="single">One stick: left stick drives and turns, right stick looks around</option>
          </select>
        </label>
        <button className="link" onClick={() => localInput.resetBindings()}>
          Reset to defaults
        </button>
      </div>
      <p className="muted">
        Mouse: click the field to lock the cursor to it — then moving the mouse looks around, left click opens / closes the claw, the right button
        runs the rollers in, and Esc frees the cursor; the wheel zooms (all the way in: first person). Triggers raise / lower the arm
        proportionally. {pad ? `Controller: ${pad.slice(0, 40)}.` : 'No controller connected (press any button on it).'} Saved in this browser.
      </p>
    </details>
  );
}
