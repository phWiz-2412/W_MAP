/**
 * Dev-only message relay between a phone page (role "phone") and display pages (role "display").
 * - Tracks authoritative phone and display presence per relay instance.
 * - Forwards phone GPS messages to displays and stamps `relayReceivedAtMs` on valid JSON objects when a clock is provided.
 * - Echoes `{"type":"ping","sentAtMs":...}` back to the requesting client as `{"type":"pong",...}` with current presence counts.
 */
export type RelayRole = "phone" | "display";

export interface RelaySocket {
  send(data: string): void;
  close?(): void;
}

export interface RelayOptions {
  /** Optional clock to stamp `relayReceivedAtMs` on forwarded JSON object payloads. */
  clock?: () => number;
}

export type RelayUpgradeParseResult =
  | { ok: true; isRelayPath: true; role: RelayRole }
  | { ok: false; isRelayPath: boolean; reason: string };

/**
 * Validates a WebSocket upgrade request URL for `/ws?role=phone|display`.
 * Rejects missing or unknown roles rather than silently coercing them.
 */
export function parseRelayUpgradeRequest(rawUrl: string | undefined): RelayUpgradeParseResult {
  let url: URL;
  try {
    url = new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return { ok: false, isRelayPath: false, reason: "Malformed upgrade URL" };
  }
  if (url.pathname !== "/ws") {
    return { ok: false, isRelayPath: false, reason: "Not a relay WebSocket path" };
  }
  const roleParam = url.searchParams.get("role");
  if (roleParam === "phone" || roleParam === "display") {
    return { ok: true, isRelayPath: true, role: roleParam };
  }
  return {
    ok: false,
    isRelayPath: true,
    reason: `Invalid or missing role query parameter "${roleParam ?? ""}" (expected "phone" or "display")`,
  };
}

export class Relay {
  private readonly phones = new Set<RelaySocket>();
  private readonly displays = new Set<RelaySocket>();
  private readonly clock: (() => number) | undefined;
  private isShutDown = false;

  constructor(options: RelayOptions = {}) {
    this.clock = options.clock;
  }

  /** Register a client. Returns an idempotent function that removes only this specific socket instance. */
  addClient(socket: RelaySocket, role: RelayRole): () => void {
    if (this.isShutDown) {
      return () => undefined;
    }
    const set = role === "phone" ? this.phones : this.displays;
    const wasAlreadyPresent = set.has(socket);
    set.add(socket);

    if (role === "display") {
      // Late-joining display always receives authoritative current presence immediately
      this.safeSend(socket, this.presence());
      if (!wasAlreadyPresent) {
        this.broadcastToPhones();
      }
    } else if (!wasAlreadyPresent) {
      this.broadcastPresence();
      this.broadcastToPhones();
    } else {
      // Duplicate addClient for same phone socket: refresh its own view without inflating counts
      this.safeSend(socket, this.phonePresence());
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const didDelete = set.delete(socket);
      if (didDelete && !this.isShutDown) {
        if (role === "phone") {
          this.broadcastPresence();
        }
        this.broadcastToPhones();
      }
    };
  }

  /** Handle a message from a client. Phone messages are forwarded to displays; pings are echoed back. */
  onMessage(role: RelayRole, raw: string, sender?: RelaySocket): void {
    if (this.isShutDown) return;
    if (sender && this.maybeHandleControlMessage(sender, raw)) {
      return;
    }
    if (role === "display") {
      return;
    }
    const payload = this.clock ? this.stampRelayTime(raw, this.clock()) : raw;
    this.displays.forEach((d) => this.safeSend(d, payload));
  }

  get phoneCount(): number {
    return this.phones.size;
  }

  get displayCount(): number {
    return this.displays.size;
  }

  /** Cleanly close and remove all connected sockets when shutting down the server. */
  shutdown(): void {
    this.isShutDown = true;
    const all = [...this.phones, ...this.displays];
    this.phones.clear();
    this.displays.clear();
    for (const sock of all) {
      try {
        sock.close?.();
      } catch {
        // Ignore errors while closing sockets during shutdown
      }
    }
  }

  private maybeHandleControlMessage(sender: RelaySocket, raw: string): boolean {
    try {
      const parsed = JSON.parse(raw) as { type?: unknown; sentAtMs?: unknown } | null;
      if (!parsed || typeof parsed !== "object") return false;
      if (parsed.type === "ping" && typeof parsed.sentAtMs === "number") {
        this.safeSend(
          sender,
          JSON.stringify({
            type: "pong",
            sentAtMs: parsed.sentAtMs,
            relayAtMs: this.clock ? this.clock() : Date.now(),
            phones: this.phones.size,
            displays: this.displays.size,
          }),
        );
        return true;
      }
      if (parsed.type === "presence_request") {
        const isPhone = this.phones.has(sender);
        this.safeSend(sender, isPhone ? this.phonePresence() : this.presence());
        return true;
      }
    } catch {
      // Not a JSON control message
    }
    return false;
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

  private phonePresence(): string {
    return JSON.stringify({
      type: "presence",
      phones: this.phones.size,
      displays: this.displays.size,
    });
  }

  private broadcastPresence(): void {
    const msg = this.presence();
    this.displays.forEach((d) => this.safeSend(d, msg));
  }

  private broadcastToPhones(): void {
    const msg = this.phonePresence();
    this.phones.forEach((p) => this.safeSend(p, msg));
  }

  private safeSend(socket: RelaySocket, data: string): void {
    try {
      socket.send(data);
    } catch {
      // A dead socket must not break delivery to others; it is removed on its close event.
    }
  }
}
