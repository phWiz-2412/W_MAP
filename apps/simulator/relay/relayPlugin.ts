import type { Server } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { Relay, type RelayRole } from "./relay";

/**
 * Adds a WebSocket endpoint at /ws to the Vite dev/preview server so a phone page and the
 * display page on the same origin (same HTTPS certificate) can exchange live GPS messages.
 * LAN only; nothing leaves your network.
 */
export function relayPlugin(): Plugin {
  const attach = (server: ViteDevServer | PreviewServer) => {
    const http = server.httpServer as Server | null;
    if (!http) return;
    const relay = new Relay();
    const wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") return; // leave Vite HMR upgrades alone
      const role: RelayRole = url.searchParams.get("role") === "phone" ? "phone" : "display";
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const remove = relay.addClient({ send: (d) => ws.send(d) }, role);
        ws.on("message", (data) => relay.onMessage(role, data.toString()));
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
