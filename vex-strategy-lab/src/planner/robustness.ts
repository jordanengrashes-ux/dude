import { Rng } from '../core/rng';
import { clamp } from '../core/units';
import { cloneRobot } from '../robot/config';
import { PlanWorld, ST_UNAVAILABLE, type Action, type PlanConfig, type PlanState } from './model';

/**
 * Sim-to-real uncertainty. Every source is configurable and defaults to modest,
 * plausible spreads; set all to 0 for the deterministic baseline.
 */
export interface UncertaintyConfig {
  /** Fractional SD of motor torque/speed (motor wear, temperature). */
  motorSd: number;
  /** Fractional SD of tire friction (tile wear, wheel wear). */
  tractionSd: number;
  /** Battery voltage range at match start (V). */
  batteryMin: number;
  batteryMax: number;
  /** Positioning error SD at placement (in) — sensors + controller. */
  positionSigma: number;
  /** Object starting-position SD (in) — affects pickup success. */
  objectPosSd: number;
  /** Base failure probability of any mechanism cycle (intake / toggle). */
  mechanismFail: number;
  /** Extra seconds for a retry after a failed attempt. */
  retryPenaltySec: number;
}

export const DEFAULT_UNCERTAINTY: UncertaintyConfig = {
  motorSd: 0.05,
  tractionSd: 0.08,
  batteryMin: 12.2,
  batteryMax: 12.9,
  positionSigma: 0.35,
  objectPosSd: 0.5,
  mechanismFail: 0.02,
  retryPenaltySec: 1.0,
};

export const NO_UNCERTAINTY: UncertaintyConfig = {
  motorSd: 0,
  tractionSd: 0,
  batteryMin: 12.8,
  batteryMax: 12.8,
  positionSigma: 0,
  objectPosSd: 0,
  mechanismFail: 0,
  retryPenaltySec: 1.0,
};

export interface FailurePoint {
  stepIndex: number;
  label: string;
  failures: number;
  losses: number;
}

export interface RobustnessStats {
  trials: number;
  seed: number;
  mean: number;
  median: number;
  best: number;
  worst: number;
  sd: number;
  variance: number;
  pTarget: number | null;
  target: number | null;
  samples: number[];
  failurePoints: FailurePoint[];
  meanFinishTime: number;
}

function failProb(a: Action, stepRisk: number, unc: UncertaintyConfig): number {
  switch (a.type) {
    case 'place':
      return clamp(stepRisk + unc.mechanismFail * 0.5, 0, 0.95);
    case 'pick':
    case 'load': {
      const objTerm = unc.objectPosSd > 0 ? Math.exp(-(2.2 * 2.2) / (2 * unc.objectPosSd * unc.objectPosSd)) : 0;
      return clamp(unc.mechanismFail + objTerm, 0, 0.95);
    }
    case 'toggle':
      return clamp(unc.mechanismFail * 1.5, 0, 0.95);
    default:
      return 0;
  }
}

/**
 * Monte Carlo evaluation of a fixed action sequence. Each trial samples motor,
 * traction and battery performance (changing every action duration through the
 * robot model) plus per-action failures. A failed action costs a retry; a second
 * failure loses the object. Later actions that become infeasible are skipped, and
 * the rules engine scores whatever field state results.
 */
export function evaluateRobustness(
  cfg: PlanConfig,
  actions: Action[],
  unc: UncertaintyConfig,
  trials: number,
  seed: number,
  target: number | null = null,
  baseWorld?: PlanWorld,
): RobustnessStats {
  const rng = new Rng(seed);
  const samples: number[] = [];
  const fails = new Map<number, FailurePoint>();
  let finish = 0;
  const base = baseWorld ?? new PlanWorld(cfg);
  for (let k = 0; k < trials; k++) {
    const r = cloneRobot(cfg.robot);
    const motor = clamp(rng.normal(1, unc.motorSd), 0.6, 1.3);
    const trac = clamp(rng.normal(1, unc.tractionSd), 0.5, 1.4);
    r.battery.voltage = rng.range(unc.batteryMin, unc.batteryMax);
    r.drivetrain.muLongitudinal *= trac;
    r.drivetrain.muLateral *= trac;
    const w = base.fork({ robot: r, motorScale: motor, positionSigma: unc.positionSigma });
    let s: PlanState = w.initialState();
    actions.forEach((a, i) => {
      const res = w.apply(s, a);
      if (!res) return;
      const p = failProb(a, res.step.risk, unc);
      if (p > 0 && rng.next() < p) {
        const fp = fails.get(i) ?? { stepIndex: i, label: res.step.label, failures: 0, losses: 0 };
        fp.failures++;
        // retry
        const retryOk = rng.next() >= p;
        const penalty = unc.retryPenaltySec + res.step.mechTime;
        if (retryOk && res.s.t + penalty <= w.periodEnd(s.t) + 1e-9) {
          w.advanceTo(res.s, res.s.t + penalty);
          s = res.s;
        } else {
          fp.losses++;
          // object lost: it stays near where the robot was; treat as unavailable.
          const lost = w.clone(s);
          if (a.type === 'place') {
            const oi = w.nextKind(s, a.goal) === 'pin' ? lost.heldPin : lost.heldCup;
            if (oi >= 0) {
              lost.status[oi] = ST_UNAVAILABLE;
              if (oi === lost.heldPin) lost.heldPin = -1;
              else lost.heldCup = -1;
            }
          } else if (a.type === 'pick' || a.type === 'load') {
            lost.status[a.obj] = ST_UNAVAILABLE;
          }
          lost.pos = res.s.pos;
          lost.heading = res.s.heading;
          lost.holderH = res.s.holderH;
          w.advanceTo(lost, Math.min(w.periodEnd(s.t), res.s.t + penalty));
          s = lost;
        }
        fails.set(i, fp);
        return;
      }
      s = res.s;
    });
    finish += s.t;
    samples.push(w.value(w.finalize(s)));
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, samples.length);
  return {
    trials,
    seed,
    mean,
    median: sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0,
    best: sorted[sorted.length - 1] ?? 0,
    worst: sorted[0] ?? 0,
    sd: Math.sqrt(variance),
    variance,
    target,
    pTarget: target === null ? null : samples.filter((x) => x >= target).length / Math.max(1, samples.length),
    samples,
    failurePoints: [...fails.values()].sort((a, b) => b.failures - a.failures),
    meanFinishTime: finish / Math.max(1, trials),
  };
}
