import { useRef } from 'react';
import { OptimizerClient } from '../../workers/client';
import type { PlanRequest } from '../../workers/protocol';
import { predictOthers } from '../../sim/scenario';
import { runner } from '../simRunner';
import { store, useApp } from '../store';
import { Histogram, LineChart, SERIES } from '../charts/Charts';

let client: OptimizerClient | null = null;
export const getClient = () => (client ??= new OptimizerClient());

export function buildRequest(): PlanRequest {
  const s = store.get();
  const slot = s.slots.find((x) => x.slot === s.userSlot)!;
  const isH2H = s.matchType === 'headToHead';
  const total = isH2H ? s.params.timing.autonomousSec + s.params.timing.driverSec : s.params.timing.skillsSec;
  const events = isH2H && s.planOptions.accountForOthers ? predictOthers(runner.scenarioFrom({ ...s, report: null }), s.userSlot) : [];
  return {
    params: s.params,
    robot: s.robot,
    layout: s.layout,
    matchType: s.matchType,
    robotId: s.userSlot,
    alliance: slot.alliance,
    tStart: 0,
    tEnd: total,
    objective: s.planOptions.objective,
    awpWeight: isH2H ? s.planOptions.awpWeight : 0,
    includeAutonBonus: isH2H && s.planOptions.includeAutonBonus,
    opponentAutoScore: s.planOptions.opponentAutoScore,
    externalEvents: events,
    candidateK: s.planOptions.candidateK,
    allowPark: s.planOptions.allowPark,
    cruiseFraction: 0.85,
    positionSigma: s.uncertainty.positionSigma,
  };
}

export async function startOptimization() {
  const s = store.get();
  store.set({ optStatus: 'running', progress: [], message: null });
  try {
    const req = buildRequest();
    const report = await getClient().optimize(req, s.settings, (p) => store.set((st) => ({ progress: [...st.progress, p] })));
    store.set((st) => ({ report, optStatus: 'idle', executePlan: report.recommended === 'best' ? report.best.id : report.practical.id, simVersion: st.simVersion + 1 }));
  } catch (e) {
    store.set({ optStatus: 'idle', message: `Optimizer error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

function Num({ label, value, onChange, step = 1, min, max, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; hint?: string }) {
  return (
    <label className="field" title={hint}>
      <span>{label}</span>
      <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function OptimizerPanel() {
  const st = useApp((s) => s);
  const { settings, planOptions, report, progress, optStatus, matchType, uncertainty } = st;
  const mcRef = useRef(0);
  const setS = (p: Partial<typeof settings>) => store.set({ settings: { ...settings, ...p } });
  const setP = (p: Partial<typeof planOptions>) => store.set({ planOptions: { ...planOptions, ...p } });
  const isH2H = matchType === 'headToHead';
  const chosenId = st.executePlan ?? (report ? (report.recommended === 'best' ? report.best.id : report.practical.id) : null);

  const runPhysicsMc = async () => {
    if (!report) return;
    const id = ++mcRef.current;
    store.set({ mcStatus: 'running', mcScores: [], physicsStats: null });
    try {
      const sc = runner.scenarioFrom(store.get());
      const stats = await getClient().physicsTrials(sc, store.get().userSlot, uncertainty, Math.max(1, Math.min(60, settings.robustnessTrials / 4)), settings.seed, settings.targetScore, (_k, score) => {
        if (mcRef.current === id) store.set((s) => ({ mcScores: [...s.mcScores, score] }));
      });
      store.set({ physicsStats: stats, mcStatus: 'idle' });
    } catch (e) {
      store.set({ mcStatus: 'idle', message: `Physics trials failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <div className="panel-grid">
      <section className="card">
        <h3>Search</h3>
        <div className="form-grid">
          <Num label="Budget (s)" value={settings.budgetMs / 1000} step={1} min={1} onChange={(v) => setS({ budgetMs: v * 1000 })} />
          <Num label="Random seed" value={settings.seed} onChange={(v) => setS({ seed: v })} />
          <label className="field">
            <span>Budget mode</span>
            <select value={settings.deterministic ? 'det' : 'time'} onChange={(e) => setS({ deterministic: e.target.value === 'det' })}>
              <option value="time">Wall-clock time</option>
              <option value="det">Deterministic (iterations)</option>
            </select>
          </label>
          <label className="field">
            <span>Objective</span>
            <select value={settings.objectiveMode} onChange={(e) => setS({ objectiveMode: e.target.value as 'theoretical' | 'expected' })}>
              <option value="theoretical">Maximum theoretical score</option>
              <option value="expected">Maximum expected real-world score</option>
            </select>
          </label>
          <label className="field">
            <span>Score</span>
            <select value={planOptions.objective} onChange={(e) => setP({ objective: e.target.value as 'own' | 'margin' })}>
              <option value="own">Own alliance score</option>
              <option value="margin">Score margin (own − opponent)</option>
            </select>
          </label>
          <Num label="Candidates per kind (K)" value={planOptions.candidateK} min={1} max={60} onChange={(v) => setP({ candidateK: v })} hint="Nearest pickups considered at each decision" />
          <Num label="Beam widths" value={settings.beamWidths[settings.beamWidths.length - 1]} min={1} onChange={(v) => setS({ beamWidths: [1, Math.max(2, Math.round(v / 12)), Math.max(4, Math.round(v / 3)), v] })} hint="Largest beam width; smaller ones are derived" />
          <Num label="MCTS iterations" value={settings.mctsIterations} step={200} onChange={(v) => setS({ mctsIterations: v })} />
          <Num label="Evolution generations" value={settings.evolveGenerations} step={10} onChange={(v) => setS({ evolveGenerations: v })} />
          <Num label="B&B share of budget" value={settings.bnbShare} step={0.05} min={0} max={0.9} onChange={(v) => setS({ bnbShare: v })} />
          <Num label="Model Monte Carlo trials" value={settings.robustnessTrials} step={20} onChange={(v) => setS({ robustnessTrials: v })} />
          <Num label="Target score (optional)" value={settings.targetScore ?? 0} onChange={(v) => setS({ targetScore: v > 0 ? v : null })} />
          {isH2H && (
            <>
              <Num label="AWP value (pts-equivalent)" value={planOptions.awpWeight} onChange={(v) => setP({ awpWeight: v })} hint="0 = optimize raw match points only" />
              <Num label="Predicted opponent Auto score" value={planOptions.opponentAutoScore} onChange={(v) => setP({ opponentAutoScore: v })} />
              <label className="field">
                <span>Plan around other robots</span>
                <input type="checkbox" checked={planOptions.accountForOthers} onChange={(e) => setP({ accountForOthers: e.target.checked })} />
              </label>
            </>
          )}
        </div>
        <div className="row">
          {optStatus === 'idle' ? (
            <button className="primary" onClick={startOptimization}>
              Start optimization
            </button>
          ) : (
            <>
              {optStatus === 'running' ? (
                <button
                  onClick={() => {
                    getClient().pause();
                    store.set({ optStatus: 'paused' });
                  }}
                >
                  Pause
                </button>
              ) : (
                <button
                  onClick={() => {
                    getClient().resume();
                    store.set({ optStatus: 'running' });
                  }}
                >
                  Resume
                </button>
              )}
              <button
                onClick={() => {
                  getClient().resume();
                  getClient().stop();
                }}
              >
                Stop (keep best)
              </button>
            </>
          )}
          <span className="muted small">{optStatus !== 'idle' && progress.length ? `${progress[progress.length - 1].phase} · best ${progress[progress.length - 1].best} · bound ${progress[progress.length - 1].upperBound.toFixed(0)}` : ''}</span>
        </div>
        <LineChart
          title="Best score found vs. admissible upper bound"
          xLabel="seconds"
          yLabel="points"
          step
          yMin={0}
          series={[
            { name: 'Best found', color: SERIES.blue, points: progress.map((p) => ({ x: p.elapsedMs / 1000, y: p.best })) },
            { name: 'Upper bound', color: SERIES.orange, points: progress.map((p) => ({ x: p.elapsedMs / 1000, y: p.upperBound })) },
          ]}
        />
      </section>

      {report && (
        <section className="card">
          <h3>Result</h3>
          <div className={`status ${report.optimality.status}`}>
            <strong>{report.optimality.status === 'verified-optimum' ? 'Verified optimum (within the model)' : 'Best found'}</strong> — {report.optimality.bestValue} pts
            {report.optimality.status !== 'verified-optimum' && <> · bound {report.optimality.upperBound.toFixed(1)} · gap {report.optimality.gap.toFixed(1)}</>}
          </div>
          <p className="small">{report.optimality.explanation}</p>
          <p className="small">
            Practical best ({report.practical.id}): mean {report.practical.robustness?.mean.toFixed(1) ?? '—'} pts in the model Monte Carlo. Recommended plan: <strong>{report.recommended === 'best' ? `${report.best.id} (theoretical)` : `${report.practical.id} (expected)`}</strong>. Search stopped: {report.stoppedBy}, {(report.durationMs / 1000).toFixed(1)} s.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Method</th>
                <th>Score</th>
                <th>Mean</th>
                <th>Worst</th>
                <th>SD</th>
                {report.candidates[0]?.robustness?.pTarget !== null && <th>P(target)</th>}
                <th>Dist.</th>
                <th>Places</th>
                <th>Execute</th>
              </tr>
            </thead>
            <tbody>
              {report.candidates.map((c) => (
                <tr key={c.id} className={c.id === chosenId ? 'sel' : ''}>
                  <td>
                    {c.id}
                    {c.id === report.best.id ? ' ★' : ''}
                    {c.id === report.practical.id ? ' ◆' : ''}
                  </td>
                  <td>{c.method}</td>
                  <td>{c.value}</td>
                  <td>{c.robustness?.mean.toFixed(1) ?? '—'}</td>
                  <td>{c.robustness?.worst ?? '—'}</td>
                  <td>{c.robustness?.sd.toFixed(1) ?? '—'}</td>
                  {c.robustness?.pTarget !== null && c.robustness?.pTarget !== undefined && <td>{(c.robustness.pTarget * 100).toFixed(0)}%</td>}
                  <td>{c.summary.distance.toFixed(0)}"</td>
                  <td>{c.summary.placements}</td>
                  <td>
                    <input type="radio" name="exec" checked={c.id === chosenId} onChange={() => store.set((s) => ({ executePlan: c.id, simVersion: s.simVersion + 1 }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">★ highest theoretical score · ◆ practical best (mean − ¼·SD, or P(target)).</p>
          {report.explanation.versusRunnerUp.length > 0 && (
            <>
              <h4>Why the recommended plan beats the runner-up</h4>
              <ul className="small">
                {report.explanation.versusRunnerUp.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
          <h4>Search space and methods</h4>
          <ul className="small">
            {report.searchSpace.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
          <table className="table small">
            <thead>
              <tr>
                <th>Method</th>
                <th>Best</th>
                <th>Expansions</th>
                <th>ms</th>
                <th>Stopped by</th>
              </tr>
            </thead>
            <tbody>
              {report.methods.map((m, i) => (
                <tr key={i}>
                  <td>{m.method}</td>
                  <td>{isFinite(m.best) ? m.best : '—'}</td>
                  <td>{m.expansions}</td>
                  <td>{m.ms.toFixed(0)}</td>
                  <td>
                    {m.stoppedBy}
                    {m.proven ? ' (proof)' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            Seed {report.settings.seed} · {report.settings.deterministic ? 'deterministic iteration budgets' : `${report.settings.budgetMs / 1000} s wall-clock budget`} · scenario {report.scenario.matchType}, {report.scenario.robotId}, objective {report.scenario.objective}, {report.scenario.externalEvents} predicted events from other robots.
          </p>
        </section>
      )}

      {report && (
        <section className="card">
          <h3>Physics validation (sim-to-real)</h3>
          <p className="small">
            Runs the full Rapier simulation repeatedly with sampled motor ({(uncertainty.motorSd * 100).toFixed(0)}% SD), traction ({(uncertainty.tractionSd * 100).toFixed(0)}% SD), battery ({uncertainty.batteryMin}–{uncertainty.batteryMax} V), sensor noise and object-placement jitter ({uncertainty.objectPosSd}" SD). The executor replans online (MPC). Scores come from the rules engine on the final simulated field.
          </p>
          <div className="row">
            <button className="primary" disabled={st.mcStatus === 'running'} onClick={runPhysicsMc}>
              {st.mcStatus === 'running' ? `Running… ${st.mcScores.length} done` : 'Run physics trials'}
            </button>
          </div>
          {st.physicsStats && (
            <div className="stats">
              <div>
                <span>Mean</span>
                <strong>{st.physicsStats.mean.toFixed(1)}</strong>
              </div>
              <div>
                <span>Median</span>
                <strong>{st.physicsStats.median}</strong>
              </div>
              <div>
                <span>Best</span>
                <strong>{st.physicsStats.best}</strong>
              </div>
              <div>
                <span>Worst</span>
                <strong>{st.physicsStats.worst}</strong>
              </div>
              <div>
                <span>SD</span>
                <strong>{st.physicsStats.sd.toFixed(1)}</strong>
              </div>
              {st.physicsStats.pTarget !== null && (
                <div>
                  <span>P(target)</span>
                  <strong>{(st.physicsStats.pTarget * 100).toFixed(0)}%</strong>
                </div>
              )}
              <div>
                <span>Replans / match</span>
                <strong>{st.physicsStats.meanReplans.toFixed(1)}</strong>
              </div>
            </div>
          )}
          <Histogram title="Physics trial scores (aqua = at or above target)" values={st.mcScores} target={settings.targetScore} />
          {st.physicsStats && st.physicsStats.failures.length > 0 && (
            <>
              <h4>Common failure points</h4>
              <ul className="small">
                {st.physicsStats.failures.slice(0, 8).map((f, i) => (
                  <li key={i}>
                    {f.label}: {f.count}×
                  </li>
                ))}
              </ul>
            </>
          )}
          {(() => {
            const r = report.candidates.find((c) => c.id === chosenId)?.robustness;
            if (!r) return null;
            return (
              <>
                <h4>Model Monte Carlo ({r.trials} trials) for {chosenId}</h4>
                <p className="small">
                  Mean {r.mean.toFixed(1)} · median {r.median} · best {r.best} · worst {r.worst} · variance {r.variance.toFixed(1)}
                  {r.pTarget !== null && <> · P(≥ {r.target}) {(r.pTarget * 100).toFixed(0)}%</>}
                </p>
                <Histogram title="Model trial scores" values={r.samples} target={settings.targetScore} />
                {r.failurePoints.length > 0 && (
                  <ul className="small">
                    {r.failurePoints.slice(0, 6).map((f) => (
                      <li key={f.stepIndex}>
                        Step {f.stepIndex + 1} ({f.label}): failed {f.failures}×, object lost {f.losses}×
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()}
        </section>
      )}
    </div>
  );
}
