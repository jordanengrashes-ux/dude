import { useState } from 'react';
import { ASSUMED_FIELDS, cloneRobot, DEFAULT_ROBOT, GIVEN_FIELDS, type RobotConfig } from '../../robot/config';
import { derivePerf, maxHolderHeight } from '../../robot/kinematics';
import { inspectRobot } from '../../rules/inspection';
import { setRobot, store, useApp } from '../store';
import { getClient } from './OptimizerPanel';

type Path = string;

function get(obj: unknown, path: Path): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}
function setPath(obj: RobotConfig, path: Path, v: unknown): RobotConfig {
  const c = cloneRobot(obj);
  const keys = path.split('.');
  let o = c as unknown as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] as Record<string, unknown>;
  o[keys[keys.length - 1]] = v;
  return c;
}

const assumed = new Set(ASSUMED_FIELDS.map((a) => a.path));
const given = new Set(GIVEN_FIELDS);

function Field({ robot, path, label, step = 0.1, unit, options }: { robot: RobotConfig; path: Path; label: string; step?: number; unit?: string; options?: (string | number)[] }) {
  const v = get(robot, path);
  const tag = given.has(path) ? <span className="tag given">given</span> : assumed.has(path) ? <span className="tag assumed">assumed</span> : <span className="tag est">estimate</span>;
  // Left-side drive gearing applies to both sides (symmetric tank drive); direction stays per side.
  const mirror = path.startsWith('drivetrain.left.') && !path.endsWith('direction') ? path.replace('drivetrain.left.', 'drivetrain.right.') : null;
  const on = (nv: unknown) => setRobot(mirror ? setPath(setPath(robot, path, nv), mirror, nv) : setPath(robot, path, nv));
  return (
    <label className="field">
      <span>
        {label} {tag}
      </span>
      {options ? (
        <select value={String(v)} onChange={(e) => on(typeof options[0] === 'number' ? Number(e.target.value) : e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : typeof v === 'boolean' ? (
        <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />
      ) : (
        <span className="with-unit">
          <input type="number" step={step} value={Number(v)} onChange={(e) => on(Number(e.target.value))} />
          {unit && <em>{unit}</em>}
        </span>
      )}
    </label>
  );
}

export function RobotPanel() {
  const robot = useApp((s) => s.robot);
  const params = useApp((s) => s.params);
  const [cal, setCal] = useState<string | null>(null);
  const insp = inspectRobot(robot, params);
  const perf = derivePerf(robot);
  const F = (p: Path, l: string, o: { step?: number; unit?: string; options?: (string | number)[] } = {}) => <Field robot={robot} path={p} label={l} {...o} />;
  const calibrate = async () => {
    setCal('Calibrating from physics…');
    try {
      const r = await getClient().calibrate(robot, params);
      setRobot({ ...robot, execution: r.execution });
      setCal(`Calibrated from ${r.samples.length} executed actions (physics ${r.physicsScore} vs plan ${r.plannedValue} pts). Overheads: pick ${r.execution.pickOverheadSec}s · place ${r.execution.placeOverheadSec}s · toggle ${r.execution.toggleOverheadSec}s.`);
    } catch (e) {
      setCal(`Calibration failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="panel-grid">
      <section className="card">
        <h3>Chassis & drivetrain</h3>
        <p className="small muted">“given” = from your description (16 × 16, 4WD, rack-and-pinion); “assumed” = unknown, set to a typical value — change it to match your robot.</p>
        <div className="form-grid">
          {F('chassis.lengthIn', 'Length', { unit: 'in' })}
          {F('chassis.widthIn', 'Width', { unit: 'in' })}
          {F('chassis.towerHeightIn', 'Height (lift down)', { unit: 'in' })}
          {F('chassis.groundClearanceIn', 'Ground clearance', { unit: 'in', step: 0.05 })}
          {F('chassis.slotWidthIn', 'Front slot width', { unit: 'in' })}
          {F('chassis.slotDepthIn', 'Front slot depth', { unit: 'in' })}
          {F('drivetrain.wheelDiameterIn', 'Wheel diameter', { unit: 'in', options: [2.75, 3.25, 4] })}
          {F('drivetrain.trackWidthIn', 'Track width', { unit: 'in' })}
          {F('drivetrain.wheelBaseIn', 'Wheel base', { unit: 'in' })}
          {F('drivetrain.left.cartridgeRpm', 'Drive cartridge', { options: [100, 200, 600] })}
          {F('drivetrain.left.gearRatio', 'Drive gear ratio (out/in)', { step: 0.05 })}
          {F('drivetrain.left.motorCount', 'Motors per side', { options: [1, 2, 3] })}
          {F('drivetrain.left.direction', 'Left motor direction', { options: [1, -1] })}
          {F('drivetrain.right.direction', 'Right motor direction', { options: [1, -1] })}
          {F('drivetrain.muLongitudinal', 'Traction μ (rolling)', { step: 0.05 })}
          {F('drivetrain.muLateral', 'Traction μ (lateral)', { step: 0.05 })}
          {F('drivetrain.rollingResistance', 'Rolling resistance', { step: 0.005 })}
        </div>
      </section>
      <section className="card">
        <h3>Mass, battery, rack-and-pinion</h3>
        <div className="form-grid">
          {F('mass.totalLb', 'Total mass', { unit: 'lb' })}
          {F('mass.comHeightIn', 'Center of mass height', { unit: 'in' })}
          {F('mass.comOffsetXIn', 'CoM offset (fwd)', { unit: 'in' })}
          {F('mass.comOffsetYIn', 'CoM offset (left)', { unit: 'in' })}
          {F('battery.voltage', 'Battery voltage', { unit: 'V', step: 0.1 })}
          {F('rack.travelIn', 'Rack travel', { unit: 'in' })}
          {F('rack.pinionPitchDiameterIn', 'Pinion pitch Ø', { unit: 'in', step: 0.05 })}
          {F('rack.motor.cartridgeRpm', 'Lift cartridge', { options: [100, 200, 600] })}
          {F('rack.motor.gearRatio', 'Lift gear ratio', { step: 0.05 })}
          {F('rack.motor.motorCount', 'Lift motors', { options: [1, 2] })}
          {F('rack.carriageMassLb', 'Carriage mass', { unit: 'lb' })}
          {F('rack.holderMinHeightIn', 'Holder height (down)', { unit: 'in' })}
          {F('rack.carriageHeightIn', 'Carriage height', { unit: 'in' })}
        </div>
      </section>
      <section className="card">
        <h3>Mechanism & start</h3>
        <div className="form-grid">
          {F('intake.capacity', 'Holder capacity', { options: ['pinAndCup', 'single'] })}
          {F('intake.holderOffsetIn', 'Holder axis offset', { unit: 'in' })}
          {F('intake.intakeTimeSec', 'Intake time', { unit: 's', step: 0.05 })}
          {F('intake.releaseTimeSec', 'Release time', { unit: 's', step: 0.05 })}
          {F('intake.indexTimeSec', 'Pocket index time', { unit: 's', step: 0.05 })}
          {F('intake.canReorient', 'Can flip objects')}
          {F('intake.reorientTimeSec', 'Flip time', { unit: 's', step: 0.05 })}
          {F('intake.placeToleranceIn', 'Placement tolerance', { unit: 'in', step: 0.05 })}
          {F('toggleArm.actuateTimeSec', 'Toggle actuation', { unit: 's', step: 0.05 })}
          {F('execution.placeOverheadSec', 'Place overhead (calibrated)', { unit: 's', step: 0.05 })}
          {F('execution.pickOverheadSec', 'Pick overhead (calibrated)', { unit: 's', step: 0.05 })}
          {F('execution.toggleOverheadSec', 'Toggle overhead (calibrated)', { unit: 's', step: 0.05 })}
        </div>
        <p className="small muted">Starting position and heading are set per slot by dragging robots in Setup → Field.</p>
        <div className="row">
          <button onClick={calibrate}>Calibrate model from physics</button>
          <button onClick={() => setRobot(cloneRobot(DEFAULT_ROBOT))}>Reset to defaults</button>
        </div>
        {cal && <p className="small">{cal}</p>}
        <p className="small muted">{robot.execution.calibratedFrom}</p>
      </section>
      <section className="card">
        <h3>Inspection ({params.name} v{params.manualVersion})</h3>
        <div className={`status ${insp.passed ? 'verified-optimum' : 'fail'}`}>{insp.passed ? 'Passes size & possession checks' : 'Fails inspection'}</div>
        <table className="table">
          <tbody>
            {insp.items.map((i, k) => (
              <tr key={k}>
                <td>{i.ok ? '✓' : i.severity === 'warning' ? '⚠' : '✗'}</td>
                <td>{i.label}</td>
                <td>{i.value}</td>
                <td className="muted">{i.limit}</td>
                <td className="muted small">{i.ruleId}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small">Highest legal holder height: {insp.maxLegalHolderHeight.preEndgame.toFixed(1)}" before the Endgame; the lift reaches {maxHolderHeight(robot).toFixed(1)}".</p>
        <h4>Derived performance (model)</h4>
        <table className="table small">
          <tbody>
            <tr><td>Free speed</td><td>{perf.vFree.toFixed(1)} in/s</td><td>Cruise</td><td>{perf.vCruise.toFixed(1)} in/s</td></tr>
            <tr><td>Max accel (motor / traction)</td><td>{perf.aMotor0.toFixed(0)} / {perf.aTraction.toFixed(0)} in/s²</td><td>Lateral grip</td><td>{perf.aLat.toFixed(0)} in/s²</td></tr>
            <tr><td>Turn rate</td><td>{perf.canTurnInPlace ? `${perf.yawRateMax.toFixed(2)} rad/s` : 'cannot turn in place (scrub)'}</td><td>Lift up / down</td><td>{perf.liftUpSpeed.toFixed(1)} / {perf.liftDownSpeed.toFixed(1)} in/s</td></tr>
          </tbody>
        </table>
        <h4>Assumptions</h4>
        <ul className="small">
          {ASSUMED_FIELDS.map((a) => (
            <li key={a.path}>
              <strong>{a.label}</strong> — {a.why}
            </li>
          ))}
        </ul>
        <button
          className="link"
          onClick={() => {
            const blob = new Blob([JSON.stringify(store.get().robot, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'robot-config.json';
            a.click();
          }}
        >
          Download robot config
        </button>
      </section>
    </div>
  );
}
