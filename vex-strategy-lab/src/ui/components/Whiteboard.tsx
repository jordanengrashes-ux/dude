import { useRef, useState } from 'react';
import type { Vec2 } from '../../core/vec';
import { distToSegment } from '../../core/vec';
import { plan, usePlan, layoutFor, type Board, type BoardColor, type BoardTool, type Shape } from '../planState';
import { FIELD_COLORS, FieldText, PlanField, RobotGhost } from './PlanField';

/**
 * Strategy whiteboard: draw routes, arrows and notes, and place robots over the
 * field. Several boards, saved in this browser; export a picture to share.
 */

const COLORS: BoardColor[] = ['yellow', 'red', 'blue', 'white', 'green'];
const TOOLS: { v: BoardTool; label: string; title: string }[] = [
  { v: 'pen', label: 'Pen', title: 'Draw freehand' },
  { v: 'arrow', label: 'Arrow', title: 'Drag to draw an arrow' },
  { v: 'text', label: 'Note', title: 'Click to write a note' },
  { v: 'red-robot', label: 'Red robot', title: 'Click to place, drag to aim' },
  { v: 'blue-robot', label: 'Blue robot', title: 'Click to place, drag to aim' },
  { v: 'eraser', label: 'Eraser', title: 'Click a drawing to remove it' },
];

const col = (c: BoardColor) => (c === 'red' ? FIELD_COLORS.red : c === 'blue' ? FIELD_COLORS.blue : c === 'yellow' ? FIELD_COLORS.yellow : c === 'green' ? FIELD_COLORS.green : FIELD_COLORS.white);
const uid = () => Math.random().toString(36).slice(2, 9);

function hit(s: Shape, p: Vec2): boolean {
  const v = (a: [number, number]) => ({ x: a[0], y: a[1] });
  switch (s.kind) {
    case 'pen':
      return s.points.some((q, i) => i > 0 && distToSegment(p, v(s.points[i - 1]), v(q)) < 2);
    case 'arrow':
      return distToSegment(p, v(s.from), v(s.to)) < 2;
    case 'text':
      return Math.hypot(p.x - s.at[0], p.y - s.at[1]) < 5;
    case 'robot':
      return Math.hypot(p.x - s.at[0], p.y - s.at[1]) < 9;
  }
}

export function Whiteboard() {
  const boards = usePlan((s) => s.boards);
  const boardId = usePlan((s) => s.boardId);
  const tool = usePlan((s) => s.tool);
  const color = usePlan((s) => s.color);
  const [pieces, setPieces] = useState(true);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [past, setPast] = useState<Shape[][]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const board = boards.find((b) => b.id === boardId) ?? boards[0];
  const layout = layoutFor('match');

  const setShapes = (shapes: Shape[]) => {
    setPast((h) => [...h.slice(-49), board.shapes]);
    plan.set((s) => ({ boards: s.boards.map((b) => (b.id === board.id ? { ...b, shapes } : b)) }));
  };
  const updateBoard = (patch: Partial<Board>) => plan.set((s) => ({ boards: s.boards.map((b) => (b.id === board.id ? { ...b, ...patch } : b)) }));

  const down = (p: Vec2) => {
    const at: [number, number] = [p.x, p.y];
    if (tool === 'pen') setDraft({ id: uid(), kind: 'pen', color, points: [at] });
    else if (tool === 'arrow') setDraft({ id: uid(), kind: 'arrow', color, from: at, to: at });
    else if (tool === 'red-robot' || tool === 'blue-robot') {
      const alliance = tool === 'red-robot' ? 'red' : 'blue';
      const n = board.shapes.filter((s) => s.kind === 'robot' && s.alliance === alliance).length + 1;
      setDraft({ id: uid(), kind: 'robot', alliance, at, heading: alliance === 'red' ? 0 : Math.PI, label: `${alliance === 'red' ? 'R' : 'B'}${n}` });
    } else if (tool === 'text') {
      const text = window.prompt('Note');
      if (text?.trim()) setShapes([...board.shapes, { id: uid(), kind: 'text', color, at, text: text.trim() }]);
    } else if (tool === 'eraser') {
      const victim = [...board.shapes].reverse().find((s) => hit(s, p));
      if (victim) setShapes(board.shapes.filter((s) => s.id !== victim.id));
    }
  };
  const move = (p: Vec2, e: React.PointerEvent) => {
    if (!draft || !e.buttons) return;
    if (draft.kind === 'pen') {
      const last = draft.points[draft.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.6) setDraft({ ...draft, points: [...draft.points, [p.x, p.y]] });
    } else if (draft.kind === 'arrow') setDraft({ ...draft, to: [p.x, p.y] });
    else if (draft.kind === 'robot' && Math.hypot(p.x - draft.at[0], p.y - draft.at[1]) > 2) setDraft({ ...draft, heading: Math.atan2(p.y - draft.at[1], p.x - draft.at[0]) });
  };
  const up = () => {
    if (!draft) return;
    const keep = draft.kind === 'pen' ? draft.points.length > 1 : draft.kind === 'arrow' ? Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) > 2 : true;
    if (keep) setShapes([...board.shapes, draft]);
    setDraft(null);
  };

  const exportPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 1200;
      const g = c.getContext('2d')!;
      g.fillStyle = '#161718';
      g.fillRect(0, 0, 1200, 1200);
      g.drawImage(img, 0, 0, 1200, 1200);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = `${board.name.replace(/[^\w-]+/g, '_') || 'board'}.png`;
      a.click();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"'));
  };

  const shapes = draft ? [...board.shapes, draft] : board.shapes;
  return (
    <div className="plan-layout">
      <div className="plan-main">
        <div className="row plan-toolbar" style={{ flexWrap: 'wrap' }}>
          <div className="segmented" role="group" aria-label="Tool">
            {TOOLS.map((t) => (
              <button key={t.v} className={tool === t.v ? 'on' : ''} title={t.title} onClick={() => plan.set({ tool: t.v })}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="row swatches" role="group" aria-label="Color">
            {COLORS.map((c) => (
              <button key={c} className={`swatch${color === c ? ' on' : ''}`} style={{ background: col(c) }} aria-label={c} title={c} onClick={() => plan.set({ color: c })} />
            ))}
          </div>
          <button disabled={!past.length} onClick={() => {
            const prev = past[past.length - 1];
            setPast((h) => h.slice(0, -1));
            updateBoard({ shapes: prev });
          }}>
            Undo
          </button>
          <label className="small">
            <input type="checkbox" checked={pieces} onChange={(e) => setPieces(e.target.checked)} /> game pieces
          </label>
        </div>
        <PlanField
          svgRef={svgRef}
          layout={pieces ? layout : { ...layout, pins: [], cups: [] }}
          cursor={tool === 'eraser' ? 'not-allowed' : tool === 'text' ? 'text' : 'crosshair'}
          pointer={{
            down: (p, e) => {
              (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
              down(p);
            },
            move,
            up,
          }}
        >
          {shapes.map((s) => {
            switch (s.kind) {
              case 'pen':
                return <polyline key={s.id} points={s.points.map((q) => q.join(',')).join(' ')} fill="none" stroke={col(s.color)} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />;
              case 'arrow': {
                const [x1, y1] = s.from;
                const [x2, y2] = s.to;
                const a = Math.atan2(y2 - y1, x2 - x1);
                const h = 3.2;
                const p1 = `${x2 - h * Math.cos(a - 0.45)},${y2 - h * Math.sin(a - 0.45)}`;
                const p2 = `${x2 - h * Math.cos(a + 0.45)},${y2 - h * Math.sin(a + 0.45)}`;
                return (
                  <g key={s.id}>
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={col(s.color)} strokeWidth={1.1} strokeLinecap="round" />
                    <polygon points={`${x2},${y2} ${p1} ${p2}`} fill={col(s.color)} />
                  </g>
                );
              }
              case 'text':
                return (
                  <g key={s.id}>
                    <FieldText x={s.at[0]} y={s.at[1]} size={3.6} fill={col(s.color)} weight={700}>
                      {s.text}
                    </FieldText>
                  </g>
                );
              case 'robot':
                return (
                  <g key={s.id}>
                    <RobotGhost pos={{ x: s.at[0], y: s.at[1] }} heading={s.heading} color={s.alliance === 'red' ? FIELD_COLORS.red : FIELD_COLORS.blue} />
                    <FieldText x={s.at[0]} y={s.at[1]} size={3.2} weight={700}>
                      {s.label}
                    </FieldText>
                  </g>
                );
            }
          })}
        </PlanField>
      </div>
      <aside className="plan-side">
        <section className="card">
          <h4>Boards</h4>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select aria-label="Board" value={board.id} onChange={(e) => {
              plan.set({ boardId: e.target.value });
              setPast([]);
            }}>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <input aria-label="Board name" value={board.name} onChange={(e) => updateBoard({ name: e.target.value })} style={{ flex: 1, minWidth: 100 }} />
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button onClick={() => {
              const b: Board = { id: uid(), name: `Board ${boards.length + 1}`, shapes: [] };
              plan.set((s) => ({ boards: [...s.boards, b], boardId: b.id }));
              setPast([]);
            }}>
              New board
            </button>
            <button disabled={!board.shapes.length} onClick={() => setShapes([])}>
              Clear
            </button>
            <button className="primary" onClick={exportPng}>
              Save picture
            </button>
            {boards.length > 1 && (
              <button className="link" onClick={() => {
                if (!confirm(`Delete "${board.name}"?`)) return;
                plan.set((s) => {
                  const rest = s.boards.filter((b) => b.id !== board.id);
                  return { boards: rest, boardId: rest[0].id };
                });
                setPast([]);
              }}>
                Delete board
              </button>
            )}
          </div>
          <p className="small muted">Boards are saved in this browser. Robots: click to place, drag while placing to aim. Save picture makes a PNG to send to your team.</p>
        </section>
      </aside>
    </div>
  );
}
