import { useSyncExternalStore } from 'react';
import { buildToggles } from '../field/geometry';
import { toWorld } from '../physics/frames';
import { zeroInput, type DriverInput } from '../sim/driver';
import { hudData, type HudData, type SceneFrame } from '../sim/frame';
import type { MatchSim } from '../sim/match';
import type { SimRunner } from '../ui/simRunner';
import { decodeSnap, encodeSnap, lerpFrame, setupFrom, type Msg, type PeerInfo, type Roster, type SetupMsg } from './protocol';
import { LocalTransport, SupabaseTransport, type Transport } from './transport';

/**
 * Team mode. Every robot is driven by its bot until a player takes it; when a
 * player joins a room they replace a bot, and when they leave the bot takes the
 * robot back and replans from the current field.
 *
 * The host runs the only physics simulation (deterministic, fixed step) and
 * streams compact snapshots (~8 Hz, keyframe every 2 s); guests interpolate them
 * ~150 ms behind and send their driver inputs when they change (plus a heartbeat).
 * That keeps a 4-player room well inside Supabase Realtime's free-plan budget.
 */

export type TeamRole = 'none' | 'host' | 'guest';

export interface TeamState {
  role: TeamRole;
  room: string | null;
  me: string;
  name: string;
  transport: 'online' | 'local' | null;
  roster: Roster;
  peers: PeerInfo[];
  status: string;
  error: string | null;
  connecting: boolean;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomId = (n: number) => Array.from({ length: n }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

const SNAP_MS = 125;
const KEYFRAME_EVERY = 16;
const RENDER_DELAY_MS = 150;
const INPUT_MIN_MS = 60;
const INPUT_HEARTBEAT_MS = 400;
/** A player missing from presence keeps their robot this long (brief stalls, reconnects). */
const PLAYER_GRACE_MS = 6000;
/** A guest gives up on a host missing from presence this long. */
const HOST_GRACE_MS = 8000;

export class TeamSession {
  state: TeamState;
  private listeners = new Set<() => void>();
  private transport: Transport | null = null;
  // host
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private snapK = 0;
  private prevRows = new Map<number, string>();
  private lastSim: MatchSim | null = null;
  private keyNext = true;
  private unsubRunner: (() => void) | null = null;
  private missingSince = new Map<string, number>();
  // guest
  setup: SetupMsg | null = null;
  hud: HudData | null = null;
  hostPlaying = false;
  private frames: { at: number; frame: SceneFrame }[] = [];
  private togglePos = new Map<string, { x: number; y: number; z: number }>();
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private lastInputSent = 0;
  private lastInputKey = '';
  private pendingInput: DriverInput | null = null;
  private hostId: string | null = null;
  private hostSeen = false;
  private hostMissingSince: number | null = null;

  constructor(
    private runner: SimRunner,
    private makeTransport: (kind: 'online' | 'local') => Transport = (k) => (k === 'online' ? new SupabaseTransport() : new LocalTransport()),
    private now: () => number = () => performance.now(),
  ) {
    this.state = { role: 'none', room: null, me: randomId(8), name: 'Player', transport: null, roster: {}, peers: [], status: '', error: null, connecting: false };
    for (const tg of buildToggles()) {
      const p = toWorld(tg.pos.x + tg.normal.x * tg.axisOffset, tg.pos.y + tg.normal.y * tg.axisOffset, tg.pivotHeight);
      this.togglePos.set(tg.id, { x: p.x, y: p.y, z: p.z });
    }
  }

  get role() {
    return this.state.role;
  }

  private snapListeners = new Set<() => void>();
  /** Called whenever a snapshot arrives (guests), for views that redraw from it. */
  onSnap(l: () => void): () => void {
    this.snapListeners.add(l);
    return () => {
      this.snapListeners.delete(l);
    };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private set(p: Partial<TeamState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  private send(m: Msg) {
    this.transport?.send(m);
  }

  // ------------------------------------------------------------------ host

  async host(name: string, kind: 'online' | 'local', room = randomId(5)) {
    await this.leave();
    this.set({ connecting: true, error: null, status: 'Opening room…', name });
    try {
      const t = this.makeTransport(kind);
      t.onMessage((m) => this.onHostMsg(m));
      t.onPresence((peers) => this.onHostPresence(peers));
      await t.connect(room, { peerId: this.state.me, name, role: 'host', at: Date.now() });
      this.transport = t;
      this.set({ role: 'host', room, transport: kind, connecting: false, roster: this.hostRoster(), status: `Room ${room} open — share the code` });
      this.snapTimer = setInterval(() => this.hostTick(), SNAP_MS);
      this.unsubRunner = this.runner.subscribe(() => {
        // a rebuilt match (Reset, setup change) re-sends the setup and the roster
        if (this.runner.sim && this.runner.sim !== this.lastSim) this.hostTick();
        const r = this.hostRoster();
        if (JSON.stringify(r) !== JSON.stringify(this.state.roster)) {
          this.set({ roster: r });
          this.send({ type: 'roster', from: this.state.me, roster: r });
        }
      });
    } catch (e) {
      this.set({ connecting: false, error: e instanceof Error ? e.message : String(e), status: '' });
    }
  }

  /** Roster as seen from the runner's slot drivers. */
  private hostRoster(): Roster {
    const r: Roster = {};
    for (const rb of this.runner.sim?.robots ?? []) {
      const d = this.runner.driverOf(rb.id);
      r[rb.id] = d.kind === 'bot' ? { peerId: null, name: 'Bot' } : d.kind === 'local' ? { peerId: this.state.me, name: this.state.name } : { peerId: d.peerId, name: d.name };
    }
    return r;
  }

  private hostTick() {
    const sim = this.runner.sim;
    if (!sim || !this.transport) return;
    // players missing from presence past the grace period hand their robots back
    const now = this.now();
    for (const [peerId, since] of this.missingSince) {
      if (now - since > PLAYER_GRACE_MS) {
        this.missingSince.delete(peerId);
        this.releasePeer(peerId);
        this.broadcastRoster();
      }
    }
    const store = this.runner.scenarioInfo();
    if (sim !== this.lastSim) {
      this.lastSim = sim;
      this.keyNext = true;
      this.prevRows.clear();
      if (store) this.send({ type: 'setup', from: this.state.me, setup: setupFrom(sim.sceneFrame(), this.state.me, store.matchType, store.params, store.layout) });
      this.send({ type: 'roster', from: this.state.me, roster: this.hostRoster() });
    }
    const key = this.keyNext || this.snapK % KEYFRAME_EVERY === 0;
    this.keyNext = false;
    const snap = encodeSnap(sim.sceneFrame(), hudData(sim), this.snapK++, key, this.prevRows, this.runner.playing);
    this.send({ type: 'snap', from: this.state.me, snap });
  }

  private onHostMsg(m: Msg) {
    if (m.from === this.state.me) return;
    switch (m.type) {
      case 'hello': {
        const sim = this.runner.sim;
        const info = this.runner.scenarioInfo();
        if (sim && info) this.send({ type: 'setup', from: this.state.me, to: m.from, setup: setupFrom(sim.sceneFrame(), this.state.me, info.matchType, info.params, info.layout) });
        this.keyNext = true;
        // a joining player replaces a bot: the host's partner first, then the others
        const roster = this.hostRoster();
        const already = Object.values(roster).some((e) => e.peerId === m.from);
        if (!already) {
          const mySlot = Object.keys(roster).find((s) => roster[s].peerId === this.state.me);
          const myAlliance = mySlot ? this.runner.sim?.robots.find((r) => r.id === mySlot)?.alliance : 'red';
          const free = Object.keys(roster).filter((s) => roster[s].peerId === null);
          const ally = (s: string) => this.runner.sim?.robots.find((r) => r.id === s)?.alliance === myAlliance;
          const pick = free.sort((a, b) => Number(ally(b)) - Number(ally(a)))[0];
          if (pick) this.runner.setDriver(pick, { kind: 'remote', name: m.name, peerId: m.from });
        }
        this.broadcastRoster();
        break;
      }
      case 'claim': {
        const roster = this.hostRoster();
        if (roster[m.slot] && roster[m.slot].peerId === null) {
          const name = this.state.peers.find((p) => p.peerId === m.from)?.name ?? 'Player';
          this.releasePeer(m.from);
          this.runner.setDriver(m.slot, { kind: 'remote', name, peerId: m.from });
        }
        this.broadcastRoster();
        break;
      }
      case 'release':
      case 'bye':
        this.missingSince.delete(m.from);
        this.releasePeer(m.from);
        this.broadcastRoster();
        break;
      case 'input': {
        const d = this.runner.driverOf(m.slot);
        if (d.kind === 'remote' && d.peerId === m.from) this.runner.remote.set(m.slot, m.inp);
        break;
      }
    }
  }

  private releasePeer(peerId: string) {
    for (const rb of this.runner.sim?.robots ?? []) {
      const d = this.runner.driverOf(rb.id);
      if (d.kind === 'remote' && d.peerId === peerId) this.runner.setDriver(rb.id, { kind: 'bot' });
    }
  }

  private broadcastRoster() {
    const r = this.hostRoster();
    this.set({ roster: r });
    this.send({ type: 'roster', from: this.state.me, roster: r });
  }

  private onHostPresence(peers: PeerInfo[]) {
    this.set({ peers });
    const here = new Set(peers.map((p) => p.peerId));
    for (const id of [...this.missingSince.keys()]) if (here.has(id)) this.missingSince.delete(id);
    for (const e of Object.values(this.hostRoster())) {
      if (e.peerId && e.peerId !== this.state.me && !here.has(e.peerId) && !this.missingSince.has(e.peerId)) this.missingSince.set(e.peerId, this.now());
    }
  }

  // ----------------------------------------------------------------- guest

  async join(room: string, name: string, kind: 'online' | 'local') {
    await this.leave();
    room = room.trim().toUpperCase();
    this.set({ connecting: true, error: null, status: `Joining ${room}…`, name });
    try {
      const t = this.makeTransport(kind);
      t.onMessage((m) => this.onGuestMsg(m));
      t.onPresence((peers) => this.onGuestPresence(peers));
      await t.connect(room, { peerId: this.state.me, name, role: 'guest', at: Date.now() });
      this.transport = t;
      this.runner.setPlaying(false);
      this.set({ role: 'guest', room, transport: kind, connecting: false, status: 'Waiting for the host…' });
      const hello = () => this.send({ type: 'hello', from: this.state.me, name });
      hello();
      this.helloTimer = setInterval(() => {
        if (!this.setup) hello();
      }, 1500);
      this.inputTimer = setInterval(() => {
        this.flushInput(true);
        if (this.hostMissingSince !== null && this.now() - this.hostMissingSince > HOST_GRACE_MS) void this.leave('The host left the room.');
      }, INPUT_HEARTBEAT_MS);
    } catch (e) {
      this.set({ connecting: false, error: e instanceof Error ? e.message : String(e), status: '' });
    }
  }

  private onGuestMsg(m: Msg) {
    if (m.from === this.state.me) return;
    switch (m.type) {
      case 'setup':
        if (m.to && m.to !== this.state.me) return;
        this.setup = m.setup;
        if (this.hostId !== m.setup.hostId) this.hostSeen = this.state.peers.some((p) => p.peerId === m.setup.hostId);
        this.hostId = m.setup.hostId;
        this.frames = [];
        this.set({ status: `In room ${this.state.room}` });
        break;
      case 'roster':
        this.set({ roster: m.roster });
        break;
      case 'snap': {
        if (!this.setup) return;
        const last = this.frames[this.frames.length - 1]?.frame ?? null;
        if (!last && !m.snap.f) return; // wait for a keyframe
        const frame = decodeSnap(m.snap, this.setup, last, this.togglePos);
        this.frames.push({ at: this.now(), frame });
        if (this.frames.length > 12) this.frames.splice(0, this.frames.length - 12);
        this.hud = m.snap.h;
        this.hostPlaying = m.snap.playing === 1;
        for (const l of this.snapListeners) l();
        break;
      }
    }
  }

  private onGuestPresence(peers: PeerInfo[]) {
    this.set({ peers });
    if (!this.hostId) return;
    if (peers.some((p) => p.peerId === this.hostId)) {
      this.hostSeen = true;
      this.hostMissingSince = null;
    } else if (this.hostSeen && this.hostMissingSince === null) this.hostMissingSince = this.now();
  }

  /** Interpolated frame ~150 ms behind the newest snapshot (guests). */
  frameAt(t = this.now()): SceneFrame | null {
    const fr = this.frames;
    if (!fr.length) return null;
    const target = t - RENDER_DELAY_MS;
    for (let i = fr.length - 1; i > 0; i--) {
      const a = fr[i - 1];
      const b = fr[i];
      if (a.at <= target && target <= b.at) return lerpFrame(a.frame, b.frame, (target - a.at) / Math.max(1, b.at - a.at));
    }
    return target < fr[0].at ? fr[0].frame : fr[fr.length - 1].frame;
  }

  /** The slot this guest drives, if any. */
  mySlot(): string | null {
    return Object.keys(this.state.roster).find((s) => this.state.roster[s].peerId === this.state.me) ?? null;
  }

  /** Local driver input changed (guests send it to the host). */
  onLocalInput(inp: DriverInput) {
    if (this.state.role !== 'guest') return;
    this.pendingInput = { ...inp };
    this.flushInput(false);
  }

  private flushInput(heartbeat: boolean) {
    const slot = this.mySlot();
    if (!slot || this.state.role !== 'guest') return;
    const inp = this.pendingInput ?? zeroInput();
    const key = JSON.stringify(inp);
    const t = this.now();
    if (!heartbeat && (key === this.lastInputKey || t - this.lastInputSent < INPUT_MIN_MS)) {
      if (key !== this.lastInputKey) setTimeout(() => this.flushInput(false), INPUT_MIN_MS);
      return;
    }
    this.lastInputKey = key;
    this.lastInputSent = t;
    this.send({ type: 'input', from: this.state.me, slot, inp });
  }

  // ------------------------------------------------------------ both roles

  /** Take a robot (host: local driver; guest: ask the host). */
  claimSlot(slot: string) {
    if (this.state.role === 'host') {
      if (this.runner.driverOf(slot).kind === 'bot') this.runner.setDriver(slot, { kind: 'local', name: this.state.name });
      this.broadcastRoster();
    } else if (this.state.role === 'guest') this.send({ type: 'claim', from: this.state.me, slot });
  }

  /** Hand my robot back to its bot. */
  releaseSlot() {
    if (this.state.role === 'host') {
      if (this.runner.localSlot) this.runner.setDriver(this.runner.localSlot, { kind: 'bot' });
      this.broadcastRoster();
    } else if (this.state.role === 'guest') this.send({ type: 'release', from: this.state.me });
  }

  async leave(reason?: string) {
    if (this.state.role === 'none' && !this.transport) {
      if (reason) this.set({ status: reason });
      return;
    }
    this.send({ type: 'bye', from: this.state.me });
    for (const tm of [this.snapTimer, this.helloTimer, this.inputTimer]) if (tm) clearInterval(tm);
    this.snapTimer = this.helloTimer = this.inputTimer = null;
    this.unsubRunner?.();
    this.unsubRunner = null;
    if (this.state.role === 'host') {
      for (const rb of this.runner.sim?.robots ?? []) if (this.runner.driverOf(rb.id).kind === 'remote') this.runner.setDriver(rb.id, { kind: 'bot' });
    }
    const t = this.transport;
    this.transport = null;
    await t?.close();
    this.setup = null;
    this.frames = [];
    this.hud = null;
    this.lastSim = null;
    this.hostId = null;
    this.hostSeen = false;
    this.hostMissingSince = null;
    this.missingSince.clear();
    this.set({ role: 'none', room: null, transport: null, roster: {}, peers: [], status: reason ?? '', connecting: false });
  }
}

let teamSingleton: TeamSession | null = null;

/** App-wide session (bound to the UI's SimRunner on first use). */
export function bindTeam(runner: SimRunner): TeamSession {
  teamSingleton ??= new TeamSession(runner);
  return teamSingleton;
}

export const team = {
  get role(): TeamRole {
    return teamSingleton?.state.role ?? 'none';
  },
  claimSlot: (slot: string) => teamSingleton?.claimSlot(slot),
  releaseSlot: () => teamSingleton?.releaseSlot(),
  get session() {
    return teamSingleton;
  },
};

const EMPTY: TeamState = { role: 'none', room: null, me: '', name: '', transport: null, roster: {}, peers: [], status: '', error: null, connecting: false };

export function useTeam(): TeamState {
  return useSyncExternalStore(
    (l) => teamSingleton?.subscribe(l) ?? (() => {}),
    () => teamSingleton?.state ?? EMPTY,
  );
}
