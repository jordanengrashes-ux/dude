import { useEffect, useMemo, useState } from 'react';
import { exportPros, parseProsAuton, type DeviceRole } from '../../auton/pros';
import { previewPath, type AutonProgram } from '../../auton/program';
import { ROBOT_STUDIO, robotStudioProject } from '../../auton/robotStudio';
import { useApp } from '../store';
import { layoutFor, plan, setProgram, startFor, usePlan } from '../planState';
import { FIELD_COLORS, PlanField, RobotGhost } from './PlanField';

/**
 * Code ↔ program: send the plan as PROS C++ (LemLib or EZ-Template) to Robot Studio,
 * or paste PROS code from it to run it here.
 */

const PROJECT_KEY = 'vsl-robot-studio-project';

/** The Robot Studio project link the user gave once, and where Robot Studio opens (that project, or the start page). */
function useProjectLink() {
  const [link, setLink] = useState(() => {
    try {
      return localStorage.getItem(PROJECT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const save = (v: string) => {
    setLink(v);
    try {
      localStorage.setItem(PROJECT_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };
  return { link, save, url: robotStudioProject(link) ?? ROBOT_STUDIO };
}

function ProjectLink({ link, save }: { link: string; save: (v: string) => void }) {
  const bad = link.trim() !== '' && !robotStudioProject(link);
  return (
    <label className="small rs-project">
      <span>Your Robot Studio project</span>
      <input type="url" value={link} placeholder="paste its link once: robotstudio.ct839.com/p/…" spellCheck={false} onChange={(e) => save(e.target.value)} />
      {bad && <span className="rs-bad">not a Robot Studio project link (robotstudio.ct839.com/p/…)</span>}
    </label>
  );
}

/** Copies right away, inside the click, before a new tab takes the focus; the async clipboard is the fallback. */
function copyNow(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (ok) return true;
  if (!navigator.clipboard?.writeText) return false;
  void navigator.clipboard.writeText(text).catch(() => undefined);
  return true;
}

const key = (k: string) => (/Mac|iPhone|iPad/.test(navigator.platform) ? `⌘${k}` : `Ctrl+${k}`);

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row modal-head">
          <h3>{title}</h3>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const close = () => plan.set({ dialog: null });

export function ExportDialog() {
  const program = usePlan((s) => s.program);
  const robot = useApp((s) => s.robot);
  const [flavor, setFlavor] = useState<'lemlib' | 'ez'>(() => (localStorage.getItem('vsl-export-flavor') === 'ez' ? 'ez' : 'lemlib'));
  const [full, setFull] = useState(() => localStorage.getItem('vsl-export-full') !== '0');
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState<'copied' | 'failed' | null>(null);
  const project = useProjectLink();
  useEffect(() => {
    try {
      localStorage.setItem('vsl-export-flavor', flavor);
      localStorage.setItem('vsl-export-full', full ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [flavor, full]);
  const code = useMemo(() => exportPros(program, { flavor, full, robot }), [program, flavor, full, robot]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/x-c++src' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = full ? 'main.cpp' : 'autonomous.cpp';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const send = () => {
    const ok = copyNow(code);
    window.open(project.url, '_blank', 'noopener');
    setSent(ok ? 'copied' : 'failed');
  };
  return (
    <Modal title="Export as PROS C++" onClose={close}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="segmented" role="group" aria-label="Library">
          <button className={flavor === 'lemlib' ? 'on' : ''} onClick={() => setFlavor('lemlib')}>
            LemLib
          </button>
          <button className={flavor === 'ez' ? 'on' : ''} onClick={() => setFlavor('ez')}>
            EZ-Template
          </button>
        </div>
        <label className="small">
          <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> whole main.cpp (devices, chassis, driver control)
        </label>
      </div>
      <p className="small muted">
        {flavor === 'lemlib'
          ? 'Field-centric: setPose puts the robot on its starting tile, every point is in field inches. Start the robot on that tile, facing the same way.'
          : 'Relative: drives and turns from where the robot starts (EZ-Template headings: 0° = the way it faces at the start, clockwise positive).'}{' '}
        Ports, gearsets and PID gains are placeholders for your robot.
      </p>
      <textarea className="code" readOnly value={code} spellCheck={false} onFocus={(e) => e.target.select()} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="primary" onClick={send} title="Copies the code and opens Robot Studio in a new tab">
          Send to Robot Studio ↗
        </button>
        <button
          onClick={() => {
            if (!copyNow(code)) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <button onClick={download}>Download {full ? 'main.cpp' : 'autonomous.cpp'}</button>
      </div>
      {sent && (
        <p className="small rs-steps" role="status">
          {sent === 'failed' ? (
            <>
              This browser didn’t let the code be copied: click the code box, press {key('A')}, {key('C')}, then paste it in the Robot Studio tab.
            </>
          ) : full ? (
            <>
              Copied. In the Robot Studio tab, open <code>src/main.cpp</code> and press {key('A')}, {key('V')}.
            </>
          ) : (
            <>
              Copied. In the Robot Studio tab, select your <code>autonomous()</code> function and press {key('V')}.
            </>
          )}
          {project.url === ROBOT_STUDIO && ' Paste your project’s link below and Send opens that project straight away.'}
        </p>
      )}
      <ProjectLink link={project.link} save={project.save} />
    </Modal>
  );
}

const ROLES: { v: DeviceRole; label: string }[] = [
  { v: 'lift', label: 'Lift (arm)' },
  { v: 'claw', label: 'Claw' },
  { v: 'toggleArm', label: 'Toggle arm' },
  { v: 'leftDrive', label: 'Left drive' },
  { v: 'rightDrive', label: 'Right drive' },
  { v: 'ignore', label: 'Ignore' },
];

export function ImportDialog() {
  const program = usePlan((s) => s.program);
  const robot = useApp((s) => s.robot);
  const [code, setCode] = useState(() => localStorage.getItem('vsl-import-code') ?? '');
  const update = (v: string) => {
    setCode(v);
    try {
      localStorage.setItem('vsl-import-code', v);
    } catch {
      /* storage unavailable */
    }
  };
  const [note, setNote] = useState<string | null>(null);
  const pasteClip = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        update(text);
        setNote(null);
      } else setNote(`The clipboard is empty: in Robot Studio press ${key('A')}, ${key('C')} in your file first.`);
    } catch {
      setNote(`This browser didn’t let the clipboard be read: click the code box and press ${key('V')}.`);
    }
  };
  const project = useProjectLink();
  const [roles, setRoles] = useState<Record<string, DeviceRole>>({});
  const [entry, setEntry] = useState<string | undefined>(undefined);
  const [clawTrue, setClawTrue] = useState(true);
  const res = useMemo(() => (code.trim() ? parseProsAuton(code, { robot, roles, entry, clawClosedValue: clawTrue }) : null), [code, robot, roles, entry, clawTrue]);
  const draft: AutonProgram | null = res ? { name: res.entry && res.entry !== 'autonomous' ? res.entry : `${program.name} (imported)`, slot: program.slot, mode: program.mode, steps: res.steps } : null;
  const start = startFor(program);
  const pv = draft && start ? previewPath(draft.steps, start) : [];
  const color = program.slot.startsWith('blue') ? FIELD_COLORS.blue : FIELD_COLORS.red;
  return (
    <Modal title="Import PROS C++ code" onClose={close}>
      <p className="small muted">
        Bring in your autonomous from Robot Studio (or any PROS project): LemLib, EZ-Template or plain motor calls. In Robot Studio, open your file and press {key('A')}, {key('C')}, then
        come back and click Paste from clipboard. It runs on {program.slot}'s tile as a {program.mode === 'skills' ? 'Skills' : 'match'} autonomous; code without setPose starts at (0, 0, 0)
        there.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <a className="button" href={project.url} target="_blank" rel="noopener noreferrer">
          Open Robot Studio ↗
        </a>
        <button className="primary" onClick={() => void pasteClip()}>
          Paste from clipboard
        </button>
        {note && (
          <span className="small rs-bad" role="status">
            {note}
          </span>
        )}
      </div>
      <ProjectLink link={project.link} save={project.save} />
      <div className="import-grid">
        <textarea
          className="code"
          placeholder={'void autonomous() {\n  chassis.setPose(-62.2, 6, 90);\n  chassis.moveToPoint(-36, 6, 2000);\n  ...\n}'}
          value={code}
          spellCheck={false}
          onChange={(e) => update(e.target.value)}
        />
        <div className="import-preview">
          <PlanField layout={layoutFor(program.mode)} highlightSlot={program.slot} cursor="default">
            {pv.length > 1 && <polyline points={pv.map((p) => `${p.pos.x},${p.pos.y}`).join(' ')} fill="none" stroke={color} strokeWidth={0.9} />}
            {pv.length > 0 && <RobotGhost pos={pv[pv.length - 1].pos} heading={pv[pv.length - 1].heading} color={color} opacity={0.6} dashed />}
          </PlanField>
        </div>
      </div>
      {res && (
        <div className="small import-result">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>
              <strong>{res.steps.length}</strong> steps · {res.dialect === 'lemlib' ? 'LemLib' : res.dialect === 'ez' ? 'EZ-Template' : res.dialect === 'pros' ? 'plain PROS' : 'no motion calls found'}
            </span>
            {res.functions.length > 1 && (
              <label>
                Run{' '}
                <select value={entry ?? res.entry ?? ''} onChange={(e) => setEntry(e.target.value)}>
                  {res.functions.map((f) => (
                    <option key={f} value={f}>
                      {f}()
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label title="What set_value(true) does to the claw piston">
              claw piston true ={' '}
              <select value={clawTrue ? 'closed' : 'open'} onChange={(e) => setClawTrue(e.target.value === 'closed')}>
                <option value="closed">closed</option>
                <option value="open">open</option>
              </select>
            </label>
          </div>
          {res.devices.length > 0 && (
            <table className="table small devices">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Type</th>
                  <th>Is the robot's</th>
                </tr>
              </thead>
              <tbody>
                {res.devices.map((d) => (
                  <tr key={d.name}>
                    <td>
                      <code>{d.name}</code>
                    </td>
                    <td>{d.type}</td>
                    <td>
                      <select value={roles[d.name] ?? d.role ?? ''} onChange={(e) => setRoles({ ...roles, [d.name]: e.target.value as DeviceRole })}>
                        <option value="" disabled>
                          choose…
                        </option>
                        {ROLES.map((r) => (
                          <option key={r.v} value={r.v}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {res.warnings.length > 0 && (
            <ul className="warnings">
              {res.warnings.map((w, i) => (
                <li key={i}>
                  line {w.line}: {w.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button
          className="primary"
          disabled={!draft || !draft.steps.length}
          onClick={() => {
            if (!draft) return;
            setProgram(draft);
            plan.set({ dialog: null, selected: null });
          }}
        >
          Use this program
        </button>
        <button onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}
