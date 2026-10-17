import { useSyncExternalStore } from 'react';
import { buildLayout, cloneLayout, type FieldLayout } from '../field/layout';
import { cloneRobot, DEFAULT_ROBOT, type RobotConfig } from '../robot/config';
import { cloneParams, type MatchType, type OverrideParams } from '../rules/ruleset';
import { DEFAULT_SETTINGS, type OptimizationReport, type OptimizerProgress, type OptimizerSettings } from '../planner/optimizer';
import { DEFAULT_UNCERTAINTY, type UncertaintyConfig } from '../planner/robustness';
import type { PhysicsTrialStats, SlotSetup, Strategy } from '../sim/scenario';

/**
 * Application state (serializable parts only). The live simulation lives in the
 * SimRunner; components subscribe to its tick counter for frame-rate-independent
 * refreshes.
 */

export type Tab = 'field' | 'team' | 'optimizer' | 'robot' | 'analysis' | 'timeline' | 'setup' | 'rules';
export type CameraMode = 'overhead' | 'iso' | 'side' | 'free';

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
}

function defaultSlots(matchType: MatchType, robot: RobotConfig): SlotSetup[] {
  if (matchType !== 'headToHead') return [{ slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot }];
  return [
    { slot: 'red-1', alliance: 'red', enabled: true, strategy: 'optimized', robot },
    { slot: 'red-2', alliance: 'red', enabled: true, strategy: 'midfield', robot: cloneRobot() },
    { slot: 'blue-1', alliance: 'blue', enabled: true, strategy: 'optimized', robot: cloneRobot() },
    { slot: 'blue-2', alliance: 'blue', enabled: true, strategy: 'toggles', robot: cloneRobot() },
  ];
}

function initial(): AppState {
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
    camera: 'iso',
    show: { route: true, trails: true, labels: true, grid: false, zones: true, shadows: true },
    selection: null,
    setupTool: 'select',
    message: null,
    simVersion: 0,
  };
}

type Listener = () => void;
let state: AppState = initial();
const listeners = new Set<Listener>();

export const store = {
  get: () => state,
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    for (const l of listeners) l();
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
