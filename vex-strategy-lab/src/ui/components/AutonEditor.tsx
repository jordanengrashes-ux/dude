import { useMemo, useState } from 'react';
import type { Vec2 } from '../../core/vec';
import { dist } from '../../core/vec';
import { buildGoals } from '../../field/geometry';
import { DEFAULT_SPEED, moveStep, newProgram, pickSteps, placeSteps, turnStep } from '../../auton/plan';
import { isMotion, previewPath, stepLabel, toField, toProgram, type AutonMode, type AutonStep, type PreviewPoint } from '../../auton/program';
import { LIFT_PRESETS } from '../../sim/driver';
import { useApp, watchAuton } from '../store';
import { deleteSaved, ensureStart, layoutFor, plan, quickRun, retarget, saveProgram, setProgram, startFor, usePlan } from '../planState';
import { FIELD_COLORS, FieldText, PlanField, RobotGhost } from './PlanField';
import { ExportDialog, ImportDialog } from './CodeDialogs';

/**
 * Plan mode, autonomous: click on the field to build a program (a Goal adds a
 * place sequence, a Pin or Cup a pick sequence, anywhere else a drive), edit the
 * steps, run it with physics, watch it in 3D, and export it as PROS code.
 */

type ClickMode = 'smart' | 'drive' | 'back' | 'turn';

const SLOTS = ['red-1', 'red-2', 'blue-1', 'blue-2'];

export function AutonEditor() {
  const program = usePlan((s) => s.program);
  const selected = usePlan((s) => s.selected);
  const run = usePlan((s) => s.run);
  const running = usePlan((s) => s.running);
  const runError = usePlan((s) => s.runError);
  const dialog = usePlan((s) => s.dialog);
  const saved = usePlan((s) => s.saved);
  const robot = useApp((s) => s.robot);
  useApp((s) => s.layout); // redraw when the field layout changes
  const [clickMode, setClickMode] = useState<ClickMode>('smart');
  const [drag, setDrag] = useState<{ step: number; moved: boolean } | null>(null);
  const layout = layoutFor(program.mode);
  const start = startFor(program);
  const preview = useMemo(() => (start ? previewPath(program.steps, start) : []), [program, start]);
  const insertAt = selected === null ? program.steps.length : selected + 1;
  const poseAt = (i: number): PreviewPoint | undefined => [...preview].reverse().find((p) => p.step < i);

  /**
   * Add steps after the selected one, made from where the robot is at that point. An
   * empty program first gets its starting setPose, so what follows is field-centric.
   */
  const insertWith = (make: (here: PreviewPoint) => AutonStep[] | null) => {
    let p = plan.get().program;
    let at = insertAt;
    if (!p.steps.length) {
      p = ensureStart(p);
      at = p.steps.length;
    }
    const st = startFor(p);
    if (!st) return;
    const pv = previewPath(p.steps, st);
    const here = [...pv].reverse().find((q) => q.step < at);
    const steps = here ? make(here) : null;
    if (!steps?.length) return;
    setProgram({ ...p, steps: [...p.steps.slice(0, at), ...steps, ...p.steps.slice(at)] });
    plan.set({ selected: at + steps.length - 1 });
  };
  const insert = (steps: AutonStep[]) => insertWith(() => steps);

  // smart sequences route around Goal posts and Loaders, and stay on this side in a match autonomous
  const route = { alliance: program.slot.startsWith('blue') ? ('blue' as const) : ('red' as const), ownSideOnly: program.mode === 'match' };
  const onFieldClick = (p: Vec2, shift: boolean) =>
    insertWith((here) => {
      const frame = here.frame;
      if (clickMode === 'turn') return [turnStep(frame, Math.atan2(p.y - here.pos.y, p.x - here.pos.x))];
      if (clickMode === 'smart' && !shift) {
        const goal = buildGoals().find((g) => dist(g.pos, p) < g.baseRadius + 2);
        if (goal) return placeSteps(frame, here.pos, goal, robot, route);
        const piece = [...layout.pins, ...layout.cups].find((o) => o.start.where === 'field' && dist(o.start.pos, p) < 3);
        if (piece && piece.start.where === 'field') return pickSteps(frame, here.pos, piece.start.pos, robot, route);
      }
      return [moveStep(frame, p, !(shift || clickMode === 'back'), DEFAULT_SPEED)];
    });

  // drag a waypoint: its step's target follows (in the program's frame)
  const dragTo = (i: number, p: Vec2) => {
    const pt = preview.find((x) => x.step === i);
    const frame = poseAt(i)?.frame ?? pt?.frame;
    if (!frame) return;
    const q = toProgram(frame, p);
    const r = (v: number) => Math.round(v * 10) / 10;
    setProgram((pr) => ({ ...pr, steps: pr.steps.map((s, k) => (k === i && (s.kind === 'moveToPoint' || s.kind === 'moveToPose' || s.kind === 'turnToPoint') ? { ...s, x: r(q.x), y: r(q.y) } : s)) }));
  };

  const color = program.slot.startsWith('blue') ? FIELD_COLORS.blue : FIELD_COLORS.red;
  const motionPts = preview.filter((p) => p.step >= 0 && program.steps[p.step] && isMotion(program.steps[p.step]));
  const last = preview[preview.length - 1];
  // non-motion steps, drawn as small badges where the robot is when they run
  const badges: { pos: Vec2; i: number; text: string; title: string }[] = [];
  program.steps.forEach((s, i) => {
    if (isMotion(s) || s.kind === 'setPose' || s.kind === 'waitUntilDone') return;
    const at = poseAt(i);
    if (!at) return;
    const text = s.kind === 'claw' ? (s.closed ? 'C' : 'O') : s.kind === 'lift' || s.kind === 'liftPower' ? 'L' : s.kind === 'wait' || s.kind === 'waitUntil' ? 'W' : s.kind === 'toggleArm' ? 'T' : 'D';
    badges.push({ pos: at.pos, i, text, title: `${i + 1}. ${stepLabel(s)}` });
  });
  const badgeOffset = new Map<string, number>();

  return (
    <div className="plan-layout">
      <div className="plan-main">
        <div className="row plan-toolbar">
          <span className="small muted">Click adds:</span>
          <div className="segmented" role="group" aria-label="What a click adds">
            {(
              [
                ['smart', 'Smart', 'A Goal: place on it. A Pin or Cup: pick it up. Elsewhere: drive there.'],
                ['drive', 'Drive', 'Drive forward to the point'],
                ['back', 'Back up', 'Drive backward to the point (or shift-click)'],
                ['turn', 'Turn', 'Turn to face the point'],
              ] as [ClickMode, string, string][]
            ).map(([m, label, title]) => (
              <button key={m} className={clickMode === m ? 'on' : ''} title={title} onClick={() => setClickMode(m)}>
                {label}
              </button>
            ))}
          </div>
          <span className="small muted">Drag a numbered point to move it. New steps go after the selected one.</span>
        </div>
        <PlanField
          layout={layout}
          highlightSlot={program.slot}
          cursor={drag ? 'grabbing' : 'crosshair'}
          pointer={{
            move: (p) => {
              if (!drag) return;
              setDrag({ ...drag, moved: true });
              dragTo(drag.step, p);
            },
            up: (p, e) => {
              if (drag) {
                const wasDrag = drag.moved;
                setDrag(null);
                if (wasDrag) return;
                plan.set({ selected: drag.step });
                return;
              }
              if (Math.abs(p.x) > 72 || Math.abs(p.y) > 72) return;
              onFieldClick(p, e.shiftKey);
            },
          }}
        >
          {run && (
            <g style={{ pointerEvents: 'none' }}>
              <polyline points={run.trace.map((s) => `${s.pos.x},${s.pos.y}`).join(' ')} fill="none" stroke={FIELD_COLORS.green} strokeWidth={0.9} strokeDasharray="2 1" />
              {run.trace.length > 0 && <RobotGhost pos={run.trace[run.trace.length - 1].pos} heading={run.trace[run.trace.length - 1].heading} color={FIELD_COLORS.green} opacity={0.9} />}
            </g>
          )}
          {preview.length > 1 && (
            <polyline points={preview.map((p) => `${p.pos.x},${p.pos.y}`).join(' ')} fill="none" stroke={color} strokeWidth={0.9} strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
          )}
          {last && <RobotGhost pos={last.pos} heading={last.heading} color={color} opacity={0.55} dashed />}
          {start && <RobotGhost pos={start.pos} heading={start.heading} color={color} />}
          {badges.map((b) => {
            const key = `${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)}`;
            const k = badgeOffset.get(key) ?? 0;
            badgeOffset.set(key, k + 1);
            const at = { x: b.pos.x + 4 + k * 3.6, y: b.pos.y + 4 };
            return (
              <g key={b.i} onPointerDown={(e) => (e.stopPropagation(), plan.set({ selected: b.i }))} style={{ cursor: 'pointer' }}>
                <title>{b.title}</title>
                <circle cx={at.x} cy={at.y} r={1.7} fill={selected === b.i ? FIELD_COLORS.yellow : '#1d1e20'} stroke={FIELD_COLORS.ink} strokeWidth={0.3} />
                <FieldText x={at.x} y={at.y} size={2.2} fill={selected === b.i ? '#111' : FIELD_COLORS.ink}>
                  {b.text}
                </FieldText>
              </g>
            );
          })}
          {motionPts.map((p) => {
            const s = program.steps[p.step];
            const draggable = s.kind === 'moveToPoint' || s.kind === 'moveToPose';
            const target = s.kind === 'turnToPoint' ? toField(poseAt(p.step)?.frame ?? p.frame, s) : null;
            const sel = selected === p.step;
            return (
              <g key={p.step}>
                {target && <line x1={p.pos.x} y1={p.pos.y} x2={target.x} y2={target.y} stroke={color} strokeWidth={0.4} strokeDasharray="1 1" style={{ pointerEvents: 'none' }} />}
                <circle
                  cx={(target ?? p.pos).x}
                  cy={(target ?? p.pos).y}
                  r={sel ? 2.6 : 2.1}
                  fill={sel ? FIELD_COLORS.yellow : color}
                  stroke="#111"
                  strokeWidth={0.4}
                  style={{ cursor: draggable || target ? 'grab' : 'pointer' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                    setDrag({ step: p.step, moved: false });
                  }}
                >
                  <title>{`${p.step + 1}. ${stepLabel(s)}`}</title>
                </circle>
                <FieldText x={(target ?? p.pos).x} y={(target ?? p.pos).y} size={2.2} fill={sel ? '#111' : '#fff'}>
                  {p.step + 1}
                </FieldText>
              </g>
            );
          })}
        </PlanField>
        <p className="small muted">
          Coordinates are field inches from the center (x toward the blue Alliance Station, y up), headings in degrees with 0° = up and clockwise positive — LemLib's convention.
          Solid line: the plan. Dashed green: what the robot actually did in the last run.
        </p>
      </div>
      <aside className="plan-side">
        {programCard()}
        {runCard()}
        {stepsCard()}
      </aside>
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'import' && <ImportDialog />}
    </div>
  );

  function programCard() {
    return (
      <section className="card">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input aria-label="Program name" value={program.name} onChange={(e) => setProgram((p) => ({ ...p, name: e.target.value }))} style={{ flex: 1, minWidth: 120 }} />
          <button onClick={saveProgram} title="Save in this browser">
            Save
          </button>
          <select
            aria-label="Open a saved program"
            value=""
            onChange={(e) => {
              const p = saved.find((x) => x.name === e.target.value);
              if (p) {
                setProgram(p);
                plan.set({ selected: null });
              }
            }}
          >
            <option value="">Open…</option>
            {saved.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
          <label className="small">
            Run as{' '}
            <select value={program.mode} onChange={(e) => setProgram((p) => retarget(p, p.slot, e.target.value as AutonMode))}>
              <option value="match">Match autonomous (15 s)</option>
              <option value="skills">Skills autonomous (60 s)</option>
            </select>
          </label>
          <label className="small">
            Start{' '}
            <select value={program.slot} disabled={program.mode === 'skills'} onChange={(e) => setProgram((p) => retarget(p, e.target.value, p.mode))}>
              {SLOTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button onClick={() => plan.set({ dialog: 'import' })}>Import code</button>
          <button className="primary" onClick={() => plan.set({ dialog: 'export' })}>
            Export code
          </button>
          <button
            onClick={() => {
              if (!program.steps.length || confirm('Start a new, empty program? (Save this one first if you want to keep it.)')) {
                setProgram(newProgram('My autonomous', program.slot, program.mode, startFor(program)));
                plan.set({ selected: null });
              }
            }}
          >
            New
          </button>
          {saved.some((x) => x.name === program.name) && (
            <button className="link" onClick={() => deleteSaved(program.name)}>
              Delete saved
            </button>
          )}
        </div>
      </section>
    );
  }

  function runCard() {
    const timedOut = run?.records.filter((r) => r.timedOut) ?? [];
    return (
      <section className="card">
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="primary" disabled={!!running || !program.steps.length} onClick={() => void quickRun()}>
            {running ? `Running… ${running.t.toFixed(1)} / ${running.window} s` : 'Run with physics'}
          </button>
          <button disabled={!program.steps.length} onClick={() => watchAuton(program)} title="Run it on the 3D field">
            Watch in 3D
          </button>
        </div>
        {runError && <p className="small error">{runError}</p>}
        {run && (
          <div className="small run-result">
            <div>
              <strong>
                {run.score.red} – {run.score.blue}
              </strong>{' '}
              (red – blue) after {program.mode === 'skills' ? 'the Skills run' : 'Autonomous'} ·{' '}
              {run.finishedAt !== null ? `done at ${run.finishedAt.toFixed(1)} s of ${run.window}` : `not done when the ${run.window} s ran out`}
            </div>
            {timedOut.length > 0 && <div className="error">Timed out: {timedOut.map((r) => `#${r.index + 1} ${r.label}`).join(', ')}</div>}
            {run.violations.length > 0 && <div className="error">{run.violations.join(' · ')}</div>}
            {run.events.length > 0 && (
              <details>
                <summary>What happened ({run.events.length})</summary>
                <ul>
                  {run.events.map((e, i) => (
                    <li key={i}>
                      {e.t.toFixed(1)} s — {e.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>
    );
  }

  function stepsCard() {
    const add = (s: AutonStep[]) => insert(s);
    return (
      <section className="card steps-card">
        <h4>Steps</h4>
        <div className="row add-steps">
          <select
            aria-label="Add a lift step"
            value=""
            onChange={(e) => {
              if (e.target.value === '') return;
              add([{ kind: 'lift', height: Math.max(robot.lift.holderMinHeightIn, Number(e.target.value)) }]);
            }}
          >
            <option value="">+ Lift…</option>
            {LIFT_PRESETS.map((p) => (
              <option key={p.key} value={p.h}>
                {p.label} ({Math.max(robot.lift.holderMinHeightIn, p.h)}")
              </option>
            ))}
          </select>
          <button onClick={() => add([{ kind: 'claw', closed: true }])}>+ Close claw</button>
          <button onClick={() => add([{ kind: 'claw', closed: false }])}>+ Open claw</button>
          <button onClick={() => add([{ kind: 'wait', ms: 250 }])}>+ Wait</button>
          <button onClick={() => add([{ kind: 'waitUntilDone' }])} title="Wait until the robot has finished its motion">
            + Wait for motion
          </button>
          <button onClick={() => insertWith((h) => [turnStep(h.frame, h.heading + Math.PI / 2)])} title="Turn 90° left (edit the heading after)">
            + Turn
          </button>
          <button onClick={() => add([{ kind: 'toggleArm', on: true }, { kind: 'wait', ms: 600 }, { kind: 'toggleArm', on: false }])}>+ Toggle arm</button>
        </div>
        {!program.steps.length && <p className="small muted">Click on the field to add the first move.</p>}
        <ol className="steps">
          {program.steps.map((s, i) => (
            <li key={i} className={selected === i ? 'sel' : ''} onClick={() => plan.set({ selected: selected === i ? null : i })}>
              <StepRow s={s} i={i} />
            </li>
          ))}
        </ol>
      </section>
    );
  }
}

function NumIn({ value, onChange, step = 1, w = 5, title }: { value: number; onChange: (v: number) => void; step?: number; w?: number; title?: string }) {
  return (
    <input
      type="number"
      className="num"
      title={title}
      value={Number.isFinite(value) ? Math.round(value * 100) / 100 : ''}
      step={step}
      style={{ width: `${w}em` }}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
    />
  );
}

function StepRow({ s, i }: { s: AutonStep; i: number }) {
  const set = (patch: Partial<AutonStep>) => setProgram((p) => ({ ...p, steps: p.steps.map((x, k) => (k === i ? ({ ...x, ...patch } as AutonStep) : x)) }));
  const move = (d: -1 | 1) =>
    setProgram((p) => {
      const j = i + d;
      if (j < 0 || j >= p.steps.length) return p;
      const steps = p.steps.slice();
      [steps[i], steps[j]] = [steps[j], steps[i]];
      plan.set({ selected: j });
      return { ...p, steps };
    });
  const del = () => {
    setProgram((p) => ({ ...p, steps: p.steps.filter((_, k) => k !== i) }));
    plan.set({ selected: null });
  };
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const asyncBox = 'async' in s && (
    <label className="small" title="On: the program carries on while the robot moves (LemLib's default). Off: wait until it arrives." onClick={stop}>
      <input type="checkbox" checked={s.async} onChange={(e) => set({ async: e.target.checked } as Partial<AutonStep>)} /> keep going
    </label>
  );
  let fields: React.ReactNode = null;
  switch (s.kind) {
    case 'setPose':
      fields = (
        <>
          x <NumIn value={s.x} onChange={(x) => set({ x })} /> y <NumIn value={s.y} onChange={(y) => set({ y })} /> θ <NumIn value={s.theta} onChange={(theta) => set({ theta })} />
        </>
      );
      break;
    case 'moveToPoint':
    case 'moveToPose':
    case 'turnToPoint':
      fields = (
        <>
          x <NumIn value={s.x} onChange={(x) => set({ x })} /> y <NumIn value={s.y} onChange={(y) => set({ y })} />
          {s.kind === 'moveToPose' && (
            <>
              {' '}
              θ <NumIn value={s.theta} onChange={(theta) => set({ theta })} />
            </>
          )}
          <label className="small" onClick={stop}>
            <input type="checkbox" checked={!s.forwards} onChange={(e) => set({ forwards: !e.target.checked })} /> {s.kind === 'turnToPoint' ? 'back faces it' : 'reverse'}
          </label>
          speed <NumIn value={s.maxSpeed} w={4} onChange={(v) => set({ maxSpeed: Math.max(1, Math.min(127, v)) })} title="Max speed, 0–127" />
          {asyncBox}
        </>
      );
      break;
    case 'turnToHeading':
    case 'swing':
      fields = (
        <>
          θ <NumIn value={s.theta} onChange={(theta) => set({ theta })} /> speed <NumIn value={s.maxSpeed} w={4} onChange={(v) => set({ maxSpeed: Math.max(1, Math.min(127, v)) })} />
          {asyncBox}
        </>
      );
      break;
    case 'drive':
      fields = (
        <>
          <NumIn value={s.inches} onChange={(inches) => set({ inches })} />" speed <NumIn value={s.maxSpeed} w={4} onChange={(v) => set({ maxSpeed: Math.max(1, Math.min(127, v)) })} />
          {asyncBox}
        </>
      );
      break;
    case 'wait':
      fields = (
        <>
          <NumIn value={s.ms} step={50} onChange={(ms) => set({ ms: Math.max(0, ms) })} /> ms
        </>
      );
      break;
    case 'waitUntil':
      fields = (
        <>
          <NumIn value={s.inches} onChange={(inches) => set({ inches })} />" into the motion
        </>
      );
      break;
    case 'lift':
      fields = (
        <>
          <NumIn value={s.height} step={0.5} onChange={(height) => set({ height: Math.max(0, height) })} />" holder height
        </>
      );
      break;
    case 'liftPower':
      fields = <NumIn value={s.power} onChange={(power) => set({ power: Math.max(-127, Math.min(127, power)) })} />;
      break;
    case 'claw':
      fields = (
        <select value={s.closed ? 'close' : 'open'} onClick={stop} onChange={(e) => set({ closed: e.target.value === 'close' })}>
          <option value="close">close</option>
          <option value="open">open</option>
        </select>
      );
      break;
    case 'toggleArm':
      fields = (
        <select value={s.on ? 'out' : 'in'} onClick={stop} onChange={(e) => set({ on: e.target.value === 'out' })}>
          <option value="out">out</option>
          <option value="in">in</option>
        </select>
      );
      break;
    default:
      break;
  }
  return (
    <div className="step">
      <div className="row step-head">
        <span className="step-n">{i + 1}</span>
        <span className="step-label">{stepLabel(s)}</span>
        <span className="step-btns" onClick={stop}>
          <button className="link" title="Move up" onClick={() => move(-1)}>
            ↑
          </button>
          <button className="link" title="Move down" onClick={() => move(1)}>
            ↓
          </button>
          <button className="link" title="Delete" onClick={del}>
            ✕
          </button>
        </span>
      </div>
      {fields && (
        <div className="row step-fields small" onClick={stop}>
          {fields}
        </div>
      )}
    </div>
  );
}
