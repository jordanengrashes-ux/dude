import { useSyncExternalStore } from 'react';
import { buildLayout, type FieldLayout, type RobotStart } from '../field/layout';
import { newProgram } from '../auton/plan';
import type { AutonMode, AutonProgram } from '../auton/program';
import { simulateProgram, type AutonRunResult } from '../auton/simulate';
import { runner } from './simRunner';
import { store } from './store';

/**
 * Plan tab state: the autonomous program being edited (and the ones saved in this
 * browser), its last quick run, and the strategy whiteboards.
 */

export type BoardTool = 'pen' | 'arrow' | 'text' | 'red-robot' | 'blue-robot' | 'eraser';
export type BoardColor = 'red' | 'blue' | 'yellow' | 'white' | 'green';

export type Shape =
  | { id: string; kind: 'pen'; color: BoardColor; points: [number, number][] }
  | { id: string; kind: 'arrow'; color: BoardColor; from: [number, number]; to: [number, number] }
  | { id: string; kind: 'text'; color: BoardColor; at: [number, number]; text: string }
  | { id: string; kind: 'robot'; alliance: 'red' | 'blue'; at: [number, number]; heading: number; label: string };

export interface Board {
  id: string;
  name: string;
  shapes: Shape[];
}

export interface PlanUi {
  view: 'auton' | 'board';
  program: AutonProgram;
  selected: number | null;
  run: AutonRunResult | null;
  /** Quick run in progress: simulated time so far / window. */
  running: { t: number; window: number } | null;
  runError: string | null;
  saved: AutonProgram[];
  dialog: 'import' | 'export' | null;
  boards: Board[];
  boardId: string;
  tool: BoardTool;
  color: BoardColor;
}

const load = <T>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

/** Field layout a program runs on (match: Head-to-Head, Skills: Autonomous Skills). */
export function layoutFor(mode: AutonMode): FieldLayout {
  const s = store.get();
  const mt = mode === 'skills' ? 'skillsAuton' : 'headToHead';
  return s.matchType === mt ? s.layout : buildLayout(mt);
}

export function startFor(p: AutonProgram): RobotStart | undefined {
  const l = layoutFor(p.mode);
  return l.robots.find((r) => r.slot === p.slot) ?? l.robots[0];
}

function initialProgram(): AutonProgram {
  const p = newProgram('My autonomous', 'red-1', 'match', undefined);
  return { ...p, steps: [] };
}

const firstBoard = (): Board => ({ id: 'b1', name: 'Board 1', shapes: [] });

let state: PlanUi = {
  view: 'auton',
  program: load<AutonProgram | null>('vsl-auton-current', null) ?? initialProgram(),
  selected: null,
  run: null,
  running: null,
  runError: null,
  saved: load<AutonProgram[]>('vsl-autons', []),
  dialog: null,
  boards: load<Board[]>('vsl-boards', [firstBoard()]),
  boardId: '',
  tool: 'pen',
  color: 'yellow',
};
if (!state.boards.length) state.boards = [firstBoard()];
state.boardId = state.boards[0].id;

const listeners = new Set<() => void>();

export const plan = {
  get: () => state,
  set(patch: Partial<PlanUi> | ((s: PlanUi) => Partial<PlanUi>)) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    if ('program' in p) save('vsl-auton-current', state.program);
    if ('saved' in p) save('vsl-autons', state.saved);
    if ('boards' in p) save('vsl-boards', state.boards);
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function usePlan<T>(sel: (s: PlanUi) => T): T {
  return useSyncExternalStore(plan.subscribe, () => sel(state));
}

// ------------------------------------------------------------- programs

/** Change the program (the last run no longer applies). */
export function setProgram(p: AutonProgram | ((p: AutonProgram) => AutonProgram)) {
  plan.set((s) => ({ program: typeof p === 'function' ? p(s.program) : p, run: null, runError: null }));
}

/** A program that starts at its tile: setPose there first (Plan mode's programs are field-centric). */
export function ensureStart(p: AutonProgram): AutonProgram {
  const start = startFor(p);
  if (!start || p.steps[0]?.kind === 'setPose') return p;
  const fresh = newProgram(p.name, p.slot, p.mode, start);
  return { ...p, steps: [...fresh.steps, ...p.steps] };
}

/** Move the program to another starting tile / mode: its setPose follows. */
export function retarget(p: AutonProgram, slot: string, mode: AutonMode): AutonProgram {
  const next = { ...p, slot: mode === 'skills' ? 'red-1' : slot, mode };
  const first = next.steps[0];
  const start = startFor(next);
  if (first?.kind === 'setPose' && start) {
    const fresh = newProgram(p.name, next.slot, mode, start).steps[0];
    return { ...next, steps: [fresh, ...next.steps.slice(1)] };
  }
  return next;
}

export function saveProgram() {
  plan.set((s) => ({ saved: [...s.saved.filter((x) => x.name !== s.program.name), s.program].sort((a, b) => a.name.localeCompare(b.name)) }));
}

export function deleteSaved(name: string) {
  plan.set((s) => ({ saved: s.saved.filter((x) => x.name !== name) }));
}

// ------------------------------------------------------------- quick run

let runId = 0;

/** Simulate the program with physics (its robot only) and keep the result for the field view. */
export async function quickRun() {
  const id = ++runId;
  const program = state.program;
  const sc = runner.scenarioFrom({ ...store.get(), autonRun: program });
  plan.set({ running: { t: 0, window: program.mode === 'skills' ? 60 : 15 }, runError: null, run: null });
  try {
    const run = await simulateProgram(sc, program, {
      yieldEvery: 0.5,
      onProgress: (t, window) => id === runId && plan.set({ running: { t, window } }),
    });
    if (id === runId) plan.set({ run, running: null });
  } catch (e) {
    if (id === runId) plan.set({ running: null, runError: e instanceof Error ? e.message : String(e) });
  }
}
