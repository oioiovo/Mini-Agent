#!/usr/bin/env node
import { createMiniAgentServer } from "./server.js";

async function main() {
  const [, , command = "serve", ...rest] = process.argv;
  if (command !== "serve") {
    console.error(`Unknown command: ${command}`);
    console.error("Usage: mini-agent serve [--port 8787]");
    process.exit(1);
  }

  let port = Number(process.env.MINI_AGENT_PORT ?? 8787);
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--port" && rest[i + 1]) {
      port = Number(rest[i + 1]);
    }
  }

  const server = await createMiniAgentServer({ port });
  console.log(`Mini-Agent listening on http://${server.host === "0.0.0.0" ? "127.0.0.1" : server.host}:${server.port}`);
  console.log("Health check: GET /healthz");

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
