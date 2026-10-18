import { OVERRIDE_RULES } from '../../rules/ruleset';
import { LAST_CHECKED, SOURCES } from '../../rules/sources';
import { useApp } from '../store';

const LABEL = { 'official-extract': 'Official (extract)', secondary: 'Secondary source', conflicting: 'Sources conflict', assumption: 'Assumption' } as const;

export function RulesPanel() {
  const params = useApp((s) => s.params);
  return (
    <div className="card wide">
      <h3>
        Ruleset: {params.name} {params.season}, manual v{params.manualVersion}
      </h3>
      <p className="small">
        Last checked {LAST_CHECKED}. The official manual and Q&amp;A sites could not be opened directly from the build environment, so most rule text was taken from search-engine extracts of those official pages; the field dimensions and the starting layout were measured on the Appendix A drawings of the v1.1 manual PDF. Every rule is tagged with how it was verified. Values marked “Assumption” or “Sources conflict” are editable under Setup → Rule interpretation switches. Re-verify against the current manual before relying on them.
      </p>
      <table className="table rules">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Implemented as</th>
            <th>Verification</th>
            <th>Sources</th>
          </tr>
        </thead>
        <tbody>
          {OVERRIDE_RULES.map((r) => (
            <tr key={r.ruleId + r.title}>
              <td>
                <strong>{r.ruleId}</strong>
                <div className="small muted">{r.title}</div>
              </td>
              <td className="small">
                {r.implemented}
                {r.notes && <div className="muted">{r.notes}</div>}
              </td>
              <td>
                <span className={`badge ${r.verification}`}>{LABEL[r.verification]}</span>
              </td>
              <td className="small">
                {r.sources.map((sid) => (
                  <div key={sid}>
                    <a href={SOURCES[sid].url} target="_blank" rel="noreferrer">
                      {SOURCES[sid].title}
                    </a>
                  </div>
                ))}
                {!r.sources.length && <span className="muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
