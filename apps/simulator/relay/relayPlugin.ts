import type { Server } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { Relay, type RelayRole } from "./relay.ts";

/**
 * Adds a WebSocket endpoint at /ws to the Vite dev/preview server so a phone page and the
 * display page on the same origin (same HTTPS certificate) can exchange live GPS messages.
 * LAN only; nothing leaves your network.
 */
export function relayPlugin(): Plugin {
  const attach = (server: ViteDevServer | PreviewServer) => {
    const http = server.httpServer as Server | null;
    if (!http) return;
    const relay = new Relay({ clock: () => Date.now() });
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") return; // leave Vite HMR upgrades alone
      if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") {
        socket.setNoDelay(true); // disable Nagle's algorithm for low-latency small GPS frames
      }
      const role: RelayRole = url.searchParams.get("role") === "phone" ? "phone" : "display";
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const client = { send: (d: string) => ws.send(d) };
        const remove = relay.addClient(client, role);
        ws.on("message", (data) => relay.onMessage(role, data.toString(), client));
        ws.on("close", remove);
        ws.on("error", remove);
      });
    });
  };
  return {
    name: "wmap-relay",
    configureServer: (server) => attach(server),
    configurePreviewServer: (server) => attach(server),
  };
}
