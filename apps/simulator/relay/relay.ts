/**
 * Dev-only message relay between a phone page (role "phone") and display pages (role "display").
 * It forwards phone messages unchanged and publishes presence; it validates nothing -
 * consumers validate (see LivePhoneProvider). Transport-agnostic so it can be unit tested.
 */
export type RelayRole = "phone" | "display";

export interface RelaySocket {
  send(data: string): void;
}

export class Relay {
  private readonly phones = new Set<RelaySocket>();
  private readonly displays = new Set<RelaySocket>();

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

  /** Handle a message from a client. Only phone messages are forwarded, to displays. */
  onMessage(role: RelayRole, raw: string): void {
    if (role !== "phone") return;
    this.displays.forEach((d) => this.safeSend(d, raw));
  }

  get phoneCount(): number {
    return this.phones.size;
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
