import type { Server } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { Relay, parseRelayUpgradeRequest } from "./relay.ts";

/**
 * Adds a shared WebSocket endpoint at /ws to the Vite dev/preview server so a phone page and the
 * display page on the same server process exchange live GPS messages and presence.
 * LAN only; nothing leaves your network.
 */
export function relayPlugin(sharedRelay?: Relay): Plugin {
  const relay = sharedRelay ?? new Relay({ clock: () => Date.now() });
  const attachedServers = new WeakSet<Server>();

  const attach = (server: ViteDevServer | PreviewServer) => {
    const http = server.httpServer as Server | null;
    if (!http || attachedServers.has(http)) return;
    attachedServers.add(http);

    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const onUpgrade = (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
      const parsed = parseRelayUpgradeRequest(req.url);
      if (!parsed.isRelayPath) return; // leave Vite HMR upgrades alone
      if (!parsed.ok) {
        try {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        } catch {
          // ignore write error
        }
        socket.destroy();
        return;
      }

      if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") {
        socket.setNoDelay(true); // disable Nagle's algorithm for low-latency small GPS frames
      }
      const { role } = parsed;
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const client = {
          send: (d: string) => ws.send(d),
          close: () => ws.close(),
        };
        const remove = relay.addClient(client, role);
        ws.on("message", (data) => relay.onMessage(role, data.toString(), client));
        ws.on("close", remove);
        ws.on("error", remove);
      });
    };

    http.on("upgrade", onUpgrade);
    http.once("close", () => {
      http.off("upgrade", onUpgrade);
      relay.shutdown();
      wss.close();
    });
  };

  return {
    name: "wmap-relay",
    configureServer: (server) => attach(server),
    configurePreviewServer: (server) => attach(server),
  };
}
