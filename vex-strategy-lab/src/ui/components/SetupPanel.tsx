import type { MatchType } from '../../rules/ruleset';
import type { Strategy } from '../../sim/scenario';
import { exportScenario, importScenario, resetLayout, resetSettings, setLayout, setMatchType, setSlotStrategy, store, useApp, type SavedScenario } from '../store';
import { TopDown } from './TopDown';

const STRATEGIES: { v: Strategy; label: string }[] = [
  { v: 'optimized', label: 'AI (optimizer + MPC)' },
  { v: 'toggles', label: 'Scripted: flip Toggles' },
  { v: 'midfield', label: 'Scripted: park in Midfield' },
  { v: 'defender', label: 'Scripted: defend a Goal' },
  { v: 'manual', label: 'Manual (keyboard)' },
  { v: 'idle', label: 'Stationary' },
];

export function SetupPanel() {
  const s = useApp((x) => x);
  const P = s.params;
  const setParams = (fn: (p: typeof P) => void) => {
    const n = JSON.parse(JSON.stringify(P));
    fn(n);
    store.set((st) => ({ params: n, report: null, simVersion: st.simVersion + 1 }));
  };
  const unc = s.uncertainty;
  const setUnc = (k: keyof typeof unc, v: number) => store.set({ uncertainty: { ...unc, [k]: v } });
  const save = () => {
    const blob = new Blob([JSON.stringify(exportScenario(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `override-scenario-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
    a.click();
  };
  const load = (f: File) => {
    f.text().then((t) => {
      try {
        importScenario(JSON.parse(t) as SavedScenario);
        store.set({ message: `Loaded ${f.name}` });
      } catch (e) {
        store.set({ message: `Could not load: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  };
  const quick = (op: 'save' | 'load') => {
    try {
      if (op === 'save') {
        localStorage.setItem('vex-lab-scenario', JSON.stringify(exportScenario()));
        store.set({ message: 'Scenario saved in this browser' });
      } else {
        const t = localStorage.getItem('vex-lab-scenario');
        if (t) importScenario(JSON.parse(t));
        store.set({ message: t ? 'Scenario restored' : 'Nothing saved yet' });
      }
    } catch {
      store.set({ message: 'Browser storage is unavailable here — use Download instead.' });
    }
  };
  return (
    <div className="panel-grid">
      <section className="card">
        <h3>Match</h3>
        <div className="form-grid">
          <label className="field">
            <span>Mode</span>
            <select value={s.matchType} onChange={(e) => setMatchType(e.target.value as MatchType)}>
              <option value="headToHead">Head-to-Head match (2 v 2)</option>
              <option value="skillsDriver">Robot Skills — Driver</option>
              <option value="skillsAuton">Robot Skills — Autonomous Coding</option>
            </select>
          </label>
          <label className="field">
            <span>Your robot</span>
            <select value={s.userSlot} onChange={(e) => store.set((st) => ({ userSlot: e.target.value, report: null, simVersion: st.simVersion + 1 }))}>
              {s.slots.map((x) => (
                <option key={x.slot} value={x.slot}>
                  {x.slot}
                </option>
              ))}
            </select>
          </label>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Slot</th>
              <th>On field</th>
              <th>Control</th>
            </tr>
          </thead>
          <tbody>
            {s.slots.map((x) => (
              <tr key={x.slot}>
                <td className={x.alliance}>{x.slot}{x.slot === s.userSlot ? ' (yours)' : ''}</td>
                <td>
                  <input type="checkbox" checked={x.enabled} disabled={x.slot === s.userSlot} onChange={(e) => setSlotStrategy(x.slot, x.strategy, e.target.checked)} />
                </td>
                <td>
                  <select value={x.strategy} onChange={(e) => setSlotStrategy(x.slot, e.target.value as Strategy, x.enabled)}>
                    {STRATEGIES.map((o) => (
                      <option key={o.v} value={o.v}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">AI robots obey the same rules and physics. With “Plan around other robots” (Optimizer), your plan anticipates their predicted actions; MPC replans live.</p>
        <div className="row">
          <button onClick={save}>Download scenario</button>
          <label className="button">
            Load scenario…
            <input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
          </label>
          <button onClick={() => quick('save')}>Quick save</button>
          <button onClick={() => quick('load')}>Quick load</button>
          <button
            className="link"
            title="Your robot, rules, strategies, optimizer and view settings are kept in this browser between visits"
            onClick={() => {
              if (confirm('Reset every setting (robot, rules, strategies, optimizer, view) to the defaults?')) {
                resetSettings();
                store.set({ message: 'Settings reset to the defaults' });
              }
            }}
          >
            Reset settings
          </button>
        </div>
        <p className="small muted">Settings are saved in this browser as you change them.</p>
      </section>
      <section className="card">
        <h3>Field setup</h3>
        <p className="small">{s.layout.provenance}</p>
        <div className="row">
          {(['select', 'move', 'measure'] as const).map((t) => (
            <button key={t} className={s.setupTool === t ? 'on' : ''} onClick={() => store.set({ setupTool: t })}>
              {t === 'move' ? 'Move objects / robots' : t === 'measure' ? 'Measure' : 'Select'}
            </button>
          ))}
          <button onClick={resetLayout}>Reset to default layout</button>
        </div>
        <TopDown editable height={460} />
        <div className="form-grid">
          {['T-R1', 'T-R2', 'T-B1', 'T-B2'].map((id) => (
            <label key={id} className="field">
              <span>{id} at start</span>
              <select value={s.layout.toggles?.[id] ?? 'yellow'} onChange={(e) => setLayout({ ...s.layout, toggles: { ...(s.layout.toggles ?? {}), [id]: e.target.value as 'red' | 'yellow' | 'blue' } })}>
                <option value="yellow">yellow (neutral)</option>
                <option value="red">red</option>
                <option value="blue">blue</option>
              </select>
            </label>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>Rule interpretation switches</h3>
        <p className="small muted">Defaults follow the sources listed in Rules; flip these to test alternative readings of uncertain rules.</p>
        <div className="form-grid">
          <label className="field">
            <span>AWP criteria</span>
            <select value={P.awp.variant} onChange={(e) => setParams((p) => (p.awp.variant = e.target.value as 'standard' | 'qualifyingEvent'))}>
              <option value="standard">Standard (6 Pins, 2 Goals)</option>
              <option value="qualifyingEvent">Qualifying event (7 Pins, 3 Goals, Midfield)</option>
            </select>
          </label>
          <label className="field">
            <span>Half nested in Goal hidden</span>
            <input type="checkbox" checked={P.scoring.goalObscuresNestedHalf} onChange={(e) => setParams((p) => (p.scoring.goalObscuresNestedHalf = e.target.checked))} />
          </label>
          <label className="field">
            <span>Robot contact voids Pin</span>
            <input type="checkbox" checked={P.scoring.robotContactInvalidates} onChange={(e) => setParams((p) => (p.scoring.robotContactInvalidates = e.target.checked))} />
          </label>
          <label className="field">
            <span>Match Loads in Autonomous</span>
            <input type="checkbox" checked={P.matchLoads.allowedInAutonomous} onChange={(e) => setParams((p) => (p.matchLoads.allowedInAutonomous = e.target.checked))} />
          </label>
          <label className="field">
            <span>Human load time (s)</span>
            <input type="number" step={0.1} value={P.matchLoads.humanLoadSec} onChange={(e) => setParams((p) => (p.matchLoads.humanLoadSec = Number(e.target.value)))} />
          </label>
          <label className="field">
            <span>Vertical limit applies in Endgame</span>
            <input type="checkbox" checked={P.robot.verticalLimitAppliesInEndgame} onChange={(e) => setParams((p) => (p.robot.verticalLimitAppliesInEndgame = e.target.checked))} />
          </label>
          <label className="field">
            <span>Endgame length (s)</span>
            <input type="number" value={P.timing.endgameSec} onChange={(e) => setParams((p) => (p.timing.endgameSec = Number(e.target.value)))} />
          </label>
        </div>
      </section>
      <section className="card">
        <h3>Uncertainty (sim-to-real)</h3>
        <div className="form-grid">
          {(
            [
              ['motorSd', 'Motor performance SD (fraction)', 0.01],
              ['tractionSd', 'Traction SD (fraction)', 0.01],
              ['batteryMin', 'Battery min (V)', 0.1],
              ['batteryMax', 'Battery max (V)', 0.1],
              ['positionSigma', 'Positioning error SD (in)', 0.05],
              ['objectPosSd', 'Object start position SD (in)', 0.1],
              ['mechanismFail', 'Mechanism failure probability', 0.01],
              ['retryPenaltySec', 'Retry penalty (s)', 0.1],
              ['eventTimeSd', 'Other robots\' timing SD at 15 s (s)', 0.1],
            ] as const
          ).map(([k, label, step]) => (
            <label key={k} className="field">
              <span>{label}</span>
              <input type="number" step={step} value={unc[k]} onChange={(e) => setUnc(k, Number(e.target.value))} />
            </label>
          ))}
        </div>
        <button onClick={() => store.set({ uncertainty: { motorSd: 0, tractionSd: 0, batteryMin: 12.8, batteryMax: 12.8, positionSigma: 0, objectPosSd: 0, mechanismFail: 0, retryPenaltySec: 1, eventTimeSd: 0 } })}>Deterministic baseline (no uncertainty)</button>
      </section>
    </div>
  );
}
