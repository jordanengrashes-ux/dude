/// <reference lib="webworker" />
import { optimize } from '../planner/optimizer';
import { physicsMonteCarlo } from '../sim/scenario';
import { calibrateExecution } from '../sim/calibrate';
import type { FromWorker, ToWorker } from './protocol';

/**
 * Optimizer / Monte Carlo worker. Long computations run here so the UI never
 * blocks. The optimizer yields between work slices (checkpoint), which is where
 * pause/resume/stop messages take effect.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let paused = false;
let stopped = false;
const signal = { cancelled: false };

const post = (m: FromWorker) => ctx.postMessage(m);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function checkpoint(): Promise<boolean> {
  await tick();
  while (paused && !stopped) await new Promise((r) => setTimeout(r, 50));
  return !stopped;
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'pause') paused = true;
  else if (m.type === 'resume') paused = false;
  else if (m.type === 'stop') {
    stopped = true;
    signal.cancelled = true;
  } else if (m.type === 'optimize') {
    paused = false;
    stopped = false;
    signal.cancelled = false;
    try {
      const report = await optimize(m.request, m.settings, {
        signal,
        checkpoint,
        onProgress: (progress) => post({ type: 'progress', id: m.id, progress }),
      });
      post({ type: 'report', id: m.id, report });
    } catch (e) {
      post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
    }
  } else if (m.type === 'calibrate') {
    try {
      const result = await calibrateExecution(m.robot, m.params);
      post({ type: 'calibrated', id: m.id, result });
    } catch (e) {
      post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
    }
  } else if (m.type === 'physicsTrials') {
    stopped = false;
    try {
      const stats = await physicsMonteCarlo(m.scenario, m.focusSlot, m.uncertainty, m.trials, m.seed, m.target, (k, score) => post({ type: 'trial', id: m.id, k, score }));
      post({ type: 'trials', id: m.id, stats });
    } catch (e) {
      post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
};
