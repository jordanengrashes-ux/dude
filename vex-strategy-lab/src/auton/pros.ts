import type { RobotConfig } from '../robot/config';
import { headingToTheta, isMotion, liftHeightFromDegrees, liftMotorDegrees, type AutonProgram, type AutonStep } from './program';

/**
 * PROS C++ autonomous code ↔ autonomous programs.
 *
 * Import reads the calls a PROS autonomous routine makes — LemLib motions
 * (moveToPoint, moveToPose, turnToHeading, turnToPoint, swingToHeading, setPose,
 * waitUntilDone, waitUntil), EZ-Template motions (pid_drive_set, pid_turn_set,
 * pid_swing_set, pid_odom_set, pid_wait…), plain PROS device calls (move,
 * move_absolute, move_relative, move_velocity, move_voltage, brake, set_value,
 * extend / retract / toggle) and delays — and maps each device to a mechanism
 * of the simulated robot by its name (editable). Helper functions called from
 * autonomous() are followed; `for` loops with a fixed count are unrolled; other
 * control flow (if, while, sensors) can't be predicted and is skipped with a warning.
 *
 * Export writes LemLib (field-centric: setPose at the starting tile) or
 * EZ-Template (relative drives and turns) code, either the autonomous() function
 * alone or a whole main.cpp with devices, chassis setup and a driver control
 * matching the simulator's controller (R1 / R2 lift, L1 claw).
 */

export type DeviceRole = 'leftDrive' | 'rightDrive' | 'lift' | 'claw' | 'toggleArm' | 'ignore';

export interface DeviceInfo {
  name: string;
  /** Declared type (pros::Motor, pros::adi::DigitalOut, …) or 'unknown' when only used. */
  type: string;
  piston: boolean;
  role: DeviceRole | null;
  line: number;
}

export interface ParseWarning {
  line: number;
  text: string;
}

export interface ParseOptions {
  robot: RobotConfig;
  /** Device name → role, overriding the guesses. */
  roles?: Record<string, DeviceRole>;
  /** The function to run (default autonomous(), else the first one that moves the robot). */
  entry?: string;
  /** Piston value that closes the claw (default true). */
  clawClosedValue?: boolean;
}

export interface ParseResult {
  steps: AutonStep[];
  warnings: ParseWarning[];
  devices: DeviceInfo[];
  /** Functions found (candidates for the entry point). */
  functions: string[];
  entry: string | null;
  dialect: 'lemlib' | 'ez' | 'pros' | null;
}

// ---------------------------------------------------------------- lexing

/** Comments → spaces (line numbers kept). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'") {
      // keep string / char literals whole
      const q = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += src[i++];
        }
        out += src[i++];
      }
      out += q;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineAt = (src: string, pos: number) => {
  let n = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
};

/** Index of the bracket closing the one at `open`. */
function matchClose(src: string, open: number): number {
  const o = src[open];
  const c = o === '{' ? '}' : o === '(' ? ')' : ']';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i;
  }
  return src.length - 1;
}

/** Split at top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------- numbers

type Scope = Map<string, number | boolean>;

/** Evaluate a numeric C++ expression: literals with units (24_in, 90_deg), constants, + − * / %, parentheses. */
function evalExpr(expr: string, scope: Scope): number | boolean | null {
  let s = expr.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  // casts and units
  s = s.replace(/\(\s*(?:int|double|float|long|short)\s*\)/g, '');
  s = s.replace(/static_cast<[^>]+>/g, '');
  const toks = s.match(/\d+\.\d*(?:e[+-]?\d+)?_?\w*|\.\d+(?:e[+-]?\d+)?_?\w*|\d+(?:e[+-]?\d+)?_?\w*|[A-Za-z_][\w:]*|[-+*/%()]|\S/gi) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const atom = (): number | null => {
    const t = toks[i++];
    if (t === undefined) return null;
    if (t === '(') {
      const v = sum();
      if (toks[i] === ')') i++;
      return v;
    }
    if (t === '-') {
      const v = atom();
      return v === null ? null : -v;
    }
    if (t === '+') return atom();
    const num = t.match(/^(\d*\.?\d+(?:e[+-]?\d+)?)(?:_?(\w+))?$/i);
    if (num) {
      const v = parseFloat(num[1]);
      const unit = (num[2] ?? '').toLowerCase();
      // inches / degrees / ms are the program's units; convert the others
      if (unit === 'cm') return v / 2.54;
      if (unit === 'mm') return v / 25.4;
      if (unit === 'ft') return v * 12;
      if (unit === 'm') return v / 0.0254;
      if (unit === 'rad') return (v * 180) / Math.PI;
      if (unit === 's' || unit === 'sec') return v * 1000;
      if (unit === 'f' || unit === 'l' || unit === 'u' || unit === 'ul') return v;
      return v;
    }
    const name = t.replace(/^(?:std::|pros::)/, '');
    if (name === 'M_PI') return Math.PI;
    const sv = scope.get(name);
    if (typeof sv === 'number') return sv;
    if (typeof sv === 'boolean') return sv ? 1 : 0;
    return null;
  };
  const prod = (): number | null => {
    let v = atom();
    while (v !== null && (peek() === '*' || peek() === '/' || peek() === '%')) {
      const op = toks[i++];
      const r = atom();
      if (r === null) return null;
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = prod();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = toks[i++];
      const r = prod();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  if (v === null || i < toks.length || !Number.isFinite(v)) {
    const b = scope.get(s);
    return typeof b === 'boolean' ? b : null;
  }
  return v;
}

/** LemLib v0.5 parameter structs: {.forwards = false, .maxSpeed = 80}. */
function parseOptions(arg: string | undefined, scope: Scope): Record<string, number | boolean | string> | null {
  if (!arg) return null;
  const t = arg.trim();
  if (!t.startsWith('{')) return null;
  const out: Record<string, number | boolean | string> = {};
  for (const part of splitArgs(t.slice(1, -1))) {
    const m = part.match(/^\.?(\w+)\s*=\s*(.+)$/);
    if (!m) continue;
    const v = evalExpr(m[2], scope);
    out[m[1]] = v === null ? m[2].trim() : v;
  }
  return out;
}

// ---------------------------------------------------------------- devices

const DEVICE_DECL = /(?:pros::|ez::|okapi::)?((?:adi::|c::)?(?:Motor(?:Group)?|ADIMotor|DigitalOut|ADIDigitalOut|Pneumatics|Piston|Imu|IMU|Rotation|Distance|Optical|Vision|ADIDigitalIn|DigitalIn|AnalogIn|ADIAnalogIn|Controller))\s+(\w+)\s*[({]/g;

function guessRole(name: string, piston: boolean): DeviceRole | null {
  const n = name.toLowerCase();
  if (/^(left|l)(_|$)|left.*(drive|mg|motors?|side|dt)|(drive|dt).*left|^left/.test(n)) return 'leftDrive';
  if (/^(right|r)(_|$)|right.*(drive|mg|motors?|side|dt)|(drive|dt).*right|^right/.test(n)) return 'rightDrive';
  if (/claw|clamp|grab|grip|pinch|jaw|hand/.test(n)) return 'claw';
  if (/toggle|flipper|wing|doinker|tog|paddle|tip/.test(n)) return 'toggleArm';
  if (/lift|arm|dr4b|fourbar|4bar|tower|elev|raise/.test(n)) return 'lift';
  if (piston && /pneu|piston|solenoid/.test(n)) return 'claw';
  return null;
}

// ---------------------------------------------------------------- import

interface Fn {
  name: string;
  body: string;
  offset: number;
}

const LEMLIB_METHODS = new Set(['moveToPoint', 'moveToPose', 'turnToHeading', 'turnToPoint', 'swingToHeading', 'swingToPoint', 'setPose', 'waitUntilDone', 'waitUntil', 'cancelMotion', 'cancelAllMotions', 'follow', 'arcade', 'tank', 'curvature']);
const EZ_METHODS = /^(pid_drive_set|pid_turn_set|pid_turn_relative_set|pid_swing_set|pid_swing_relative_set|pid_odom_set|odom_xyt_set|odom_xy_set|odom_theta_set|pid_wait|pid_wait_quick|pid_wait_quick_chain|pid_wait_until|pid_wait_until_index|pid_odom_injected_pp_set|pid_odom_smooth_pp_set)$/;
/** Setup calls that don't move anything: accepted silently. */
const QUIET = /^(calibrate|setBrakeMode|resetLocalPosition|drive_imu_reset|drive_sensor_reset|drive_brake_set|pid_targets_reset|odom_enable|odom_reset|initialize|tare_position|set_brake_mode|set_brake_modes|set_gearing|set_encoder_units|set_reversed|set_zero_position|reset|set_data_rate|set_led|print|clear|clear_line|set_text|rumble|slew_drive_set|slew_turn_set|slew_swing_set|pid_drive_toggle|pid_print_toggle|drive_angle_set|odom_pose_set|pid_heading_constants_set|pid_drive_constants_set|pid_turn_constants_set|pid_swing_constants_set|pid_odom_angular_constants_set|pid_odom_boomerang_constants_set|pid_drive_exit_condition_set|pid_turn_exit_condition_set|pid_swing_exit_condition_set|pid_speed_max_set|opcontrol_\w+|lcd_\w+|set_current_limit|set_voltage_limit)$/;

export function parseProsAuton(source: string, opts: ParseOptions): ParseResult {
  const src = stripComments(source.replace(/\r\n?/g, '\n'));
  const warnings: ParseWarning[] = [];
  const warn = (pos: number, text: string) => warnings.push({ line: lineAt(src, pos), text });
  const scope: Scope = new Map();

  // constants: `const int DRIVE_SPEED = 110;`, `#define TURN 90`
  for (const m of src.matchAll(/(?:^|[;{}\n])\s*(?:static\s+)?(?:inline\s+)?(?:const(?:expr)?\s+)?(?:int|double|float|auto|long|short|unsigned|bool|u?int\d+_t)\s+(\w+)\s*=\s*([^;]+);/g)) {
    const v = evalExpr(m[2], scope);
    if (v !== null) scope.set(m[1], v);
  }
  for (const m of src.matchAll(/^\s*#define\s+(\w+)\s+([^\n]+)$/gm)) {
    const v = evalExpr(m[2], scope);
    if (v !== null) scope.set(m[1], v);
  }

  // devices
  const devices = new Map<string, DeviceInfo>();
  for (const m of src.matchAll(DEVICE_DECL)) {
    const type = m[1];
    if (/Controller|Imu|IMU|Rotation|Distance|Optical|Vision|DigitalIn|AnalogIn/.test(type)) continue;
    const piston = /DigitalOut|Pneumatics|Piston/.test(type);
    devices.set(m[2], { name: m[2], type, piston, role: null, line: lineAt(src, m.index ?? 0) });
  }

  // functions
  const fns = new Map<string, Fn>();
  for (const m of src.matchAll(/\b(?:void|int|bool|static\s+void|inline\s+void)\s+(\w+)\s*\(\s*(?:void)?\s*\)\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchClose(src, open);
    fns.set(m[1], { name: m[1], body: src.slice(open + 1, close), offset: open + 1 });
  }
  const skipFns = new Set(['initialize', 'opcontrol', 'disabled', 'competition_initialize', 'main']);
  const movesRobot = (f: Fn) => /\.(moveTo|turnTo|swingTo|pid_drive_set|pid_turn_set|pid_odom_set|pid_swing_set|move\(|move_absolute|move_velocity|move_voltage|set_value)|delay\s*\(/.test(f.body);
  let entry: Fn | null = null;
  if (opts.entry && fns.has(opts.entry)) entry = fns.get(opts.entry)!;
  else if (fns.has('autonomous') && movesRobot(fns.get('autonomous')!)) entry = fns.get('autonomous')!;
  else entry = [...fns.values()].find((f) => !skipFns.has(f.name) && movesRobot(f)) ?? fns.get('autonomous') ?? null;
  // no functions at all: the pasted text is the body
  const body: Fn = entry ?? { name: '(pasted code)', body: src, offset: 0 };

  const steps: AutonStep[] = [];
  let dialect: ParseResult['dialect'] = null;
  const clawClosedValue = opts.clawClosedValue ?? true;
  const role = (name: string): DeviceRole | null => {
    if (opts.roles?.[name]) return opts.roles[name];
    const d = devices.get(name);
    return d ? d.role : null;
  };
  // per-device state the calls build on
  const liftDeg = { v: 0 };
  const pistons = new Map<string, boolean>();
  const ezHeading = { v: 0 };
  const used = new Set<string>();

  const touchDevice = (name: string, pos: number) => {
    used.add(name);
    if (!devices.has(name)) devices.set(name, { name, type: 'unknown', piston: false, role: opts.roles?.[name] ?? guessRole(name, false), line: lineAt(src, pos) });
  };

  const execStatement = (stmt: string, pos: number, depth: number) => {
    const st = stmt.trim();
    if (!st) return;
    // declarations inside the routine (constants, locals)
    const decl = st.match(/^(?:const(?:expr)?\s+)?(?:int|double|float|auto|long|bool|u?int\d+_t)\s+(\w+)\s*=\s*(.+)$/);
    if (decl) {
      const v = evalExpr(decl[2], scope);
      if (v !== null) scope.set(decl[1], v);
      return;
    }
    // delays
    const dl = st.match(/^(?:pros::)?(?:c::|Task::)?delay\s*\((.*)\)$/) ?? st.match(/^(?:pros::)?(?:c::)?task_delay\s*\((.*)\)$/);
    if (dl) {
      const v = evalExpr(dl[1], scope);
      if (typeof v === 'number') steps.push({ kind: 'wait', ms: Math.max(0, v) });
      else warn(pos, `delay(${dl[1]}): the time isn't a number`);
      return;
    }
    // plain function call: a helper in this file
    const fc = st.match(/^(\w+)\s*\(\s*\)$/);
    if (fc) {
      const f = fns.get(fc[1]);
      if (f && depth < 8) runBody(f.body, f.offset, depth + 1);
      else if (!f) warn(pos, `${fc[1]}(): not found in the pasted code — skipped`);
      return;
    }
    // member call: obj.method(args) / obj->method(args) / ez::as::method / chassis.odom…
    const mc = st.match(/^([\w:]+(?:\[\d+\])?)\s*(?:\.|->)\s*(\w+)\s*\(([\s\S]*)\)$/);
    if (!mc) {
      if (/^(?:ez::as::|ez::)/.test(st) || /^master\.|^controller\./i.test(st)) return;
      warn(pos, `not understood: ${st.length > 70 ? st.slice(0, 70) + '…' : st}`);
      return;
    }
    const [, obj, method, argStr] = mc;
    const args = splitArgs(argStr);
    const num = (k: number, def?: number): number | undefined => {
      if (args[k] === undefined) return def;
      const v = evalExpr(args[k], scope);
      return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : def;
    };
    const bool = (k: number, def: boolean): boolean => {
      if (args[k] === undefined) return def;
      const v = evalExpr(args[k], scope);
      return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : def;
    };
    if (QUIET.test(method)) return;
    // ---------------- LemLib
    if (LEMLIB_METHODS.has(method) && !devices.has(obj)) {
      dialect = 'lemlib';
      const lem = <T extends object>(i: number) => {
        // v0.5: (…, timeout, {options}, async); v0.4: (…, timeout, forwards, maxSpeed, async)
        const o = parseOptions(args[i], scope);
        if (o) return { o, async: bool(i + 1, true) };
        const legacy: Record<string, number | boolean | string> = {};
        if (args[i] !== undefined) legacy.forwards = bool(i, true);
        if (args[i + 1] !== undefined) legacy.maxSpeed = num(i + 1, 127)!;
        return { o: legacy as T & Record<string, number | boolean | string>, async: bool(i + 2, true) };
      };
      const ms = (o: Record<string, unknown>) => (typeof o.maxSpeed === 'number' ? o.maxSpeed : 127);
      switch (method) {
        case 'setPose': {
          const x = num(0);
          const y = num(1);
          const th = num(2, 0);
          if (x === undefined || y === undefined) return warn(pos, 'setPose: coordinates are not numbers');
          const radians = bool(3, false);
          steps.push({ kind: 'setPose', x, y, theta: radians ? (th! * 180) / Math.PI : th! });
          return;
        }
        case 'moveToPoint': {
          const x = num(0);
          const y = num(1);
          if (x === undefined || y === undefined) return warn(pos, 'moveToPoint: coordinates are not numbers');
          const { o, async } = lem(3);
          steps.push({ kind: 'moveToPoint', x, y, timeout: num(2, 3000)!, forwards: o.forwards !== false, maxSpeed: ms(o), queue: true, async });
          return;
        }
        case 'moveToPose': {
          const x = num(0);
          const y = num(1);
          const th = num(2);
          if (x === undefined || y === undefined || th === undefined) return warn(pos, 'moveToPose: pose is not numbers');
          const { o, async } = lem(4);
          steps.push({ kind: 'moveToPose', x, y, theta: th, timeout: num(3, 3000)!, forwards: o.forwards !== false, maxSpeed: ms(o), lead: typeof o.lead === 'number' ? o.lead : 0.6, queue: true, async });
          return;
        }
        case 'turnToHeading': {
          const th = num(0);
          if (th === undefined) return warn(pos, 'turnToHeading: heading is not a number');
          const { o, async } = lem(2);
          if (o.direction) warn(pos, 'turnToHeading: a forced turn direction is simulated as the shortest turn');
          steps.push({ kind: 'turnToHeading', theta: th, timeout: num(1, 2000)!, maxSpeed: ms(o), queue: true, async });
          return;
        }
        case 'turnToPoint': {
          const x = num(0);
          const y = num(1);
          if (x === undefined || y === undefined) return warn(pos, 'turnToPoint: coordinates are not numbers');
          const { o, async } = lem(3);
          steps.push({ kind: 'turnToPoint', x, y, timeout: num(2, 2000)!, forwards: o.forwards !== false, maxSpeed: ms(o), queue: true, async });
          return;
        }
        case 'swingToHeading': {
          const th = num(0);
          if (th === undefined) return warn(pos, 'swingToHeading: heading is not a number');
          // LemLib names the locked side; the other side moves
          const locked = /LEFT/i.test(args[1] ?? '') ? 'left' : 'right';
          const { o, async } = lem(3);
          steps.push({ kind: 'swing', side: locked === 'left' ? 'right' : 'left', theta: th, timeout: num(2, 2000)!, maxSpeed: ms(o), queue: true, async });
          return;
        }
        case 'swingToPoint':
          warn(pos, 'swingToPoint: simulated as turnToPoint');
          {
            const x = num(0);
            const y = num(1);
            if (x === undefined || y === undefined) return;
            const { o, async } = lem(4);
            steps.push({ kind: 'turnToPoint', x, y, timeout: num(3, 2000)!, forwards: o.forwards !== false, maxSpeed: ms(o), queue: true, async });
          }
          return;
        case 'waitUntilDone':
          steps.push({ kind: 'waitUntilDone' });
          return;
        case 'waitUntil': {
          const d = num(0);
          if (d !== undefined) steps.push({ kind: 'waitUntil', inches: d });
          return;
        }
        case 'cancelMotion':
        case 'cancelAllMotions':
          warn(pos, `${method}: not simulated (the motion runs to its end)`);
          return;
        case 'follow':
          warn(pos, 'follow(path): pure-pursuit paths from files are not simulated');
          return;
        default:
          warn(pos, `${obj}.${method}: driver-control call, skipped`);
          return;
      }
    }
    // ---------------- EZ-Template
    if (EZ_METHODS.test(method)) {
      dialect = 'ez';
      const spd = (k: number) => num(k, 110)!;
      switch (method) {
        case 'pid_drive_set': {
          const d = num(0);
          if (d === undefined) return warn(pos, 'pid_drive_set: distance is not a number');
          steps.push({ kind: 'drive', inches: d, maxSpeed: spd(1), timeout: 5000, queue: false, async: true });
          return;
        }
        case 'pid_turn_set':
        case 'pid_turn_relative_set': {
          const a = num(0);
          if (a === undefined) return warn(pos, `${method}: angle is not a number`);
          ezHeading.v = method === 'pid_turn_set' ? a : ezHeading.v + a;
          steps.push({ kind: 'turnToHeading', theta: ezHeading.v, maxSpeed: spd(1), timeout: 5000, queue: false, async: true });
          return;
        }
        case 'pid_swing_set':
        case 'pid_swing_relative_set': {
          const a = num(1);
          if (a === undefined) return warn(pos, `${method}: angle is not a number`);
          ezHeading.v = method === 'pid_swing_set' ? a : ezHeading.v + a;
          steps.push({ kind: 'swing', side: /LEFT/i.test(args[0] ?? '') ? 'left' : 'right', theta: ezHeading.v, maxSpeed: spd(2), timeout: 5000, queue: false, async: true });
          return;
        }
        case 'pid_odom_set': {
          // pid_odom_set(distance, speed) or pid_odom_set({{x, y}, fwd, speed}) or a list of such points
          const a0 = (args[0] ?? '').trim();
          if (!a0.startsWith('{')) {
            const d = num(0);
            if (d !== undefined) steps.push({ kind: 'drive', inches: d, maxSpeed: spd(1), timeout: 5000, queue: false, async: true });
            return;
          }
          const pts = a0.startsWith('{{{') ? splitArgs(a0.slice(1, -1)) : [a0];
          for (const p of pts) {
            const parts = splitArgs(p.trim().slice(1, -1));
            const xy = splitArgs((parts[0] ?? '').trim().slice(1, -1));
            const x = evalExpr(xy[0] ?? '', scope);
            const y = evalExpr(xy[1] ?? '', scope);
            if (typeof x !== 'number' || typeof y !== 'number') {
              warn(pos, 'pid_odom_set: point is not numbers');
              continue;
            }
            const fwd = !/rev/i.test(parts[1] ?? 'fwd');
            const s = parts[2] !== undefined ? evalExpr(parts[2], scope) : null;
            steps.push({ kind: 'moveToPoint', x, y, forwards: fwd, maxSpeed: typeof s === 'number' ? s : spd(1), timeout: 5000, queue: false, async: true });
            // later points follow on from the earlier ones
            if (pts.length > 1) steps.push({ kind: 'waitUntilDone' });
          }
          return;
        }
        case 'odom_xyt_set': {
          const x = num(0);
          const y = num(1);
          const t = num(2, 0)!;
          if (x === undefined || y === undefined) return warn(pos, 'odom_xyt_set: coordinates are not numbers');
          ezHeading.v = t;
          steps.push({ kind: 'setPose', x, y, theta: t });
          return;
        }
        case 'odom_xy_set':
        case 'odom_theta_set':
          warn(pos, `${method}: use odom_xyt_set — skipped`);
          return;
        case 'pid_wait':
        case 'pid_wait_quick':
        case 'pid_wait_quick_chain':
          steps.push({ kind: 'waitUntilDone' });
          return;
        case 'pid_wait_until': {
          const d = num(0);
          if (d !== undefined) steps.push({ kind: 'waitUntil', inches: Math.abs(d) });
          return;
        }
        default:
          warn(pos, `${method}: not simulated — skipped`);
          return;
      }
    }
    // ---------------- devices
    const devName = obj.replace(/\[\d+\]$/, '');
    touchDevice(devName, pos);
    const dev = devices.get(devName)!;
    const r = role(devName);
    if (r === 'ignore') return;
    if (r === null) {
      warn(pos, `${devName}.${method}(): which mechanism is "${devName}"? Set its role under Devices.`);
      return;
    }
    const power = (): number | null => {
      if (method === 'move') return num(0) ?? null;
      if (method === 'move_velocity') return num(0) !== undefined ? (num(0)! / 200) * 127 : null;
      if (method === 'move_voltage') return num(0) !== undefined ? (num(0)! / 12000) * 127 : null;
      if (method === 'brake' || method === 'stop') return 0;
      return null;
    };
    const pistonSet = (): boolean | null => {
      if (method === 'set_value' || method === 'set') return bool(0, false);
      if (method === 'extend') return true;
      if (method === 'retract') return false;
      if (method === 'toggle') return !(pistons.get(devName) ?? false);
      return null;
    };
    if (dialect === null) dialect = 'pros';
    switch (r) {
      case 'leftDrive':
      case 'rightDrive': {
        const p = power();
        if (p === null) return warn(pos, `${devName}.${method}: drive motors are simulated for move / move_velocity / move_voltage / brake`);
        steps.push({ kind: 'drivePower', left: r === 'leftDrive' ? p : null, right: r === 'rightDrive' ? p : null });
        return;
      }
      case 'lift': {
        if (method === 'move_absolute') {
          const d = num(0);
          if (d === undefined) return warn(pos, 'move_absolute: position is not a number');
          liftDeg.v = d;
          steps.push({ kind: 'lift', height: liftHeightFromDegrees(opts.robot, d) });
          return;
        }
        if (method === 'move_relative') {
          const d = num(0);
          if (d === undefined) return warn(pos, 'move_relative: distance is not a number');
          liftDeg.v += d;
          steps.push({ kind: 'lift', height: liftHeightFromDegrees(opts.robot, liftDeg.v) });
          return;
        }
        const p = power();
        if (p === null) return warn(pos, `${devName}.${method}: not simulated for the lift`);
        steps.push({ kind: 'liftPower', power: p });
        return;
      }
      case 'claw':
      case 'toggleArm': {
        let on: boolean | null = null;
        if (dev.piston || /set_value|extend|retract|toggle|^set$/.test(method)) {
          const v = pistonSet();
          if (v === null) return warn(pos, `${devName}.${method}: not simulated`);
          pistons.set(devName, v);
          on = r === 'claw' ? v === clawClosedValue : v;
        } else {
          // a motor claw / arm: forward closes / swings out
          const p = method === 'move_absolute' || method === 'move_relative' ? num(0) : power();
          if (p === null || p === undefined) return warn(pos, `${devName}.${method}: not simulated`);
          if (p === 0) return; // holding
          on = p > 0;
        }
        steps.push(r === 'claw' ? { kind: 'claw', closed: on } : { kind: 'toggleArm', on });
        return;
      }
      default:
        return;
    }
  };

  const runBody = (text: string, offset: number, depth: number) => {
    let i = 0;
    let start = 0;
    let paren = 0;
    let brace = 0;
    const flush = (end: number) => {
      const st = text.slice(start, end);
      const lead = st.length - st.trimStart().length;
      execStatement(st, offset + start + lead, depth);
    };
    while (i < text.length) {
      const ch = text[i];
      // control flow at the start of a statement
      if (paren === 0 && brace === 0 && text.slice(start, i).trim() === '') {
        const kw = text.slice(i).match(/^(for|while|if|else|switch|do|try)\b/);
        if (kw) {
          const kwPos = i;
          // header (…)
          let j = i + kw[0].length;
          while (j < text.length && /\s/.test(text[j])) j++;
          let header = '';
          if (text[j] === '(') {
            const hc = matchClose(text, j);
            header = text.slice(j + 1, hc);
            j = hc + 1;
          }
          while (j < text.length && /\s/.test(text[j])) j++;
          let blockEnd: number;
          let blockBody: string;
          let blockOffset: number;
          if (text[j] === '{') {
            blockEnd = matchClose(text, j);
            blockBody = text.slice(j + 1, blockEnd);
            blockOffset = offset + j + 1;
          } else {
            blockEnd = text.indexOf(';', j);
            if (blockEnd < 0) blockEnd = text.length - 1;
            blockBody = text.slice(j, blockEnd + 1);
            blockOffset = offset + j;
          }
          // for (int i = 0; i < N; i++) with a fixed N: unroll
          const fm = kw[1] === 'for' ? header.match(/^\s*(?:int|auto|size_t|unsigned)?\s*(\w+)\s*=\s*([^;]+);\s*\1\s*(<=|<)\s*([^;]+);\s*(?:\1\s*\+\+|\+\+\s*\1|\1\s*\+=\s*1)\s*$/) : null;
          if (fm) {
            const from = evalExpr(fm[2], scope);
            const to = evalExpr(fm[4], scope);
            if (typeof from === 'number' && typeof to === 'number' && to - from <= 50) {
              const last = fm[3] === '<=' ? to : to - 1;
              for (let k = from; k <= last; k++) {
                scope.set(fm[1], k);
                runBody(blockBody, blockOffset, depth + 1);
              }
              scope.delete(fm[1]);
            } else warn(offset + kwPos, `for loop with a count that isn't fixed: skipped`);
          } else if (kw[1] !== 'else') warn(offset + kwPos, `${kw[1]} (…): depends on sensors / conditions the simulator can't predict — skipped`);
          i = blockEnd + 1;
          start = i;
          continue;
        }
      }
      if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (ch === '{') brace++;
      else if (ch === '}') brace--;
      else if (ch === ';' && paren === 0 && brace === 0) {
        flush(i);
        start = i + 1;
      }
      i++;
    }
    if (text.slice(start).trim()) flush(text.length);
  };

  // roles: guesses, then the caller's choices
  for (const d of devices.values()) d.role = opts.roles?.[d.name] ?? guessRole(d.name, d.piston);
  runBody(body.body, body.offset, 0);
  for (const d of devices.values()) d.role = opts.roles?.[d.name] ?? d.role;
  return {
    steps,
    warnings,
    devices: [...devices.values()].filter((d) => used.has(d.name) || d.role !== null),
    functions: [...fns.keys()].filter((n) => !skipFns.has(n)),
    entry: entry?.name ?? null,
    dialect,
  };
}

// ---------------------------------------------------------------- export

export interface ExportOptions {
  flavor: 'lemlib' | 'ez';
  /** A whole main.cpp (devices, chassis, driver control) or autonomous() only. */
  full: boolean;
  robot: RobotConfig;
}

const fmt = (n: number, d = 2) => {
  const v = Math.round(n * 10 ** d) / 10 ** d;
  return Object.is(v, -0) ? '0' : String(v);
};

/** Program-frame poses after each step (for EZ-Template's relative moves). */
function programPoses(steps: AutonStep[]): { x: number; y: number; theta: number }[] {
  let p = { x: 0, y: 0, theta: 0 };
  return steps.map((s) => {
    switch (s.kind) {
      case 'setPose':
        p = { x: s.x, y: s.y, theta: s.theta };
        break;
      case 'moveToPoint': {
        const th = headingToTheta(Math.atan2(s.y - p.y, s.x - p.x) + (s.forwards ? 0 : Math.PI));
        p = { x: s.x, y: s.y, theta: Math.hypot(s.x - p.x, s.y - p.y) > 1e-6 ? th : p.theta };
        break;
      }
      case 'moveToPose':
        p = { x: s.x, y: s.y, theta: s.theta };
        break;
      case 'turnToHeading':
      case 'swing':
        p = { ...p, theta: s.theta };
        break;
      case 'turnToPoint':
        p = { ...p, theta: headingToTheta(Math.atan2(s.y - p.y, s.x - p.x) + (s.forwards ? 0 : Math.PI)) };
        break;
      case 'drive': {
        const h = ((90 - p.theta) * Math.PI) / 180;
        p = { ...p, x: p.x + Math.cos(h) * s.inches, y: p.y + Math.sin(h) * s.inches };
        break;
      }
      default:
        break;
    }
    return { ...p };
  });
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

function gearset(rpm: number): string {
  return rpm >= 600 ? 'blue' : rpm >= 200 ? 'green' : 'red';
}

function wheelConst(d: number): string {
  if (Math.abs(d - 3.25) < 0.01) return 'lemlib::Omniwheel::NEW_325';
  if (Math.abs(d - 2.75) < 0.01) return 'lemlib::Omniwheel::NEW_275';
  if (Math.abs(d - 4) < 0.01) return 'lemlib::Omniwheel::NEW_4';
  return fmt(d);
}

export function exportPros(program: AutonProgram, o: ExportOptions): string {
  const R = o.robot;
  const lines: string[] = [];
  const ind = '  ';
  const say = (s: string) => lines.push(ind + s);
  const poses = programPoses(program.steps);
  let theta0 = 0; // EZ: heading at the start (from setPose), headings are relative to it
  // EZ: a new motion replaces the running one, so wait for it first (LemLib queues them)
  let ezPending = false;
  const ezMotion = (emit: () => void, async: boolean) => {
    if (ezPending) say('chassis.pid_wait();');
    emit();
    ezPending = async;
    if (!async) say('chassis.pid_wait();');
  };
  const lift = (h: number) => Math.round(liftMotorDegrees(R, h));
  program.steps.forEach((s, i) => {
    const before = i > 0 ? poses[i - 1] : { x: 0, y: 0, theta: 0 };
    if (o.flavor === 'lemlib') {
      const opts = (parts: string[]) => (parts.length ? `, {${parts.join(', ')}}` : '');
      const common = (st: { maxSpeed: number; async: boolean }, extra: string[] = []) => {
        const parts = [...extra];
        if (st.maxSpeed < 127) parts.push(`.maxSpeed = ${fmt(st.maxSpeed, 0)}`);
        const o2 = opts(parts);
        return st.async ? o2 : `${o2 || ', {}'}, false`;
      };
      switch (s.kind) {
        case 'setPose':
          return say(`chassis.setPose(${fmt(s.x)}, ${fmt(s.y)}, ${fmt(s.theta)});`);
        case 'moveToPoint':
          return say(`chassis.moveToPoint(${fmt(s.x)}, ${fmt(s.y)}, ${fmt(s.timeout, 0)}${common(s, s.forwards ? [] : ['.forwards = false'])});`);
        case 'moveToPose':
          return say(`chassis.moveToPose(${fmt(s.x)}, ${fmt(s.y)}, ${fmt(s.theta)}, ${fmt(s.timeout, 0)}${common(s, [...(s.forwards ? [] : ['.forwards = false']), ...(Math.abs(s.lead - 0.6) > 1e-6 ? [`.lead = ${fmt(s.lead)}`] : [])])});`);
        case 'turnToHeading':
          return say(`chassis.turnToHeading(${fmt(s.theta)}, ${fmt(s.timeout, 0)}${common(s)});`);
        case 'turnToPoint':
          return say(`chassis.turnToPoint(${fmt(s.x)}, ${fmt(s.y)}, ${fmt(s.timeout, 0)}${common(s, s.forwards ? [] : ['.forwards = false'])});`);
        case 'drive': {
          const p = poses[i];
          return say(`chassis.moveToPoint(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(s.timeout, 0)}${common(s, s.inches < 0 ? ['.forwards = false'] : [])}); // ${fmt(s.inches)}" straight`);
        }
        case 'swing':
          return say(`chassis.swingToHeading(${fmt(s.theta)}, lemlib::DriveSide::${s.side === 'left' ? 'RIGHT' : 'LEFT'}, ${fmt(s.timeout, 0)}${common(s)});`);
        case 'waitUntilDone':
          return say('chassis.waitUntilDone();');
        case 'waitUntil':
          return say(`chassis.waitUntil(${fmt(s.inches)});`);
        default:
          break;
      }
    } else {
      const rel = (theta: number) => fmt(wrap180(theta - theta0));
      switch (s.kind) {
        case 'setPose':
          theta0 = s.theta;
          return say(`// start: (${fmt(s.x)}, ${fmt(s.y)}) facing ${fmt(s.theta)}° — EZ headings below are relative to it`);
        case 'moveToPoint':
        case 'moveToPose': {
          const dx = s.x - before.x;
          const dy = s.y - before.y;
          const d = Math.hypot(dx, dy);
          const speed = s.maxSpeed < 127 ? fmt(s.maxSpeed, 0) : 'DRIVE_SPEED';
          if (d > 0.5) {
            const face = headingToTheta(Math.atan2(dy, dx) + (s.forwards ? 0 : Math.PI));
            if (Math.abs(wrap180(face - before.theta)) > 1) ezMotion(() => say(`chassis.pid_turn_set(${rel(face)}_deg, TURN_SPEED);`), true);
            ezMotion(() => say(`chassis.pid_drive_set(${fmt(s.forwards ? d : -d)}_in, ${speed}, true);`), s.kind === 'moveToPose' || s.async);
          }
          if (s.kind === 'moveToPose') ezMotion(() => say(`chassis.pid_turn_set(${rel(s.theta)}_deg, TURN_SPEED);`), s.async);
          return;
        }
        case 'turnToHeading':
        case 'turnToPoint':
          return ezMotion(() => say(`chassis.pid_turn_set(${rel(poses[i].theta)}_deg, ${s.maxSpeed < 127 ? fmt(s.maxSpeed, 0) : 'TURN_SPEED'});`), s.async);
        case 'drive':
          return ezMotion(() => say(`chassis.pid_drive_set(${fmt(s.inches)}_in, ${s.maxSpeed < 127 ? fmt(s.maxSpeed, 0) : 'DRIVE_SPEED'}, true);`), s.async);
        case 'swing':
          return ezMotion(() => say(`chassis.pid_swing_set(ez::${s.side === 'left' ? 'LEFT' : 'RIGHT'}_SWING, ${rel(s.theta)}_deg, SWING_SPEED);`), s.async);
        case 'waitUntilDone':
          ezPending = false;
          return say('chassis.pid_wait();');
        case 'waitUntil':
          return say(`chassis.pid_wait_until(${fmt(s.inches)}_in);`);
        default:
          break;
      }
    }
    switch (s.kind) {
      case 'wait':
        return say(`pros::delay(${fmt(s.ms, 0)});`);
      case 'lift':
        return say(`lift.move_absolute(${lift(s.height)}, 100); // holder at ${fmt(s.height, 1)}"`);
      case 'liftPower':
        return say(s.power === 0 ? 'lift.brake();' : `lift.move(${fmt(s.power, 0)});`);
      case 'claw':
        return say(`claw.set_value(${s.closed ? 'true' : 'false'}); // ${s.closed ? 'close' : 'open'}`);
      case 'toggleArm':
        return say(`toggle_arm.set_value(${s.on ? 'true' : 'false'});`);
      case 'drivePower':
        if (s.left !== null) say(`left_mg.move(${fmt(s.left, 0)});`);
        if (s.right !== null) say(`right_mg.move(${fmt(s.right, 0)});`);
        return;
      default:
        return;
    }
  });
  // LemLib motions run in the background: wait for the last one before autonomous() returns
  const lastMotion = [...program.steps].reverse().find(isMotion);
  if (o.flavor === 'lemlib' && lastMotion && program.steps[program.steps.length - 1].kind !== 'waitUntilDone') say('chassis.waitUntilDone();');
  if (o.flavor === 'ez' && ezPending) say('chassis.pid_wait();');

  const auton = [`// ${program.name} — ${program.mode === 'skills' ? 'Skills autonomous (60 s)' : 'match autonomous (15 s)'}, starting tile ${program.slot}`, '// Made with VEX Strategy Lab (Plan mode).', 'void autonomous() {', ...(o.flavor === 'ez' ? [ind + 'chassis.pid_targets_reset();', ind + 'chassis.drive_imu_reset();', ind + 'chassis.drive_sensor_reset();', ind + 'chassis.drive_brake_set(MOTOR_BRAKE_HOLD);'] : []), ...lines, '}'];
  if (!o.full) return auton.join('\n') + '\n';

  const d = R.drivetrain;
  const driveRpm = Math.round(d.left.cartridgeRpm * d.left.gearRatio);
  const devices = [
    '// ---- devices: change the ports (negative = reversed) to match your robot ----',
    ...(o.flavor === 'lemlib'
      ? [`pros::MotorGroup left_mg({-1, -2}, pros::MotorGearset::${gearset(d.left.cartridgeRpm)});`, `pros::MotorGroup right_mg({3, 4}, pros::MotorGearset::${gearset(d.right.cartridgeRpm)});`, 'pros::Imu imu(10);']
      : []),
    `pros::MotorGroup lift({5, -6}, pros::MotorGearset::${gearset(R.lift.motor.cartridgeRpm)}); // lift motors, tared at the bottom`,
    "pros::adi::DigitalOut claw('A');      // true = closed",
    "pros::adi::DigitalOut toggle_arm('B'); // true = out",
    '',
  ];
  const opcontrolBody = (arcade: string) => [
    'void opcontrol() {',
    ind + 'pros::Controller master(pros::E_CONTROLLER_MASTER);',
    ind + 'bool clawClosed = true; // closed on the preload',
    ind + 'while (true) {',
    ind + ind + arcade,
    ind + ind + '// R1 lift up, R2 lift down, L1 claw (each press opens / closes), X toggle arm',
    ind + ind + 'if (master.get_digital(pros::E_CONTROLLER_DIGITAL_R1)) lift.move(127);',
    ind + ind + 'else if (master.get_digital(pros::E_CONTROLLER_DIGITAL_R2)) lift.move(-127);',
    ind + ind + 'else lift.brake();',
    ind + ind + 'if (master.get_digital_new_press(pros::E_CONTROLLER_DIGITAL_L1)) {',
    ind + ind + ind + 'clawClosed = !clawClosed;',
    ind + ind + ind + 'claw.set_value(clawClosed);',
    ind + ind + '}',
    ind + ind + 'toggle_arm.set_value(master.get_digital(pros::E_CONTROLLER_DIGITAL_X));',
    ind + ind + 'pros::delay(10);',
    ind + '}',
    '}',
  ];
  if (o.flavor === 'lemlib') {
    return [
      '#include "main.h"',
      '#include "lemlib/api.hpp"',
      '',
      ...devices,
      `// ${fmt(d.trackWidthIn)}" track, ${fmt(d.wheelDiameterIn)}" wheels at ${driveRpm} rpm (the simulated robot)`,
      `lemlib::Drivetrain drivetrain(&left_mg, &right_mg, ${fmt(d.trackWidthIn)}, ${wheelConst(d.wheelDiameterIn)}, ${driveRpm}, 2);`,
      'lemlib::OdomSensors sensors(nullptr, nullptr, nullptr, nullptr, &imu); // add tracking wheels if you have them',
      '// PID gains: tune on the real robot',
      'lemlib::ControllerSettings lateral(10, 0, 3, 3, 1, 100, 3, 500, 20);',
      'lemlib::ControllerSettings angular(2, 0, 10, 3, 1, 100, 3, 500, 0);',
      'lemlib::Chassis chassis(drivetrain, lateral, angular, sensors);',
      '',
      'void initialize() {',
      ind + 'chassis.calibrate();',
      ind + 'lift.tare_position();',
      ind + 'claw.set_value(true);',
      ind + 'chassis.setBrakeMode(pros::E_MOTOR_BRAKE_BRAKE);',
      '}',
      '',
      'void disabled() {}',
      'void competition_initialize() {}',
      '',
      ...auton,
      '',
      ...opcontrolBody('chassis.arcade(master.get_analog(pros::E_CONTROLLER_ANALOG_LEFT_Y), master.get_analog(pros::E_CONTROLLER_ANALOG_RIGHT_X));'),
      '',
    ].join('\n');
  }
  return [
    '#include "main.h"',
    '',
    '// ---- chassis: left ports, right ports, IMU port, wheel diameter, wheel rpm ----',
    `ez::Drive chassis({-1, -2}, {3, 4}, 10, ${fmt(d.wheelDiameterIn)}, ${driveRpm});`,
    ...devices,
    'const int DRIVE_SPEED = 110;',
    'const int TURN_SPEED = 90;',
    'const int SWING_SPEED = 110;',
    '',
    'void initialize() {',
    ind + 'pros::delay(500);',
    ind + '// PID gains: tune on the real robot',
    ind + 'chassis.pid_heading_constants_set(11, 0, 20);',
    ind + 'chassis.pid_drive_constants_set(20, 0, 100);',
    ind + 'chassis.pid_turn_constants_set(3, 0.05, 20, 15);',
    ind + 'chassis.pid_swing_constants_set(6, 0, 65);',
    ind + 'chassis.initialize();',
    ind + 'lift.tare_position();',
    ind + 'claw.set_value(true);',
    '}',
    '',
    'void disabled() {}',
    'void competition_initialize() {}',
    '',
    ...auton,
    '',
    ...opcontrolBody('chassis.opcontrol_arcade_standard(ez::SPLIT);'),
    '',
  ].join('\n');
}
