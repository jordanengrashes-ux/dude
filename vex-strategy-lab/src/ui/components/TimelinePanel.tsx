import { useEffect, useState } from 'react';
import { runner } from '../simRunner';
import { useApp } from '../store';

/** Planned strategy timeline with explanations, deadlines and rejected alternatives; executed actions overlaid. */
export function TimelinePanel() {
  const report = useApp((s) => s.report);
  const userSlot = useApp((s) => s.userSlot);
  const exec = useApp((s) => s.executePlan);
  const [, set] = useState(0);
  useEffect(() => runner.subscribe(() => set((x) => x + 1)), []);
  if (!report) return <div className="card">Run the optimizer to see the planned strategy timeline.</div>;
  const chosen = report.candidates.find((c) => c.id === (exec ?? report.best.id)) ?? report.best;
  const steps = chosen.steps;
  const total = report.scenario.window[1];
  const expl = chosen.id === (report.recommended === 'best' ? report.best.id : report.practical.id) ? report.explanation.steps : null;
  const ex = runner.built?.executors.get(userSlot);
  const autoEnd = report.scenario.matchType === 'headToHead' ? 15 : null;
  const color = (t: string) => (t === 'place' ? '#ffd54f' : t === 'pick' || t === 'load' ? '#80cbc4' : t === 'toggle' ? '#ce93d8' : t === 'park' ? '#ffffff' : '#757575');
  return (
    <div className="card wide">
      <h3>
        Strategy timeline — {chosen.id} ({chosen.method}) · {chosen.value} pts
      </h3>
      <div className="gantt" role="img" aria-label="Planned actions over match time">
        <div className="gantt-axis">
          {Array.from({ length: Math.floor(total / 10) + 1 }, (_, i) => (
            <span key={i} style={{ left: `${((i * 10) / total) * 100}%` }}>
              {i * 10}s
            </span>
          ))}
          {autoEnd && <span className="deadline" style={{ left: `${(autoEnd / total) * 100}%` }} title="End of Autonomous" />}
          <span className="deadline endgame" style={{ left: `${((total - 10) / total) * 100}%` }} title="Endgame begins" />
        </div>
        <div className="gantt-row">
          <span className="gantt-label">Plan</span>
          {steps.map((s, i) => (
            <span key={i} className="bar" title={`${i + 1}. ${s.label} (${s.tStart.toFixed(1)}–${s.tEnd.toFixed(1)} s) → ${s.valueAfter} pts`} style={{ left: `${(s.tStart / total) * 100}%`, width: `${Math.max(0.3, ((s.tEnd - s.tStart) / total) * 100)}%`, background: color(s.action.type) }} />
          ))}
        </div>
        {ex && (
          <div className="gantt-row">
            <span className="gantt-label">Executed</span>
            {ex.history.map((h, i) => (
              <span key={i} className={`bar ${h.ok ? '' : 'fail'}`} title={`${h.label} (${h.tStart.toFixed(1)}–${h.tEnd.toFixed(1)} s)${h.ok ? '' : ` — ${h.reason}`}`} style={{ left: `${(h.tStart / total) * 100}%`, width: `${Math.max(0.3, ((h.tEnd - h.tStart) / total) * 100)}%`, background: h.ok ? '#5c8fd6' : '#d95926' }} />
            ))}
          </div>
        )}
        <div className="legend small">
          <span><i style={{ background: '#80cbc4' }} />pick / load</span>
          <span><i style={{ background: '#ffd54f' }} />place</span>
          <span><i style={{ background: '#ce93d8' }} />toggle</span>
          <span><i style={{ background: '#ffffff' }} />park</span>
          <span><i style={{ background: '#d95926' }} />failed (executed)</span>
        </div>
      </div>
      <table className="table timeline">
        <thead>
          <tr>
            <th>#</th>
            <th>Start</th>
            <th>End</th>
            <th>Action</th>
            <th>Score after</th>
            <th>Why</th>
            <th>Time breakdown</th>
            <th>Rejected alternatives</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            const e = expl?.[i];
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{s.tStart.toFixed(2)}</td>
                <td>{s.tEnd.toFixed(2)}</td>
                <td>
                  {s.label}
                  {e?.deadline && <div className="deadline-note">⏱ {e.deadline}</div>}
                </td>
                <td>
                  {s.valueAfter}
                  {s.valueAfter !== s.valueBefore && <span className={s.valueAfter > s.valueBefore ? 'up' : 'down'}> ({s.valueAfter > s.valueBefore ? '+' : ''}{s.valueAfter - s.valueBefore})</span>}
                </td>
                <td className="small">{e?.why ?? ''}</td>
                <td className="small muted">{e?.timeBreakdown ?? `${(s.tEnd - s.tStart).toFixed(2)} s`}</td>
                <td className="small">
                  {e?.alternatives.map((a, k) => (
                    <div key={k}>
                      {a.label}: {a.finalValue} ({a.delta >= 0 ? '+' : ''}
                      {a.delta}) — {a.reason}
                    </div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!expl && <p className="small muted">Detailed explanations are generated for the recommended plan; select it to see them.</p>}
    </div>
  );
}
