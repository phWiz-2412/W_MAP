/**
 * Dev-only message relay between a phone page (role "phone") and display pages (role "display").
 * - Forwards phone messages to displays and stamps `relayReceivedAtMs` on valid JSON objects when a clock is provided.
 * - Echoes `{"type":"ping","id":...,"sentAtMs":...}` back to the requesting display as `{"type":"pong",...}` so the
 *   display can measure WebSocket round-trip time (RTT) in its own clock domain.
 */
export type RelayRole = "phone" | "display";

export interface RelaySocket {
  send(data: string): void;
}

export interface RelayOptions {
  /** Optional clock to stamp `relayReceivedAtMs` on forwarded JSON object payloads. */
  clock?: () => number;
}

export class Relay {
  private readonly phones = new Set<RelaySocket>();
  private readonly displays = new Set<RelaySocket>();
  private readonly clock: (() => number) | undefined;

  constructor(options: RelayOptions = {}) {
    this.clock = options.clock;
  }

  /** Register a client. Returns a function that removes it. */
  addClient(socket: RelaySocket, role: RelayRole): () => void {
    const set = role === "phone" ? this.phones : this.displays;
    set.add(socket);
    if (role === "display") this.safeSend(socket, this.presence());
    else this.broadcastPresence();
    return () => {
      set.delete(socket);
      if (role === "phone") this.broadcastPresence();
    };
  }

  /** Handle a message from a client. Phone messages are forwarded to displays; display pings are echoed back. */
  onMessage(role: RelayRole, raw: string, sender?: RelaySocket): void {
    if (role === "display") {
      if (sender) this.maybeReplyPong(sender, raw);
      return;
    }
    const payload = this.clock ? this.stampRelayTime(raw, this.clock()) : raw;
    this.displays.forEach((d) => this.safeSend(d, payload));
  }

  get phoneCount(): number {
    return this.phones.size;
  }

  private maybeReplyPong(sender: RelaySocket, raw: string): void {
    try {
      const parsed = JSON.parse(raw) as { type?: unknown; sentAtMs?: unknown };
      if (parsed && parsed.type === "ping" && typeof parsed.sentAtMs === "number") {
        this.safeSend(
          sender,
          JSON.stringify({
            type: "pong",
            sentAtMs: parsed.sentAtMs,
            relayAtMs: this.clock ? this.clock() : Date.now(),
          }),
        );
      }
    } catch {
      // Ignore non-JSON display messages
    }
  }

  private stampRelayTime(raw: string, nowMs: number): string {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.type === "gps") {
        parsed.relayReceivedAtMs = nowMs;
        return JSON.stringify(parsed);
      }
    } catch {
      // Forward non-JSON unchanged so downstream validation counts it as invalid
    }
    return raw;
  }

  private presence(): string {
    return JSON.stringify({ type: "presence", phones: this.phones.size });
  }

  private broadcastPresence(): void {
    const msg = this.presence();
    this.displays.forEach((d) => this.safeSend(d, msg));
  }

  private safeSend(socket: RelaySocket, data: string): void {
    try {
      socket.send(data);
    } catch {
      // A dead socket must not break delivery to others; it is removed on its close event.
    }
  }
}
