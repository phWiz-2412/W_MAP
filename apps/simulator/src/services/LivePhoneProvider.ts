import {
  PROTOCOL_VERSION,
  buildLiveNavigationData,
  systemClock,
  validateGpsFix,
  type Clock,
  type LiveGpsState,
  type NavigationPacket,
} from "@w-map/navigation-core";
import type { NavigationDataProvider } from "./NavigationDataProvider";

/** Minimal WebSocket surface used here, so tests can inject a fake. */
export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface LivePhoneOptions {
  url: string;
  clock?: Clock;
  socketFactory?: SocketFactory;
  /** Re-emit period so freshness is re-evaluated even when no fix arrives. 0 disables. */
  heartbeatMs?: number;
  /** Reconnect delay. 0 disables (tests). */
  reconnectMs?: number;
}

/**
 * Real GPS from a phone page via the local WebSocket relay (WiFi/LAN). This is NOT Bluetooth.
 * Validates each fix; invalid fixes are counted and ignored.
 */
export class LivePhoneProvider implements NavigationDataProvider {
  readonly id = "live-phone-gps";
  readonly label = "LIVE phone GPS (WiFi relay, not BLE)";
  readonly isSimulated = false;

  private state: LiveGpsState = { fix: null, fixReceivedAtMs: null, linkConnected: false };
  private socketOpen = false;
  private phones = 0;
  private sequence = 0;
  private socket: SocketLike | null = null;
  private readonly listeners = new Set<(raw: string) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private readonly clock: Clock;
  private readonly factory: SocketFactory;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;
  invalidMessages = 0;

  constructor(private readonly options: LivePhoneOptions) {
    this.clock = options.clock ?? systemClock;
    this.factory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.reconnectMs = options.reconnectMs ?? 1500;
  }

  subscribe(listener: (rawMessage: string) => void): () => void {
    this.listeners.add(listener);
    if (this.socket === null) this.connect();
    if (this.heartbeat === null && this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.emit(), this.heartbeatMs);
    }
    listener(this.build());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.teardown();
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.teardown();
  }

  private connect(): void {
    const socket = this.factory(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.socketOpen = true;
      this.updateLink();
    };
    socket.onclose = () => {
      this.socketOpen = false;
      this.phones = 0;
      this.socket = null;
      this.updateLink();
      if (this.listeners.size > 0 && this.reconnectMs > 0) {
        this.reconnect = setTimeout(() => this.connect(), this.reconnectMs);
      }
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (ev) => this.handle(ev.data);
  }

  private handle(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      this.invalidMessages += 1;
      return;
    }
    const type = (parsed as { type?: unknown } | null)?.type;
    if (type === "presence") {
      const phones = (parsed as { phones?: unknown }).phones;
      this.phones = typeof phones === "number" && phones >= 0 ? phones : 0;
      this.updateLink();
      return;
    }
    const fix = validateGpsFix(parsed);
    if (!fix.ok) {
      this.invalidMessages += 1;
      return;
    }
    this.state = { ...this.state, fix: fix.value, fixReceivedAtMs: this.clock.nowMs() };
    this.emit();
  }

  private updateLink(): void {
    this.state = { ...this.state, linkConnected: this.socketOpen && this.phones > 0 };
    this.emit();
  }

  private emit(): void {
    const msg = this.build();
    this.listeners.forEach((l) => l(msg));
  }

  /** Re-emit the current state (what the heartbeat timer does); exposed so tests need no timers. */
  emitCurrentForTest(): void {
    this.emit();
  }

  private build(): string {
    this.sequence += 1;
    const packet: NavigationPacket = {
      version: PROTOCOL_VERSION,
      data: buildLiveNavigationData(this.state, this.clock.nowMs(), this.sequence),
    };
    return JSON.stringify(packet);
  }

  private teardown(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.reconnect !== null) clearTimeout(this.reconnect);
    this.reconnect = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.socketOpen = false;
  }
}
