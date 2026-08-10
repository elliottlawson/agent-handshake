import { defineConfig } from "vite";

export default defineConfig({
  base: "/agent-handshake/",
  build: { outDir: "dist", target: "es2022" },
  server: { port: 5199 },
});