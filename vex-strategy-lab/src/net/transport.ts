import type { Msg, PeerInfo } from './protocol';
import { SUPABASE } from './config';

/**
 * A room's message bus with presence. Two implementations:
 *  - SupabaseTransport: Supabase Realtime broadcast + presence (play across the internet)
 *  - LocalTransport: BroadcastChannel between tabs of the same browser (no account,
 *    no network; also used by the tests)
 */
export interface Transport {
  readonly kind: 'online' | 'local';
  connect(room: string, me: PeerInfo): Promise<void>;
  send(msg: Msg): void;
  onMessage(cb: (msg: Msg) => void): void;
  onPresence(cb: (peers: PeerInfo[]) => void): void;
  close(): Promise<void>;
}

const CHANNEL = (room: string) => `vex-strategy-lab:${room}`;

export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  private ch: BroadcastChannel | null = null;
  private msgCb: ((m: Msg) => void) | null = null;
  private presCb: ((p: PeerInfo[]) => void) | null = null;
  private peers = new Map<string, { info: PeerInfo; seen: number }>();
  private me: PeerInfo | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  async connect(room: string, me: PeerInfo) {
    this.me = me;
    this.ch = new BroadcastChannel(CHANNEL(room));
    this.ch.onmessage = (e: MessageEvent) => {
      const d = e.data as { kind: 'msg'; msg: Msg } | { kind: 'here'; peer: PeerInfo } | { kind: 'gone'; peerId: string };
      if (d.kind === 'msg') this.msgCb?.(d.msg);
      else if (d.kind === 'here') {
        const isNew = !this.peers.has(d.peer.peerId);
        this.peers.set(d.peer.peerId, { info: d.peer, seen: Date.now() });
        if (isNew) {
          this.ch?.postMessage({ kind: 'here', peer: this.me });
          this.emitPresence();
        }
      } else if (d.kind === 'gone') {
        this.peers.delete(d.peerId);
        this.emitPresence();
      }
    };
    this.peers.set(me.peerId, { info: me, seen: Date.now() });
    this.ch.postMessage({ kind: 'here', peer: me });
    this.timer = setInterval(() => {
      this.ch?.postMessage({ kind: 'here', peer: this.me });
      const now = Date.now();
      let changed = false;
      for (const [id, p] of this.peers) {
        // generous: a tab whose main thread is busy (bot replanning, slow GPU) still counts as present
        if (id !== this.me!.peerId && now - p.seen > 10000) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this.emitPresence();
    }, 1000);
    this.emitPresence();
  }

  private emitPresence() {
    this.presCb?.([...this.peers.values()].map((p) => p.info));
  }

  send(msg: Msg) {
    this.ch?.postMessage({ kind: 'msg', msg });
  }

  onMessage(cb: (m: Msg) => void) {
    this.msgCb = cb;
  }

  onPresence(cb: (p: PeerInfo[]) => void) {
    this.presCb = cb;
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.me) this.ch?.postMessage({ kind: 'gone', peerId: this.me.peerId });
    this.ch?.close();
    this.ch = null;
  }
}

export class SupabaseTransport implements Transport {
  readonly kind = 'online' as const;
  // typed loosely so the Supabase client stays a lazily loaded chunk
  private client: { removeChannel(c: unknown): Promise<unknown> } | null = null;
  private channel: {
    send(m: unknown): Promise<unknown>;
    presenceState(): Record<string, PeerInfo[]>;
    track(p: PeerInfo): Promise<unknown>;
    unsubscribe(): Promise<unknown>;
  } | null = null;
  private msgCb: ((m: Msg) => void) | null = null;
  private presCb: ((p: PeerInfo[]) => void) | null = null;

  async connect(room: string, me: PeerInfo) {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(SUPABASE.url, SUPABASE.key, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 20 } } });
    this.client = client as unknown as typeof this.client;
    const ch = client.channel(CHANNEL(room), { config: { broadcast: { self: false, ack: false }, presence: { key: me.peerId } } });
    ch.on('broadcast', { event: 'm' }, ({ payload }) => this.msgCb?.(payload as Msg));
    ch.on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState() as unknown as Record<string, PeerInfo[]>;
      this.presCb?.(Object.values(st).map((arr) => arr[0]).filter(Boolean));
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to Supabase Realtime')), 12000);
      ch.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          await ch.track(me);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timeout);
          reject(new Error(`Supabase Realtime: ${status}`));
        }
      });
    });
    this.channel = ch as unknown as typeof this.channel;
  }

  send(msg: Msg) {
    void this.channel?.send({ type: 'broadcast', event: 'm', payload: msg });
  }

  onMessage(cb: (m: Msg) => void) {
    this.msgCb = cb;
  }

  onPresence(cb: (p: PeerInfo[]) => void) {
    this.presCb = cb;
  }

  async close() {
    if (this.channel) {
      await this.channel.unsubscribe();
      await this.client?.removeChannel(this.channel);
    }
    this.channel = null;
  }
}
