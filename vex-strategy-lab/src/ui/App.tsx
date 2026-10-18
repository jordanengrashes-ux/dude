import { setPractice, store, useApp, type Tab } from './store';
import { FieldPanel } from './components/FieldPanel';
import { OptimizerPanel, startOptimization } from './components/OptimizerPanel';
import { RobotPanel } from './components/RobotPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { TimelinePanel } from './components/TimelinePanel';
import { SetupPanel } from './components/SetupPanel';
import { RulesPanel } from './components/RulesPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TeamPanel, inviteLink, savedPlayerName } from './components/TeamPanel';
import { useEffect, useState } from 'react';
import { team, useTeam } from '../net/session';
import { PlanPanel } from './components/PlanPanel';

const TABS: { id: Tab; label: string }[] = [
  { id: 'field', label: 'Field' },
  { id: 'plan', label: 'Plan' },
  { id: 'team', label: 'Team' },
  { id: 'optimizer', label: 'Optimizer' },
  { id: 'timeline', label: 'Strategy timeline' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'robot', label: 'Robot' },
  { id: 'setup', label: 'Setup' },
  { id: 'rules', label: 'Rules' },
];

/**
 * Team mode starts with the page: join the room in the link (?room=CODE) or open
 * one. The address bar then always holds the invite link.
 */
function useAutoTeam() {
  const t = useTeam();
  const practice = useApp((s) => s.practice);
  useEffect(() => {
    // the room is always open (Practice too): someone opening the invite link switches
    // a practicing host to a match and takes a robot
    if (team.session) team.session.needMatch = () => setPractice(false);
    const room = new URLSearchParams(window.location.search).get('room');
    void team.session?.autoStart(savedPlayerName(), room ? room.trim().toUpperCase() : null);
  }, []);
  useEffect(() => {
    if (!t.room && t.connecting) return;
    const url = new URL(window.location.href);
    if (t.room) url.searchParams.set('room', t.room);
    else url.searchParams.delete('room');
    // a reload stays where you were: a room link alone joins a match, so practice says so
    if (practice) {
      if (t.room) url.searchParams.set('mode', 'practice');
      else url.searchParams.delete('mode');
    } else if (!t.room) url.searchParams.set('mode', 'match');
    else url.searchParams.delete('mode');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [t.room, t.connecting, practice]);
  return t;
}

/** Room code and invite link in the header. */
function RoomBadge({ room, players, online }: { room: string; players: number; online: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="link small"
      title={online ? 'Copy the invite link: whoever opens it joins this match' : 'Room between tabs of this browser (online play unavailable)'}
      onClick={() => {
        void navigator.clipboard?.writeText(inviteLink(room));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      Room {room} · {players} player{players === 1 ? '' : 's'} · {copied ? 'link copied' : 'copy invite link'}
    </button>
  );
}

export function App() {
  const t = useAutoTeam();
  const practice = useApp((s) => s.practice);
  const watching = useApp((s) => s.autonRun);
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
          <div className="segmented" role="group" aria-label="Mode">
            <button className={!practice && !watching ? 'on' : ''} onClick={() => setPractice(false)} title="Bots and players on both alliances">
              Match
            </button>
            <button className={practice && !watching ? 'on' : ''} onClick={() => setPractice(true)} title="Only your robot on the field; you drive from the start (your room stays open: a friend joining switches to a match)">
              Practice
            </button>
            {watching && (
              <button className="on" onClick={() => store.set({ tab: 'plan' })} title="An autonomous from Plan mode is running on the field; Match or Practice ends it">
                Auton: {watching.name}
              </button>
            )}
          </div>
          {t.room && <RoomBadge room={t.room} players={Math.max(1, t.peers.length)} online={t.transport === 'online'} />}
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
          {tab === 'plan' && <PlanPanel />}
          {tab === 'team' && <TeamPanel />}
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
