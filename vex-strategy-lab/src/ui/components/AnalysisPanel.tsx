import { useEffect, useState } from 'react';
import { runner } from '../simRunner';
import { useApp } from '../store';
import { BarChart, LineChart, SERIES } from '../charts/Charts';
import { TopDown } from './TopDown';
import { usePlanSteps } from './FieldPanel';

function useSlowTick() {
  const [, set] = useState(0);
  useEffect(() => {
    let last = 0;
    return runner.subscribe(() => {
      const now = performance.now();
      if (now - last > 400) {
        last = now;
        set((x) => x + 1);
      }
    });
  }, []);
}

export function AnalysisPanel() {
  useSlowTick();
  const userSlot = useApp((s) => s.userSlot);
  const report = useApp((s) => s.report);
  const steps = usePlanSteps();
  const sim = runner.sim;
  const tel = sim ? sim.telemetry.filter((t) => t.robotId === userSlot) : [];
  const ex = runner.built?.executors.get(userSlot);
  const history = ex?.history ?? [];
  const isH2H = sim?.clock.matchType === 'headToHead';
  const timeline = sim?.scoreTimeline ?? [];
  const final = timeline.length ? timeline[timeline.length - 1] : null;
  const alliance = sim?.robot(userSlot)?.alliance ?? 'red';
  const own = final ? final[alliance] : 0;
  const elapsed = sim?.t ?? 0;
  const byType = new Map<string, number>();
  for (const h of history) byType.set(h.label.split(' ')[0], (byType.get(h.label.split(' ')[0]) ?? 0) + (h.tEnd - h.tStart));
  return (
    <div className="panel-grid">
      <section className="card">
        <h3>Score</h3>
        <div className="stats">
          <div>
            <span>{alliance} now</span>
            <strong>{own}</strong>
          </div>
          <div>
            <span>Points / second</span>
            <strong>{elapsed > 0 ? (own / elapsed).toFixed(2) : '—'}</strong>
          </div>
          <div>
            <span>Actions OK / failed</span>
            <strong>
              {history.filter((h) => h.ok).length} / {history.filter((h) => !h.ok).length}
            </strong>
          </div>
          <div>
            <span>Replans (MPC)</span>
            <strong>{ex?.replans ?? 0}</strong>
          </div>
        </div>
        <LineChart
          title="Score timeline (rules engine, incl. Autonomous Bonus once decided)"
          xLabel="match seconds"
          yLabel="points"
          step
          yMin={0}
          series={
            isH2H
              ? [
                  { name: 'Red', color: SERIES.red, points: timeline.map((p) => ({ x: p.t, y: p.red })) },
                  { name: 'Blue', color: SERIES.blue, points: timeline.map((p) => ({ x: p.t, y: p.blue })) },
                ]
              : [{ name: 'Score', color: SERIES.blue, points: timeline.map((p) => ({ x: p.t, y: p.red })) }]
          }
        />
      </section>
      <section className="card">
        <h3>Trajectory — {userSlot}</h3>
        <TopDown steps={steps} height={320} />
      </section>
      <section className="card">
        <h3>Motion — {userSlot}</h3>
        <LineChart title="Forward velocity" xLabel="s" yLabel="in/s" series={[{ name: 'Velocity', color: SERIES.blue, points: tel.map((t) => ({ x: t.t, y: t.speed })) }]} />
        <LineChart title="Forward acceleration" xLabel="s" yLabel="in/s²" series={[{ name: 'Acceleration', color: SERIES.blue, points: tel.map((t) => ({ x: t.t, y: Math.max(-600, Math.min(600, t.accel)) })) }]} />
        <LineChart
          title="Motor utilization (|τ| / stall)"
          xLabel="s"
          yLabel="fraction"
          yMin={0}
          series={[
            { name: 'Left drive', color: SERIES.blue, points: tel.map((t) => ({ x: t.t, y: t.utilLeft })) },
            { name: 'Right drive', color: SERIES.orange, points: tel.map((t) => ({ x: t.t, y: t.utilRight })) },
            { name: 'Lift', color: SERIES.aqua, points: tel.map((t) => ({ x: t.t, y: t.utilLift })) },
          ]}
        />
      </section>
      <section className="card">
        <h3>Execution</h3>
        <BarChart title="Time per executed action" unit="s" bars={history.map((h) => ({ label: h.label, value: h.tEnd - h.tStart, color: h.ok ? SERIES.blue : SERIES.orange, note: h.ok ? Object.entries(h.phases).map(([k, v]) => `${k} ${v.toFixed(2)}s`).join(' · ') : `failed: ${h.reason}` }))} />
        <BarChart title="Time by action type" unit="s" bars={[...byType].map(([k, v]) => ({ label: k, value: v }))} />
        <h4>Failed attempts</h4>
        <ul className="small list">
          {history.filter((h) => !h.ok).map((h, i) => (
            <li key={i}>
              {h.tStart.toFixed(1)}–{h.tEnd.toFixed(1)} s · {h.label}: {h.reason}
            </li>
          ))}
          {!history.some((h) => !h.ok) && <li className="muted">None.</li>}
        </ul>
      </section>
      <section className="card">
        <h3>Collisions & violations</h3>
        <ul className="small list">
          {(sim?.events ?? []).filter((e) => e.type === 'collision').slice(-30).map((e, i) => (
            <li key={i}>
              {e.t.toFixed(2)} s · {e.text}
            </li>
          ))}
          {!(sim?.events ?? []).some((e) => e.type === 'collision') && <li className="muted">No collisions.</li>}
        </ul>
        <h4>Rule violations</h4>
        <ul className="small list">
          {(sim?.violations ?? []).map((v, i) => (
            <li key={i}>
              {v.time.toFixed(1)} s · <strong>{v.ruleId}</strong> ({v.severity}, {v.period}) — {v.description}
            </li>
          ))}
          {!(sim?.violations ?? []).length && <li className="muted">None.</li>}
        </ul>
      </section>
      {report && (
        <section className="card">
          <h3>Candidate strategies</h3>
          <BarChart title="Theoretical score by candidate" unit="pts" bars={report.candidates.map((c) => ({ label: `${c.id} · ${c.method}`, value: c.value, note: `${c.summary.placements} placements, ${c.summary.distance.toFixed(0)}" driven` }))} />
          <BarChart title="Model Monte Carlo mean by candidate" unit="pts" bars={report.candidates.map((c) => ({ label: c.id, value: c.robustness?.mean ?? 0, color: SERIES.aqua, note: c.robustness ? `SD ${c.robustness.sd.toFixed(1)}, worst ${c.robustness.worst}` : '' }))} />
        </section>
      )}
      <section className="card wide">
        <h3>Event log (scoring is rules-engine output)</h3>
        <ul className="small list log">
          {(sim?.events ?? []).slice(-120).reverse().map((e, i) => (
            <li key={i} className={e.type}>
              {e.t.toFixed(2)} · {e.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
