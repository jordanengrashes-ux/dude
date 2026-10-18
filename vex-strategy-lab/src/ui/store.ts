import { useSyncExternalStore } from 'react';
import { buildLayout, cloneLayout, type FieldLayout } from '../field/layout';
import { cloneRobot, DEFAULT_ROBOT, type RobotConfig } from '../robot/config';
import { cloneParams, type MatchType, type OverrideParams } from '../rules/ruleset';
import { DEFAULT_SETTINGS, type OptimizationReport, type OptimizerProgress, type OptimizerSettings } from '../planner/optimizer';
import { DEFAULT_UNCERTAINTY, type UncertaintyConfig } from '../planner/robustness';
import type { PhysicsTrialStats, SlotSetup, Strategy } from '../sim/scenario';
import type { AutonProgram } from '../auton/program';

/**
 * Application state (serializable parts only). The live simulation lives in the
 * SimRunner; components subscribe to its tick counter for frame-rate-independent
 * refreshes.
 */

export type Tab = 'field' | 'plan' | 'team' | 'optimizer' | 'robot' | 'analysis' | 'timeline' | 'setup' | 'rules';
/** 'chase': 3rd person, locked behind the robot you drive. */
export type CameraMode = 'overhead' | 'iso' | 'side' | 'free' | 'chase';

export interface PlanOptions {
  objective: 'own' | 'margin';
  awpWeight: number;
  candidateK: number;
  includeAutonBonus: boolean;
  opponentAutoScore: number;
  /** Plan the user robot around predicted actions of the other enabled robots. */
  accountForOthers: boolean;
  allowPark: boolean;
}

export interface AppState {
  tab: Tab;
  matchType: MatchType;
  params: OverrideParams;
  layout: FieldLayout;
  robot: RobotConfig;
  userSlot: string;
  slots: SlotSetup[];
  planOptions: PlanOptions;
  settings: OptimizerSettings;
  uncertainty: UncertaintyConfig;
  optStatus: 'idle' | 'running' | 'paused';
  progress: OptimizerProgress[];
  report: OptimizationReport | null;
  /** Candidate id executed by the user robot (report.best by default). */
  executePlan: string | null;
  mcStatus: 'idle' | 'running';
  mcScores: number[];
  physicsStats: PhysicsTrialStats | null;
  camera: CameraMode;
  show: { route: boolean; trails: boolean; labels: boolean; grid: boolean; zones: boolean; shadows: boolean };
  selection: { kind: 'object' | 'robot' | 'goal' | 'toggle'; id: string } | null;
  setupTool: 'select' | 'move' | 'measure';
  message: string | null;
  simVersion: number;
  /** Practice: only your robot on the field, you drive from the start, no team room. */
  practice: boolean;
  /** Watching an autonomous program (Plan mode) run on the field: only that robot, no team room. */
  autonRun: AutonProgram | null;
}

function defaultSlots(matchType: MatchType, robot: RobotConfig): SlotSetup[] {
  if (matchType !== 'headToHead') return [{ slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot }];
  return [
    { slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot },
    { slot: 'red-2', alliance: 'red', enabled: true, strategy: 'optimized', robot: cloneRobot() },
    { slot: 'blue-1', alliance: 'blue', enabled: true, strategy: 'optimized', robot: cloneRobot() },
    { slot: 'blue-2', alliance: 'blue', enabled: true, strategy: 'optimized', robot: cloneRobot() },
  ];
}

function initial(): AppState {
  return withSavedSettings(defaults());
}

function defaults(): AppState {
  const robot = cloneRobot(DEFAULT_ROBOT);
  const matchType: MatchType = 'headToHead';
  return {
    tab: 'field',
    matchType,
    params: cloneParams(),
    layout: buildLayout(matchType),
    robot,
    userSlot: 'red-1',
    slots: defaultSlots(matchType, robot),
    planOptions: { objective: 'own', awpWeight: 0, candidateK: 6, includeAutonBonus: true, opponentAutoScore: 0, accountForOthers: true, allowPark: true },
    settings: { ...DEFAULT_SETTINGS, budgetMs: 15000, robustnessTrials: 80 },
    uncertainty: { ...DEFAULT_UNCERTAINTY },
    optStatus: 'idle',
    progress: [],
    report: null,
    executePlan: null,
    mcStatus: 'idle',
    mcScores: [],
    physicsStats: null,
    camera: startsInPractice() ? 'chase' : 'iso',
    show: { route: true, trails: true, labels: true, grid: false, zones: true, shadows: true },
    selection: null,
    setupTool: 'select',
    message: null,
    simVersion: 0,
    practice: startsInPractice(),
    autonRun: null,
  };
}

/**
 * The app opens in Practice (just you, 3rd person) unless the link says otherwise:
 * an invite link (`?room=`) or `?mode=match` opens a match; `mode=practice` (your own
 * room, reloaded) stays in Practice.
 */
function startsInPractice(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  if (q.get('mode') === 'practice') return true; // your own room, reloaded
  if (q.get('mode') === 'match' || q.has('room')) return false;
  return true;
}

// ------------------------------------------------------------- saved settings

/** Settings kept in this browser across reloads (the field layout and results are not). */
const SETTINGS_KEY = 'vsl-settings-v1';

interface SavedSettings {
  matchType: MatchType;
  robot: RobotConfig;
  params: OverrideParams;
  userSlot: string;
  strategies: Record<string, { strategy: Strategy; enabled: boolean }>;
  planOptions: PlanOptions;
  settings: OptimizerSettings;
  uncertainty: UncertaintyConfig;
  camera: CameraMode;
  show: AppState['show'];
  practice: boolean;
}

/** Saved values over the defaults: new fields keep their defaults, values of the wrong type are ignored. */
function mergeSaved<T>(base: T, saved: unknown): T {
  if (base === null || typeof base !== 'object') return (saved !== null && typeof saved === typeof base ? saved : base) as T;
  if (Array.isArray(base)) return (Array.isArray(saved) ? saved : base) as T;
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (k in saved) out[k] = mergeSaved(out[k], (saved as Record<string, unknown>)[k]);
  return out as T;
}

function readSaved(): Partial<SavedSettings> | null {
  try {
    const t = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    return t ? (JSON.parse(t) as Partial<SavedSettings>) : null;
  } catch {
    return null;
  }
}

function withSavedSettings(d: AppState): AppState {
  const x = readSaved();
  if (!x) return d;
  const matchType: MatchType = x.matchType === 'headToHead' || x.matchType === 'skillsDriver' || x.matchType === 'skillsAuton' ? x.matchType : d.matchType;
  const robot = mergeSaved(d.robot, x.robot);
  const slots = defaultSlots(matchType, robot).map((s) => {
    const st = x.strategies?.[s.slot];
    return st && typeof st.strategy === 'string' ? { ...s, strategy: st.strategy, enabled: st.enabled !== false } : s;
  });
  const linked = !startsInPractice(); // an invite or ?mode=match link wins
  return {
    ...d,
    matchType,
    layout: matchType === d.matchType ? d.layout : buildLayout(matchType),
    robot,
    slots,
    params: mergeSaved(d.params, x.params),
    userSlot: slots.some((s) => s.slot === x.userSlot) ? x.userSlot! : d.userSlot,
    planOptions: mergeSaved(d.planOptions, x.planOptions),
    settings: mergeSaved(d.settings, x.settings),
    uncertainty: mergeSaved(d.uncertainty, x.uncertainty),
    show: mergeSaved(d.show, x.show),
    practice: linked ? d.practice : typeof x.practice === 'boolean' ? x.practice : d.practice,
    camera: linked ? d.camera : typeof x.camera === 'string' ? x.camera : d.camera,
  };
}

function saveSettings(s: AppState) {
  const out: SavedSettings = {
    matchType: s.matchType,
    robot: s.robot,
    params: s.params,
    userSlot: s.userSlot,
    strategies: Object.fromEntries(s.slots.map((x) => [x.slot, { strategy: x.strategy, enabled: x.enabled }])),
    planOptions: s.planOptions,
    settings: s.settings,
    uncertainty: s.uncertainty,
    camera: s.camera,
    show: s.show,
    practice: s.practice,
  };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  } catch {
    /* storage unavailable */
  }
}

/** Forget the saved settings and go back to the defaults. */
export function resetSettings() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* storage unavailable */
  }
  const d = defaults();
  store.set((s) => ({ ...d, tab: s.tab, simVersion: s.simVersion + 1 }));
}

type Listener = () => void;
let state: AppState = initial();
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => !state.autonRun && saveSettings(state));
const listeners = new Set<Listener>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const store = {
  get: () => state,
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    for (const l of listeners) l();
    // keep the settings for the next visit (a watched auton run is not a setting); at
    // most every 300 ms — the running match updates the store many times a second
    if (!state.autonRun && typeof window !== 'undefined' && !saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        if (!state.autonRun) saveSettings(state);
      }, 300);
    }
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state));
}

export function setMatchType(matchType: MatchType) {
  const robot = state.robot;
  store.set({
    matchType,
    layout: buildLayout(matchType),
    slots: defaultSlots(matchType, robot),
    planOptions: { ...state.planOptions, includeAutonBonus: matchType === 'headToHead' },
    report: null,
    progress: [],
    executePlan: null,
    physicsStats: null,
    simVersion: state.simVersion + 1,
  });
}

/** Switch between a match (bots and players) and solo practice. */
export function setPractice(practice: boolean) {
  store.set((s) => ({ practice, autonRun: null, camera: practice ? 'chase' : s.camera === 'chase' && !practice ? 'iso' : s.camera, simVersion: s.simVersion + 1 }));
}

/** Run an autonomous program on the field (Field tab), from its starting tile. */
export function watchAuton(program: AutonProgram) {
  store.set((s) => ({ autonRun: program, tab: 'field', camera: 'iso', simVersion: s.simVersion + 1 }));
}

export function setRobot(robot: RobotConfig) {
  store.set((s) => ({
    robot,
    slots: s.slots.map((x) => (x.slot === s.userSlot ? { ...x, robot } : x)),
    report: null,
    executePlan: null,
    simVersion: s.simVersion + 1,
  }));
}

export function setSlotStrategy(slot: string, strategy: Strategy, enabled = true) {
  store.set((s) => ({ slots: s.slots.map((x) => (x.slot === slot ? { ...x, strategy, enabled } : x)), simVersion: s.simVersion + 1 }));
}

export function setLayout(layout: FieldLayout) {
  store.set((s) => ({ layout: cloneLayout(layout), report: null, executePlan: null, simVersion: s.simVersion + 1 }));
}

export function resetLayout() {
  setLayout(buildLayout(state.matchType));
}

/** Save / load a complete scenario (robot, rules, layout, strategies, settings). */
export interface SavedScenario {
  format: 'vex-strategy-lab/scenario@1';
  savedAt: string;
  matchType: MatchType;
  params: OverrideParams;
  layout: FieldLayout;
  robot: RobotConfig;
  slots: SlotSetup[];
  planOptions: PlanOptions;
  settings: OptimizerSettings;
  uncertainty: UncertaintyConfig;
  report?: OptimizationReport | null;
}

export function exportScenario(): SavedScenario {
  const s = state;
  return {
    format: 'vex-strategy-lab/scenario@1',
    savedAt: new Date().toISOString(),
    matchType: s.matchType,
    params: s.params,
    layout: s.layout,
    robot: s.robot,
    slots: s.slots.map((x) => ({ ...x, plan: undefined })),
    planOptions: s.planOptions,
    settings: s.settings,
    uncertainty: s.uncertainty,
    report: s.report,
  };
}

export function importScenario(x: SavedScenario) {
  if (x.format !== 'vex-strategy-lab/scenario@1') throw new Error('Unrecognized scenario file');
  store.set((s) => ({
    matchType: x.matchType,
    params: x.params,
    layout: x.layout,
    robot: x.robot,
    slots: x.slots,
    planOptions: x.planOptions,
    settings: x.settings,
    uncertainty: x.uncertainty,
    report: x.report ?? null,
    executePlan: x.report ? (x.report.recommended === 'best' ? x.report.best.id : x.report.practical.id) : null,
    simVersion: s.simVersion + 1,
  }));
}
