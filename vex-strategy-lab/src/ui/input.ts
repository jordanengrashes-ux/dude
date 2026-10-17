import { LIFT_PRESETS, zeroInput, type DriverInput } from '../sim/driver';

/**
 * Local driver controls: keyboard, mouse and gamepad merged into one DriverInput.
 *
 * Keyboard / mouse                   Gamepad (standard layout)
 *   W/S or ↑/↓   drive                 left stick Y    drive
 *   A/D or ←/→   turn                  right stick X   turn
 *   Shift        arm up                RT              arm up
 *   Space        arm down              LT              arm down
 *   left click   claw open / close     A               claw open / close
 *   C            claw open / close     B               open the claw (drop)
 *   E            open the claw (drop)
 *   1 2 3 4      arm presets           D-pad ↓ ← → ↑   presets (floor, Alliance, short, tall)
 *   T            toggle arm (hold)     X               toggle arm
 *   Q            swap pockets          LB              swap pockets
 *   X            flip object           Y               flip object
 *   L            Match Load            RB              Match Load
 *   P            play / pause          Start           play / pause
 * R / F also raise / lower the arm.
 */

export const KEY_HELP: [string, string][] = [
  ['W A S D · arrows', 'drive and turn'],
  ['Shift', 'arm up'],
  ['Space', 'arm down'],
  ['Left click · C', 'claw: close (grab) / open (drop)'],
  ['E', 'open the claw (drop)'],
  ['1 2 3 4', 'arm to floor / Alliance / short / tall Goal'],
  ['T (hold)', 'toggle arm'],
  ['Q', 'swap pockets'],
  ['X', 'flip the held object'],
  ['L', 'request a Match Load'],
  ['P', 'play / pause'],
  ['Mouse wheel', 'camera distance (3rd person)'],
];

export const PAD_HELP: [string, string][] = [
  ['Left stick', 'drive'],
  ['Right stick', 'turn'],
  ['RT / LT', 'arm up / down'],
  ['A', 'claw: close / open'],
  ['B', 'open the claw (drop)'],
  ['D-pad ↓ ← → ↑', 'arm presets'],
  ['X (hold)', 'toggle arm'],
  ['LB', 'swap pockets'],
  ['Y', 'flip'],
  ['RB', 'Match Load'],
  ['Start', 'play / pause'],
];

type Listener = (inp: DriverInput) => void;

/** Keys that drive the robot: pressing one while not driving takes over your robot. */
const DRIVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

class LocalInput {
  readonly state: DriverInput = zeroInput();
  gamepad: string | null = null;
  private keys = new Set<string>();
  private pad = { forward: 0, turn: 0, lift: 0, toggle: false };
  private padPrev: boolean[] = [];
  private listeners = new Set<Listener>();
  /** Called for P / Start. */
  onPlayPause: (() => void) | null = null;
  /** Called when a drive key is pressed (the field may hand you a robot). */
  onDriveKey: (() => void) | null = null;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private changed() {
    for (const l of this.listeners) l(this.state);
  }

  private merge() {
    const k = (...names: string[]) => names.some((n) => this.keys.has(n));
    const kbF = (k('w', 'arrowup') ? 1 : 0) - (k('s', 'arrowdown') ? 1 : 0);
    const kbT = (k('a', 'arrowleft') ? 1 : 0) - (k('d', 'arrowright') ? 1 : 0);
    const kbL = (k('shift', 'r') ? 1 : 0) - (k(' ', 'f') ? 1 : 0);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const s = this.state;
    const next = {
      forward: clamp(kbF + this.pad.forward),
      turn: clamp(kbT + this.pad.turn),
      lift: clamp(kbL + this.pad.lift),
      toggle: k('t') || this.pad.toggle,
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
    this.setClaw(!this.state.claw);
  }

  private setClaw(closed: boolean) {
    if (this.state.claw === closed) return;
    this.state.claw = closed;
    this.changed();
  }

  /** Attach keyboard listeners; returns a detach function. */
  attachKeyboard(): () => void {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault(); // no page scrolling while driving
      if (e.repeat) return;
      if (k === 'p') {
        this.onPlayPause?.();
        return;
      }
      if (DRIVE_KEYS.has(k)) this.onDriveKey?.();
      if (k === 'c') this.toggleClaw();
      else if (k === 'e' || k === 'v') {
        this.setClaw(false);
        this.press('drop');
      } else if (k === 'q') this.press('index');
      else if (k === 'x') this.press('flip');
      else if (k === 'l') this.press('load');
      else if (k >= '1' && k <= '4') this.preset(Number(k) - 1);
      this.keys.add(k);
      if (this.merge()) this.changed();
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
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

  /** Poll the first connected gamepad (call once per animation frame). */
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
    const btn = (i: number) => !!gp.buttons[i]?.pressed;
    const val = (i: number) => gp.buttons[i]?.value ?? 0;
    this.pad = {
      forward: dz(-(gp.axes[1] ?? 0)),
      turn: dz(-(gp.axes[2] ?? 0)),
      lift: dz(val(7) - val(6)),
      toggle: btn(2),
    };
    const edge = (i: number) => btn(i) && !this.padPrev[i];
    if (edge(0)) this.toggleClaw();
    if (edge(1)) {
      this.setClaw(false);
      this.press('drop');
    }
    if (edge(4)) this.press('index');
    if (edge(3)) this.press('flip');
    if (edge(5)) this.press('load');
    if (edge(13)) this.preset(0);
    if (edge(14)) this.preset(1);
    if (edge(15)) this.preset(2);
    if (edge(12)) this.preset(3);
    if (edge(9)) this.onPlayPause?.();
    if (this.pad.forward || this.pad.turn) this.onDriveKey?.();
    this.padPrev = gp.buttons.map((b) => b.pressed);
    if (this.merge()) this.changed();
  }
}

export const localInput = new LocalInput();
