import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "node:path";
import { relayPlugin } from "./relay/relayPlugin.ts";

// `--mode phone` serves over HTTPS (self-signed) because iPhone Safari only exposes
// geolocation on secure origins.
// `strictPort: true` on port 5173 prevents starting a second Vite process on 5174 with a separate
// in-memory Relay while the PC browser is still connected to port 5173.
export default defineConfig(({ mode }) => ({
  plugins: [react(), relayPlugin(), ...(mode === "phone" ? [basicSsl()] : [])],
  server: {
    port: 5173,
    strictPort: true,
    host: mode === "phone" ? true : undefined,
  },
  preview: {
    port: 5173,
    strictPort: true,
    host: true,
  },
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, "index.html"), phone: resolve(import.meta.dirname, "phone.html"), ble: resolve(import.meta.dirname, "ble.html") },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    css: false,
  },
}));
