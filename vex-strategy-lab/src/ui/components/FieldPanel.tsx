import { useEffect, useMemo, useState } from 'react';
import { IN } from '../../core/units';
import { upOf } from '../../physics/frames';
import { runner } from '../simRunner';
import { store, useApp, type CameraMode } from '../store';
import { Field3D } from './Field3D';
import { TopDown } from './TopDown';
import { DriversCard } from './DriversCard';
import { localInput } from '../input';
import { team, useTeam } from '../../net/session';
import { hudData } from '../../sim/frame';

/** Re-render on simulation progress: local physics steps, or team-mode snapshots for a guest. */
function useRunnerTick() {
  const [, set] = useState(0);
  useEffect(() => {
    let last = 0;
    const tick = () => {
      const now = performance.now();
      if (now - last > 90) {
        last = now;
        set((x) => x + 1);
      }
    };
    const a = runner.subscribe(tick);
    const b = team.session?.onSnap(tick);
    return () => {
      a();
      b?.();
    };
  }, []);
}

export function usePlanSteps() {
  const report = useApp((s) => s.report);
  const exec = useApp((s) => s.executePlan);
  return useMemo(() => {
    if (!report) return null;
    const id = exec ?? (report.recommended === 'best' ? report.best.id : report.practical.id);
    return (report.candidates.find((c) => c.id === id) ?? report.best).steps;
  }, [report, exec]);
}

function Hud() {
  useRunnerTick();
  const t = useTeam();
  const guest = t.role === 'guest';
  const sim = runner.sim;
  const h = guest ? (team.session?.hud ?? null) : sim ? hudData(sim) : null;
  if (!h) return <div className="hud muted">{guest ? 'Waiting for the host…' : runner.building ? 'Building simulation…' : (runner.error ?? 'No simulation')}</div>;
  return (
    <div className="hud" aria-live="polite">
      <div className="clock">
        <span className="period">{h.period}</span>
        <span className="time">{h.clock}</span>
        <span className="muted small">t = {h.t.toFixed(2)} s</span>
      </div>
      <div className="score red">
        <span className="label">Red</span>
        <span className="value">{h.totals.red}</span>
        {h.bonus && <span className="small muted">incl. Auto Bonus {h.bonus.red}</span>}
      </div>
      {h.headToHead && (
        <div className="score blue">
          <span className="label">Blue</span>
          <span className="value">{h.totals.blue}</span>
          {h.bonus && <span className="small muted">incl. Auto Bonus {h.bonus.blue}</span>}
        </div>
      )}
      <div className="own">
        <span className="small muted">Ownership</span>
        {(['R1', 'R2', 'B1', 'B2', 'midfield'] as const).map((q) => (
          <span key={q} className={`chip ${h.ownership[q] ?? 'none'}`}>
            {q === 'midfield' ? 'Mid' : q}: {h.ownership[q] ?? '—'}
          </span>
        ))}
      </div>
      {h.result && <div className="small">{h.result}</div>}
      <div className="small muted">
        {h.violations} violations · {h.collisions} collisions{t.role !== 'none' ? ` · team room ${t.room}` : ''}
      </div>
      {!guest && <PlanStatus />}
      <DriveHint period={h.period} t={h.t} />
    </div>
  );
}

/** What the player can do right now, the claw's state, and the aligner. */
function DriveHint({ period, t }: { period: string; t: number }) {
  const tm = useTeam();
  const guest = tm.role === 'guest';
  const mine = guest ? (team.session?.mySlot() ?? null) : runner.localSlot;
  if (!mine) return <div className="small muted">Press W A S D to drive your robot (3rd person).</div>;
  const playing = guest ? team.session?.hostPlaying : runner.playing;
  const auto = /auto/i.test(period);
  const practice = store.get().practice;
  const msg =
    !playing && t === 0
      ? guest
        ? 'waiting for the host to start the match.'
        : 'press P (or start driving) to start.'
      : auto && !practice
        ? 'Autonomous: its program runs; you take over at Driver Control.'
        : 'W A S D drive · Space / Shift arm up / down · click the claw.';
  const me = guest ? team.session?.frameAt()?.robots.find((r) => r.id === mine) : runner.sim?.sceneFrame().robots.find((r) => r.id === mine);
  const held = me ? [me.holding & 1 ? 'Pin' : null, me.holding & 2 ? 'Cup' : null].filter(Boolean).join(' + ') : '';
  const a = me?.align ?? null;
  const align = !a ? null : a.state === 2 ? `over ${a.goal}: open the claw` : a.state === 1 ? `lined up on ${a.goal}: raise the arm` : `line up over ${a.goal}`;
  return (
    <div className="small drive-hint">
      <div>
        You drive <strong>{mine}</strong> — {msg}
      </div>
      <div className="row claw-row">
        <span className={`claw-chip ${me?.claw ? 'closed' : 'open'}`} title="Left click or C opens / closes the claw">
          Claw {me?.claw ? 'closed' : 'open'}
          {held ? ` · holding ${held}` : ''}
        </span>
        {align && <span className={`align-chip s${a!.state}`}>{align}</span>}
        <label className="easy" title="The claw grabs whatever you drive into, and Goals catch your drops more easily (G)">
          <input type="checkbox" checked={localInput.state.easy} onChange={(e) => localInput.setEasy(e.target.checked)} /> Easy claw
        </label>
      </div>
    </div>
  );
}

/** Whether the robots' plans are ready, and how the joint planning went. */
function PlanStatus() {
  if (runner.planning) return <div className="small planning">Planning every robot's route (both alliances)…</div>;
  const st = runner.planningStats;
  if (!st || !Object.keys(st.values).length) return null;
  const how = st.converged ? 'no robot can improve against the others' : `${st.rounds} best-response round${st.rounds === 1 ? '' : 's'}`;
  return (
    <div className="small muted" title="Planned value of each robot's route against the other robots' plans (its alliance's score in the planning model)">
      Plans: {how} · {Object.entries(st.values).map(([k, v]) => `${k} ${v}`).join(' · ')}
    </div>
  );
}

function SimControls() {
  useRunnerTick();
  const camera = useApp((s) => s.camera);
  const show = useApp((s) => s.show);
  const tm = useTeam();
  const guest = tm.role === 'guest';
  const sim = guest ? null : runner.sim;
  const driving = guest ? !!team.session?.mySlot() : !!runner.localSlot;
  const speeds = [0.1, 0.25, 0.5, 1, 2, 4, 8];
  return (
    <div className="controls">
      <div className="row">
        <button className="primary" disabled={!sim || runner.planning} onClick={() => runner.setPlaying(!runner.playing)} title="P">
          {runner.planning ? 'Planning…' : runner.playing ? 'Pause' : 'Play'}
        </button>
        <button disabled={!sim} onClick={() => runner.stepOnce(1)} title="Advance one physics step (1/120 s)">
          Step
        </button>
        <button disabled={!sim} onClick={() => runner.stepOnce(12)}>+0.1 s</button>
        <button disabled={!sim} onClick={() => runner.runToEnd()}>Run to end</button>
        <button disabled={guest} onClick={() => runner.rebuild()}>Reset match</button>
        {guest && <span className="small muted">The host runs the match clock.</span>}
      </div>
      <div className="row">
        <label>
          Speed{' '}
          <select value={runner.speed} onChange={(e) => runner.setSpeed(Number(e.target.value))}>
            {speeds.map((s) => (
              <option key={s} value={s}>
                {s}×{s < 1 ? ' (slow motion)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!sim} onClick={() => runner.addCheckpoint()}>Save checkpoint</button>
        <select disabled={!runner.checkpoints.length} value="" onChange={(e) => e.target.value && runner.restore(Number(e.target.value))}>
          <option value="">Restore checkpoint…</option>
          {runner.checkpoints.map((c) => (
            <option key={c.steps} value={c.steps}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        {(['chase', 'overhead', 'iso', 'side', 'free'] as CameraMode[]).map((c) => (
          <button key={c} className={camera === c ? 'on' : ''} disabled={c === 'chase' && !driving} onClick={() => store.set({ camera: c })} title={c === 'chase' ? 'Locked behind the robot you drive' : undefined}>
            {c === 'iso' ? 'Isometric' : c === 'chase' ? '3rd person' : c[0].toUpperCase() + c.slice(1)}
          </button>
        ))}
      </div>
      <div className="row toggles">
        {(Object.keys(show) as (keyof typeof show)[]).map((k) => (
          <label key={k}>
            <input type="checkbox" checked={show[k]} onChange={(e) => store.set({ show: { ...show, [k]: e.target.checked } })} /> {k}
          </label>
        ))}
      </div>
    </div>
  );
}

function Inspector() {
  useRunnerTick();
  const sel = useApp((s) => s.selection);
  const guest = useTeam().role === 'guest';
  const sim = runner.sim;
  if (guest) return <div className="inspector muted small">In a team room the host runs the physics; detailed inspection is available on the host.</div>;
  if (!sel || !sim) return <div className="inspector muted small">Click an object, robot, Goal or Toggle to inspect it.</div>;
  if (sel.kind === 'object') {
    const o = sim.objects.objects.get(sel.id);
    if (!o) return null;
    const t = o.body?.translation();
    const up = o.body ? upOf(o.body.rotation()) : null;
    return (
      <div className="inspector">
        <h4>{o.id}</h4>
        <div>{o.kind === 'pin' ? `Pin ${o.colors!.join('/')}` : 'Cup (clear / gray halves)'}</div>
        <div>State: {o.mode}{o.robotId && (o.mode === 'held' || o.mode === 'intaking') ? ` by ${o.robotId}` : ''}</div>
        {o.stack && <div>Goal {o.stack.goalId}, position {o.stack.index + 1}</div>}
        {t && (
          <div className="small muted">
            x {(t.x / IN).toFixed(1)}" · y {(-t.z / IN).toFixed(1)}" · z {(t.y / IN).toFixed(1)}" · {up && up.y >= 0 ? 'upright' : 'inverted'}
            {up && Math.abs(up.y) < 0.7 ? ' (lying)' : ''}
          </div>
        )}
      </div>
    );
  }
  if (sel.kind === 'robot') {
    const r = sim.robot(sel.id);
    if (!r) return null;
    const p = r.body.pose();
    const tl = r.body.telemetry;
    return (
      <div className="inspector">
        <h4>{r.id}</h4>
        <div className="small">
          Driver: {(() => {
            const d = runner.driverOf(r.id);
            return d.kind === 'bot' ? `bot (${runner.built?.slots.get(r.id)?.bot.kind ?? '—'})` : d.kind === 'local' ? 'you' : d.name;
          })()}
        </div>
        <div className="small">
          ({p.pos.x.toFixed(1)}", {p.pos.y.toFixed(1)}") · heading {((p.heading * 180) / Math.PI).toFixed(0)}° · {tl.speed.toFixed(1)} in/s
        </div>
        <div className="small">
          Lift {tl.liftHeight.toFixed(1)}" · motors L {(tl.utilLeft * 100).toFixed(0)}% R {(tl.utilRight * 100).toFixed(0)}% · slipping wheels {tl.slipping} · tilt {((tl.tilt * 180) / Math.PI).toFixed(1)}°
        </div>
        <div className="small">Holding: {[r.primary?.id, r.secondary?.id].filter(Boolean).join(', ') || 'nothing'}</div>
      </div>
    );
  }
  if (sel.kind === 'goal') {
    const fs = sim.extractFieldState();
    const g = fs.goals.find((x) => x.id === sel.id);
    const rep = sim.liveScore();
    const lines = rep.lines.filter((l) => l.goalId === sel.id);
    const non = rep.nonScoring.filter((l) => l.goalId === sel.id);
    return (
      <div className="inspector">
        <h4>{sel.id}</h4>
        <div className="small">
          {g?.type} Goal · {g?.quadrant} · {g?.stack.length ?? 0} stacked elements
        </div>
        {lines.map((l, i) => (
          <div key={i} className="small">
            +{l.points} {l.alliance}: {l.explanation} [{l.ruleId}]
          </div>
        ))}
        {non.map((l, i) => (
          <div key={i} className="small muted">
            0: {l.color} {l.half} of {l.objectId} — {l.reason} [{l.ruleId}]
          </div>
        ))}
      </div>
    );
  }
  const fs = sim.extractFieldState();
  const tgl = fs.toggles.find((t) => `T-${t.quadrant}` === sel.id);
  return (
    <div className="inspector">
      <h4>{sel.id}</h4>
      <div className="small">
        Position: {tgl?.position} · robot contact: {tgl?.robotContact ? 'yes (counts as neutral, SC4)' : 'no'}
      </div>
    </div>
  );
}

/** Keyboard + gamepad feed the local driver input; Space / Start toggles play (not for guests). */
function useDriverInput() {
  useEffect(() => {
    runner.live = localInput.state;
    localInput.onPlayPause = () => {
      if (team.role !== 'guest') runner.setPlaying(!runner.playing);
    };
    // W A S D while watching: take over your robot (3rd person follows)
    localInput.onDriveKey = () => {
      if (store.get().tab !== 'field') return;
      const s = team.session;
      if (team.role === 'guest') {
        if (!s || s.mySlot()) return;
        const free = Object.keys(s.state.roster).find((k) => !s.state.roster[k].peerId);
        if (free) s.claimSlot(free);
        return;
      }
      const sim = runner.sim;
      // practice: driving starts the clock
      if (store.get().practice && sim && !runner.playing && sim.t < sim.clock.total) runner.setPlaying(true);
      if (runner.localSlot || !sim) return;
      const ids = sim.robots.map((r) => r.id);
      const slot = [store.get().userSlot, ...ids].find((id) => ids.includes(id) && runner.driverOf(id).kind === 'bot');
      if (!slot) return;
      if (team.role === 'host') team.claimSlot(slot);
      else runner.setDriver(slot, { kind: 'local', name: 'You' });
    };
    const detach = localInput.attachKeyboard();
    const unsub = localInput.subscribe((inp) => team.session?.onLocalInput(inp));
    return () => {
      detach();
      unsub();
    };
  }, []);
}

export function FieldPanel() {
  const steps = usePlanSteps();
  const simVersion = useApp((s) => s.simVersion);
  useDriverInput();
  useEffect(() => {
    runner.rebuild(store.get());
  }, [simVersion]);
  return (
    <div className="field-layout">
      <div className="field-main">
        <Field3D steps={steps} />
        <Hud />
      </div>
      <aside className="field-side">
        <SimControls />
        <TopDown steps={steps} height={330} />
        <Inspector />
        <DriversCard />
      </aside>
    </div>
  );
}
