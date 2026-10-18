import { LIFT_PRESETS, zeroInput, type DriverInput } from '../sim/driver';

/**
 * Local driver controls: keyboard, mouse and a controller merged into one DriverInput.
 * Every action is rebindable (two keys and one controller button each), saved in
 * this browser. The mouse is fixed: left click opens / closes the claw, drag looks
 * around (3rd / 1st person), the wheel zooms (all the way in: first person).
 *
 * Controller (standard mapping): split arcade by default — left stick drives, right
 * stick turns — or one stick (left stick drives and turns; the right stick moves the
 * camera). Analog triggers raise / lower the arm proportionally.
 */

export type ActionId =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'armUp'
  | 'armDown'
  | 'claw'
  | 'drop'
  | 'toggleArm'
  | 'swap'
  | 'flip'
  | 'load'
  | 'preset1'
  | 'preset2'
  | 'preset3'
  | 'preset4'
  | 'playPause'
  | 'easy'
  | 'momentum'
  | 'viewReset'
  | 'firstPerson';

export interface ActionDef {
  id: ActionId;
  label: string;
  /** Read continuously while held (vs. firing once per press). */
  hold: boolean;
}

export const ACTIONS: ActionDef[] = [
  { id: 'forward', label: 'Drive forward', hold: true },
  { id: 'back', label: 'Drive backward', hold: true },
  { id: 'left', label: 'Turn left', hold: true },
  { id: 'right', label: 'Turn right', hold: true },
  { id: 'armUp', label: 'Arm up', hold: true },
  { id: 'armDown', label: 'Arm down', hold: true },
  { id: 'claw', label: 'Claw: close / open (also left click)', hold: false },
  { id: 'drop', label: 'Open the claw (drop)', hold: false },
  { id: 'preset1', label: 'Arm to the floor', hold: false },
  { id: 'preset2', label: 'Arm to an Alliance Goal', hold: false },
  { id: 'preset3', label: 'Arm to a short Goal', hold: false },
  { id: 'preset4', label: 'Arm to the tall Goal', hold: false },
  { id: 'toggleArm', label: 'Toggle arm (hold)', hold: true },
  { id: 'flip', label: 'Flip the held piece', hold: false },
  { id: 'swap', label: 'Swap pockets (two-pocket holder)', hold: false },
  { id: 'load', label: 'Request a Match Load', hold: false },
  { id: 'easy', label: 'Easy claw on / off', hold: false },
  { id: 'momentum', label: 'No momentum on / off', hold: false },
  { id: 'firstPerson', label: 'First / third person', hold: false },
  { id: 'viewReset', label: 'Camera behind the robot', hold: false },
  { id: 'playPause', label: 'Play / pause', hold: false },
];

export type PadLayout = 'split' | 'single';

export interface Bindings {
  /** Up to two keys per action (KeyboardEvent.key in lower case; ' ' is Space). */
  keys: Record<ActionId, [string | null, string | null]>;
  /** One controller button per action (standard-mapping index), or null. */
  pad: Record<ActionId, number | null>;
  padLayout: PadLayout;
}

export const DEFAULT_BINDINGS: Bindings = {
  keys: {
    forward: ['w', 'arrowup'],
    back: ['s', 'arrowdown'],
    left: ['a', 'arrowleft'],
    right: ['d', 'arrowright'],
    armUp: [' ', 'r'],
    armDown: ['shift', 'f'],
    claw: ['c', null],
    drop: ['e', null],
    preset1: ['1', null],
    preset2: ['2', null],
    preset3: ['3', null],
    preset4: ['4', null],
    toggleArm: ['t', null],
    flip: ['x', null],
    swap: ['q', null],
    load: ['l', null],
    easy: ['g', null],
    momentum: ['m', null],
    firstPerson: ['b', null],
    viewReset: ['v', null],
    playPause: ['p', null],
  },
  pad: {
    forward: null,
    back: null,
    left: null,
    right: null,
    armUp: 7,
    armDown: 6,
    claw: 0,
    drop: 1,
    preset1: 13,
    preset2: 14,
    preset3: 15,
    preset4: 12,
    toggleArm: 2,
    flip: 3,
    swap: 4,
    load: 5,
    easy: 8,
    momentum: null,
    firstPerson: 10,
    viewReset: 11,
    playPause: 9,
  },
  padLayout: 'split',
};

const KEY_NAMES: Record<string, string> = { ' ': 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', shift: 'Shift', control: 'Ctrl', alt: 'Alt', meta: 'Meta', enter: 'Enter', tab: 'Tab', backspace: 'Backspace' };
/** How a key is shown ("Space", "↑", "W"). */
export const keyName = (k: string | null) => (k === null ? '—' : (KEY_NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))));

const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
/** How a controller button is shown (standard mapping). */
export const padName = (b: number | null) => (b === null ? '—' : (PAD_NAMES[b] ?? `Button ${b}`));

const clone = (b: Bindings): Bindings => ({ keys: Object.fromEntries(Object.entries(b.keys).map(([k, v]) => [k, [...v]])) as Bindings['keys'], pad: { ...b.pad }, padLayout: b.padLayout });

function loadBindings(): Bindings {
  const b = clone(DEFAULT_BINDINGS);
  try {
    const saved = JSON.parse(localStorage.getItem('vsl-bindings') ?? 'null') as Partial<Bindings> | null;
    if (saved) {
      for (const a of ACTIONS) {
        if (saved.keys?.[a.id]) b.keys[a.id] = [saved.keys[a.id][0] ?? null, saved.keys[a.id][1] ?? null];
        if (saved.pad && a.id in saved.pad) b.pad[a.id] = saved.pad[a.id] ?? null;
      }
      if (saved.padLayout === 'single' || saved.padLayout === 'split') b.padLayout = saved.padLayout;
    }
  } catch {
    /* storage unavailable or corrupt: defaults */
  }
  return b;
}

type Listener = (inp: DriverInput) => void;
type Capture = { kind: 'key'; action: ActionId; slot: 0 | 1 } | { kind: 'pad'; action: ActionId };

class LocalInput {
  readonly state: DriverInput = zeroInput();
  bindings: Bindings = clone(DEFAULT_BINDINGS);
  gamepad: string | null = null;
  /** Waiting for a key / button press to bind (the controls editor). */
  capture: Capture | null = null;
  private keys = new Set<string>();
  private pad = { forward: 0, turn: 0, lift: 0, toggle: false };
  private padPrev: boolean[] = [];
  private listeners = new Set<Listener>();
  private bindListeners = new Set<() => void>();
  /** Called for play / pause. */
  onPlayPause: (() => void) | null = null;
  /** Called when a drive key is pressed or a stick moved (the field may hand you a robot). */
  onDriveKey: (() => void) | null = null;
  /** Camera: back behind the robot / first ↔ third person / right stick (one-stick layout). */
  onViewReset: (() => void) | null = null;
  onToggleFirstPerson: (() => void) | null = null;
  onCameraStick: ((x: number, y: number) => void) | null = null;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /** Bindings or capture changed (the controls editor re-renders). */
  onBindings(l: () => void): () => void {
    this.bindListeners.add(l);
    return () => {
      this.bindListeners.delete(l);
    };
  }

  private changed() {
    for (const l of this.listeners) l(this.state);
  }

  private bindingsChanged() {
    try {
      localStorage.setItem('vsl-bindings', JSON.stringify(this.bindings));
    } catch {
      /* storage unavailable */
    }
    for (const l of this.bindListeners) l();
  }

  // ------------------------------------------------------------- bindings

  /** Wait for the next key / controller button and bind it (Escape cancels). */
  startCapture(c: Capture | null) {
    this.capture = c;
    for (const l of this.bindListeners) l();
  }

  private bindKey(action: ActionId, slot: 0 | 1, key: string) {
    // a key does one thing: take it off any other action
    for (const a of ACTIONS) {
      const ks = this.bindings.keys[a.id];
      for (const i of [0, 1] as const) if (ks[i] === key && !(a.id === action && i === slot)) ks[i] = null;
    }
    this.bindings.keys[action][slot] = key;
    this.capture = null;
    this.bindingsChanged();
  }

  private bindPad(action: ActionId, button: number) {
    for (const a of ACTIONS) if (this.bindings.pad[a.id] === button && a.id !== action) this.bindings.pad[a.id] = null;
    this.bindings.pad[action] = button;
    this.capture = null;
    this.bindingsChanged();
  }

  clearBinding(action: ActionId, which: 0 | 1 | 'pad') {
    if (which === 'pad') this.bindings.pad[action] = null;
    else this.bindings.keys[action][which] = null;
    this.bindingsChanged();
  }

  setPadLayout(l: PadLayout) {
    this.bindings.padLayout = l;
    this.bindingsChanged();
  }

  resetBindings() {
    this.bindings = clone(DEFAULT_BINDINGS);
    this.capture = null;
    this.bindingsChanged();
  }

  /** Keys bound to an action, for hints ("W", "Space"). */
  keysFor(action: ActionId): string {
    return this.bindings.keys[action]
      .filter((k): k is string => k !== null)
      .map(keyName)
      .join(' / ');
  }

  private actionsForKey(key: string): ActionId[] {
    return ACTIONS.filter((a) => this.bindings.keys[a.id].includes(key)).map((a) => a.id);
  }

  private held(action: ActionId): boolean {
    return this.bindings.keys[action].some((k) => k !== null && this.keys.has(k));
  }

  // --------------------------------------------------------------- state

  private merge() {
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const kbF = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    const kbT = (this.held('left') ? 1 : 0) - (this.held('right') ? 1 : 0);
    const kbL = (this.held('armUp') ? 1 : 0) - (this.held('armDown') ? 1 : 0);
    const s = this.state;
    const next = {
      forward: clamp(kbF + this.pad.forward),
      turn: clamp(kbT + this.pad.turn),
      lift: clamp(kbL + this.pad.lift),
      toggle: this.held('toggleArm') || this.pad.toggle,
    };
    const diff = next.forward !== s.forward || next.turn !== s.turn || next.lift !== s.lift || next.toggle !== s.toggle;
    Object.assign(s, next);
    if (next.lift !== 0) s.preset = null;
    return diff;
  }

  private press(what: 'drop' | 'index' | 'flip' | 'load') {
    this.state[what]++;
    this.changed();
  }

  private preset(i: number) {
    this.state.preset = LIFT_PRESETS[i].h;
    this.changed();
  }

  /** Close the claw (grab what is in front) or open it (let go). */
  toggleClaw() {
    this.state.claw = !this.state.claw;
    this.changed();
  }

  /** Easy claw: grabs whatever the robot drives into (remembered in this browser). */
  setEasy(on: boolean) {
    this.state.easy = on;
    this.remember('vsl-easy', on);
    this.changed();
  }

  /** No momentum: the robot goes exactly as fast as you steer and stops when you let go. */
  setNoMomentum(on: boolean) {
    this.state.noMomentum = on;
    this.remember('vsl-nomomentum', on);
    this.changed();
  }

  private remember(key: string, on: boolean) {
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }

  /** A press of a non-hold action (keyboard or controller). */
  private fire(a: ActionId) {
    switch (a) {
      case 'claw':
        this.toggleClaw();
        break;
      case 'drop':
        this.press('drop');
        break;
      case 'swap':
        this.press('index');
        break;
      case 'flip':
        this.press('flip');
        break;
      case 'load':
        this.press('load');
        break;
      case 'preset1':
      case 'preset2':
      case 'preset3':
      case 'preset4':
        this.preset(Number(a.slice(-1)) - 1);
        break;
      case 'playPause':
        this.onPlayPause?.();
        break;
      case 'easy':
        this.setEasy(!this.state.easy);
        break;
      case 'momentum':
        this.setNoMomentum(!this.state.noMomentum);
        break;
      case 'viewReset':
        this.onViewReset?.();
        break;
      case 'firstPerson':
        this.onToggleFirstPerson?.();
        break;
      default:
        break;
    }
  }

  /** Attach keyboard listeners; returns a detach function. */
  attachKeyboard(): () => void {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      const c = this.capture;
      if (c) {
        // binding: Escape cancels, Delete clears, any other key is the new key
        e.preventDefault();
        if (k === 'escape') this.startCapture(null);
        else if (k === 'delete') {
          this.capture = null;
          this.clearBinding(c.action, c.kind === 'pad' ? 'pad' : c.slot);
        } else if (c.kind === 'key') this.bindKey(c.action, c.slot, k);
        return;
      }
      const acts = this.actionsForKey(k);
      if (acts.length || k === ' ' || k.startsWith('arrow')) e.preventDefault(); // no page scrolling while driving
      if (e.repeat) return;
      if (acts.some((a) => a === 'forward' || a === 'back' || a === 'left' || a === 'right')) this.onDriveKey?.();
      for (const a of acts) if (!ACTIONS.find((x) => x.id === a)!.hold) this.fire(a);
      this.keys.add(k);
      if (this.merge()) this.changed();
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && this.actionsForKey(k).length) e.preventDefault(); // Space must not click a focused button
      this.keys.delete(k);
      if (this.merge()) this.changed();
    };
    const blur = () => {
      this.keys.clear();
      if (this.merge()) this.changed();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }

  /** Poll the first connected controller (call once per animation frame). */
  pollGamepad() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected) ?? null;
    this.gamepad = gp ? gp.id : null;
    if (!gp) {
      if (this.pad.forward || this.pad.turn || this.pad.lift || this.pad.toggle) {
        this.pad = { forward: 0, turn: 0, lift: 0, toggle: false };
        if (this.merge()) this.changed();
      }
      return;
    }
    const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : Math.round(v * 20) / 20);
    const btn = (i: number | null) => i !== null && !!gp.buttons[i]?.pressed;
    const val = (i: number | null) => (i === null ? 0 : (gp.buttons[i]?.value ?? 0));
    const edge = (i: number) => !!gp.buttons[i]?.pressed && !this.padPrev[i];
    if (this.capture?.kind === 'pad') {
      const i = gp.buttons.findIndex((_, j) => edge(j));
      if (i >= 0) this.bindPad(this.capture.action, i);
      this.padPrev = gp.buttons.map((b) => b.pressed);
      return;
    }
    const P = this.bindings.pad;
    const single = this.bindings.padLayout === 'single';
    const stickF = dz(-(gp.axes[1] ?? 0));
    const stickT = dz(-(gp.axes[single ? 0 : 2] ?? 0));
    this.pad = {
      forward: Math.max(-1, Math.min(1, stickF + (btn(P.forward) ? 1 : 0) - (btn(P.back) ? 1 : 0))),
      turn: Math.max(-1, Math.min(1, stickT + (btn(P.left) ? 1 : 0) - (btn(P.right) ? 1 : 0))),
      lift: dz(val(P.armUp) - val(P.armDown)),
      toggle: btn(P.toggleArm),
    };
    if (single) {
      const cx = dz(gp.axes[2] ?? 0);
      const cy = dz(gp.axes[3] ?? 0);
      if (cx || cy) this.onCameraStick?.(cx, cy);
    }
    if (this.pad.forward || this.pad.turn) this.onDriveKey?.();
    for (const a of ACTIONS) {
      const b = P[a.id];
      if (b !== null && !a.hold && edge(b)) this.fire(a.id);
    }
    this.padPrev = gp.buttons.map((b) => b.pressed);
    if (this.merge()) this.changed();
  }
}

export const localInput = new LocalInput();
try {
  localInput.bindings = loadBindings();
  localInput.state.easy = localStorage.getItem('vsl-easy') === '1';
  localInput.state.noMomentum = localStorage.getItem('vsl-nomomentum') === '1';
} catch {
  /* storage unavailable */
}
