import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import checker from "vite-plugin-checker";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  server: {
    open: true,
  },
  plugins: [react(), hotReload, checker({ typescript: true }), rootDevPorts()],
});

// The Root client SDK finds the local dev host on ports 8080-8082 unless
// window.__rootDevConfig says otherwise. When server/.env moves the dev host
// (ROOT_DEV_WS_PORT etc.), tell the client too. Dev server only; production
// builds are untouched, and only the port lines are read from the file.
function rootDevPorts() {
  return {
    name: "root-dev-ports",
    apply: "serve" as const,
    transformIndexHtml() {
      let env = "";
      try {
        env = readFileSync(new URL("../server/.env", import.meta.url), "utf8");
      } catch {
        return [];
      }
      const port = (key: string) => {
        const m = new RegExp(`^${key}=(\\d+)\\s*$`, "m").exec(env);
        return m ? Number(m[1]) : undefined;
      };
      const config = {
        wsPort: port("ROOT_DEV_WS_PORT"),
        wsUpdatePort: port("ROOT_DEV_WS_UPDATE_PORT"),
        httpPort: port("ROOT_DEV_HTTP_PORT"),
      };
      return [
        {
          tag: "script",
          children: `window.__rootDevConfig = ${JSON.stringify(config)};`,
          injectTo: "head-prepend" as const,
        },
      ];
    },
  };
}

function hotReload() {
  return {
    name: "hotreload-hmr",
    enforce: "post",
    // HMR
    handleHotUpdate({ file, server }) {
      console.log(file);
      if (
        file.endsWith(".json") ||
        file.endsWith(".tsx") ||
        file.endsWith(".ts")
      ) {
        console.log("reloading...");

        server.ws.send({
          type: "full-reload",
          path: "*",
        });
      }
    },
  };
}
