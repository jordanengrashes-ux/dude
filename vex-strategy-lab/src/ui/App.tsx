import { store, useApp, type Tab } from './store';
import { FieldPanel } from './components/FieldPanel';
import { OptimizerPanel, startOptimization } from './components/OptimizerPanel';
import { RobotPanel } from './components/RobotPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { TimelinePanel } from './components/TimelinePanel';
import { SetupPanel } from './components/SetupPanel';
import { RulesPanel } from './components/RulesPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

const TABS: { id: Tab; label: string }[] = [
  { id: 'field', label: 'Field' },
  { id: 'optimizer', label: 'Optimizer' },
  { id: 'timeline', label: 'Strategy timeline' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'robot', label: 'Robot' },
  { id: 'setup', label: 'Setup' },
  { id: 'rules', label: 'Rules' },
];

export function App() {
  const tab = useApp((s) => s.tab);
  const matchType = useApp((s) => s.matchType);
  const params = useApp((s) => s.params);
  const message = useApp((s) => s.message);
  const optStatus = useApp((s) => s.optStatus);
  const report = useApp((s) => s.report);
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <strong>VEX V5 Strategy Lab</strong>
          <span className="muted">
            {params.name} {params.season} · manual v{params.manualVersion} · {matchType === 'headToHead' ? 'Head-to-Head' : matchType === 'skillsDriver' ? 'Driver Skills' : 'Autonomous Skills'}
          </span>
        </div>
        <nav role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => store.set({ tab: t.id })}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="quick">
          {optStatus === 'idle' ? (
            <button className="primary" onClick={startOptimization}>
              Optimize
            </button>
          ) : (
            <span className="muted small">Optimizing…</span>
          )}
          {report && (
            <span className="small">
              Best {report.optimality.bestValue} pts ({report.optimality.status === 'verified-optimum' ? 'proven' : `gap ${report.optimality.gap.toFixed(0)}`})
            </span>
          )}
        </div>
      </header>
      {message && (
        <div className="banner" role="status">
          {message}
          <button className="link" onClick={() => store.set({ message: null })}>
            dismiss
          </button>
        </div>
      )}
      <main>
        <div style={{ display: tab === 'field' ? 'block' : 'none' }}>
          <ErrorBoundary name="Field">
            <FieldPanel />
          </ErrorBoundary>
        </div>
        <ErrorBoundary key={tab} name={TABS.find((t) => t.id === tab)!.label}>
          {tab === 'optimizer' && <OptimizerPanel />}
          {tab === 'timeline' && <TimelinePanel />}
          {tab === 'analysis' && <AnalysisPanel />}
          {tab === 'robot' && <RobotPanel />}
          {tab === 'setup' && <SetupPanel />}
          {tab === 'rules' && <RulesPanel />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
