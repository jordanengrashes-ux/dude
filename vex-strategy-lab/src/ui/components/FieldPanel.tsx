import { useEffect, useMemo, useState } from 'react';
import { formatClock, isEndgame, periodAt, remaining } from '../../rules/timing';
import { IN } from '../../core/units';
import { upOf } from '../../physics/frames';
import { runner } from '../simRunner';
import { store, useApp, type CameraMode } from '../store';
import { Field3D } from './Field3D';
import { TopDown } from './TopDown';

function useRunnerTick() {
  const [, set] = useState(0);
  useEffect(() => {
    let last = 0;
    return runner.subscribe(() => {
      const now = performance.now();
      if (now - last > 90) {
        last = now;
        set((x) => x + 1);
      }
    });
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
  const sim = runner.sim;
  if (!sim) return <div className="hud muted">{runner.building ? 'Building simulation…' : runner.error ?? 'No simulation'}</div>;
  const per = periodAt(sim.clock, sim.t);
  const totals = sim.displayTotals();
  const rep = sim.liveScore();
  const rem = remaining(sim.clock, sim.t);
  const autoLeft = sim.clock.autonomousEnd !== null ? Math.max(0, sim.clock.autonomousEnd - sim.t) : 0;
  return (
    <div className="hud" aria-live="polite">
      <div className="clock">
        <span className="period">{per === 'ended' ? 'Match over' : per === 'autonomous' ? 'Autonomous' : per === 'driver' ? (isEndgame(sim.clock, sim.t) ? 'Endgame' : 'Driver Control') : 'Robot Skills'}</span>
        <span className="time">{formatClock(per === 'autonomous' ? autoLeft : rem)}</span>
        <span className="muted small">t = {sim.t.toFixed(2)} s</span>
      </div>
      <div className="score red">
        <span className="label">Red</span>
        <span className="value">{totals.red}</span>
        {totals.bonus && <span className="small muted">incl. Auto Bonus {totals.bonus.red}</span>}
      </div>
      {sim.clock.matchType === 'headToHead' && (
        <div className="score blue">
          <span className="label">Blue</span>
          <span className="value">{totals.blue}</span>
          {totals.bonus && <span className="small muted">incl. Auto Bonus {totals.bonus.blue}</span>}
        </div>
      )}
      <div className="own">
        <span className="small muted">Ownership</span>
        {(['R1', 'R2', 'B1', 'B2', 'midfield'] as const).map((q) => (
          <span key={q} className={`chip ${rep.ownership[q] ?? 'none'}`}>
            {q === 'midfield' ? 'Mid' : q}: {rep.ownership[q] ?? '—'}
          </span>
        ))}
      </div>
      {sim.result && (
        <div className="small">
          AWP: red {sim.result.awp.red.earned ? '✓' : '✗'} · blue {sim.result.awp.blue.earned ? '✓' : '✗'} · {sim.result.bonus.explanation}
        </div>
      )}
      <div className="small muted">{sim.violations.length} violations · {sim.events.filter((e) => e.type === 'collision').length} collisions</div>
    </div>
  );
}

function SimControls() {
  useRunnerTick();
  const camera = useApp((s) => s.camera);
  const show = useApp((s) => s.show);
  const sim = runner.sim;
  const speeds = [0.1, 0.25, 0.5, 1, 2, 4, 8];
  return (
    <div className="controls">
      <div className="row">
        <button className="primary" disabled={!sim} onClick={() => runner.setPlaying(!runner.playing)} title="Space">
          {runner.playing ? 'Pause' : 'Play'}
        </button>
        <button disabled={!sim} onClick={() => runner.stepOnce(1)} title="Advance one physics step (1/120 s)">
          Step
        </button>
        <button disabled={!sim} onClick={() => runner.stepOnce(12)}>+0.1 s</button>
        <button disabled={!sim} onClick={() => runner.runToEnd()}>Run to end</button>
        <button onClick={() => runner.rebuild()}>Reset match</button>
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
        {(['overhead', 'iso', 'side', 'free'] as CameraMode[]).map((c) => (
          <button key={c} className={camera === c ? 'on' : ''} onClick={() => store.set({ camera: c })}>
            {c === 'iso' ? 'Isometric' : c[0].toUpperCase() + c.slice(1)}
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
  const sim = runner.sim;
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
        <div className="small">Controller: {r.controller.kind}</div>
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

function useKeyboard() {
  useEffect(() => {
    const keys = new Set<string>();
    const update = () => {
      const l = runner.live;
      l.forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
      l.turn = (keys.has('a') || keys.has('arrowleft') ? 1 : 0) - (keys.has('d') || keys.has('arrowright') ? 1 : 0);
      l.lift = (keys.has('r') ? 1 : 0) - (keys.has('f') ? 1 : 0);
      l.intake = keys.has('shift') || keys.has('i');
      l.toggle = keys.has('t');
      l.load = keys.has('l');
    };
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === ' ') {
        e.preventDefault();
        runner.setPlaying(!runner.playing);
        return;
      }
      if (k === 'e') runner.live.release = true;
      if (k === 'q') runner.live.index = true;
      if (k === 'x') runner.live.reorient = true;
      keys.add(k);
      update();
    };
    const up = (e: KeyboardEvent) => {
      keys.delete(e.key.toLowerCase());
      update();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}

export function FieldPanel() {
  const steps = usePlanSteps();
  const simVersion = useApp((s) => s.simVersion);
  const slots = useApp((s) => s.slots);
  useKeyboard();
  useEffect(() => {
    runner.rebuild(store.get());
  }, [simVersion]);
  const manual = slots.some((s) => s.strategy === 'manual' && s.enabled);
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
        <div className="small muted help">
          {manual ? (
            <>Manual robot: W/S drive · A/D turn · R/F lift · Shift intake · E release · Q index pockets · X flip · T toggle · L request Match Load · Space play/pause</>
          ) : (
            <>Set a robot to “manual” in Setup to drive it with the keyboard. Space = play/pause. Drag to orbit, scroll to zoom, right-drag to pan.</>
          )}
        </div>
      </aside>
    </div>
  );
}
