import type { OptimizationReport, OptimizerProgress, OptimizerSettings } from '../planner/optimizer';
import type { UncertaintyConfig } from '../planner/robustness';
import type { PhysicsTrialStats, ScenarioConfig } from '../sim/scenario';
import type { FromWorker, PlanRequest, ToWorker } from './protocol';
import type { CalibrationResult } from '../sim/calibrate';
import type { RobotConfig } from '../robot/config';
import type { OverrideParams } from '../rules/ruleset';

/** Thin promise-based client for the optimizer worker. */
export class OptimizerClient {
  private worker: Worker;
  private nextId = 1;
  private handlers = new Map<number, (m: FromWorker) => void>();

  constructor() {
    this.worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handlers.get(ev.data.id)?.(ev.data);
  }

  private send(m: ToWorker) {
    this.worker.postMessage(m);
  }

  optimize(request: PlanRequest, settings: OptimizerSettings, onProgress: (p: OptimizerProgress) => void): Promise<OptimizationReport> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.handlers.set(id, (m) => {
        if (m.type === 'progress') onProgress(m.progress);
        else if (m.type === 'report') {
          this.handlers.delete(id);
          resolve(m.report);
        } else if (m.type === 'error') {
          this.handlers.delete(id);
          reject(new Error(m.message));
        }
      });
      this.send({ type: 'optimize', id, request, settings });
    });
  }

  physicsTrials(scenario: ScenarioConfig, focusSlot: string, uncertainty: UncertaintyConfig, trials: number, seed: number, target: number | null, onTrial: (k: number, score: number) => void): Promise<PhysicsTrialStats> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.handlers.set(id, (m) => {
        if (m.type === 'trial') onTrial(m.k, m.score);
        else if (m.type === 'trials') {
          this.handlers.delete(id);
          resolve(m.stats);
        } else if (m.type === 'error') {
          this.handlers.delete(id);
          reject(new Error(m.message));
        }
      });
      this.send({ type: 'physicsTrials', id, scenario, focusSlot, uncertainty, trials, seed, target });
    });
  }

  calibrate(robot: RobotConfig, params: OverrideParams): Promise<CalibrationResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.handlers.set(id, (m) => {
        if (m.type === 'calibrated') {
          this.handlers.delete(id);
          resolve(m.result);
        } else if (m.type === 'error') {
          this.handlers.delete(id);
          reject(new Error(m.message));
        }
      });
      this.send({ type: 'calibrate', id, robot, params });
    });
  }

  pause() {
    this.send({ type: 'pause' });
  }
  resume() {
    this.send({ type: 'resume' });
  }
  stop() {
    this.send({ type: 'stop' });
  }
  /** Hard stop (terminates and restarts the worker) for a stuck long slice. */
  terminate() {
    this.worker.terminate();
    this.handlers.clear();
    this.worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handlers.get(ev.data.id)?.(ev.data);
  }
}
