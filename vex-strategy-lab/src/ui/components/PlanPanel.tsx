import { plan, usePlan } from '../planState';
import { AutonEditor } from './AutonEditor';
import { Whiteboard } from './Whiteboard';

/** Plan tab: build an autonomous (run it, export / import PROS code) or sketch a strategy. */
export function PlanPanel() {
  const view = usePlan((s) => s.view);
  return (
    <div className="plan-panel">
      <div className="row plan-tabs">
        <div className="segmented" role="group" aria-label="Plan">
          <button className={view === 'auton' ? 'on' : ''} onClick={() => plan.set({ view: 'auton' })}>
            Autonomous
          </button>
          <button className={view === 'board' ? 'on' : ''} onClick={() => plan.set({ view: 'board' })}>
            Whiteboard
          </button>
        </div>
        <span className="small muted">
          {view === 'auton'
            ? 'Draw your autonomous on the field, run it with physics, then send it to Robot Studio as PROS code — or bring your code back and watch it run.'
            : 'Sketch a match plan with your team: routes, arrows, notes and robots.'}
        </span>
      </div>
      {view === 'auton' ? <AutonEditor /> : <Whiteboard />}
    </div>
  );
}
