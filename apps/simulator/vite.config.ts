import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "node:path";
import { relayPlugin } from "./relay/relayPlugin.ts";

// `--mode phone` serves over HTTPS (self-signed) because iPhone Safari only exposes
// geolocation on secure origins.
export default defineConfig(({ mode }) => ({
  plugins: [react(), relayPlugin(), ...(mode === "phone" ? [basicSsl()] : [])],
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, "index.html"), phone: resolve(import.meta.dirname, "phone.html") },
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

