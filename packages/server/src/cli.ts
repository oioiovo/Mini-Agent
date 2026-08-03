#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createMiniAgentServer } from "./server.js";

function loadDotEnv(): string | undefined {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      loadEnv({ path });
      return path;
    }
  }
  loadEnv();
  return undefined;
}

async function main() {
  const envPath = loadDotEnv();

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

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
  const autoApprove =
    process.env.MINI_AGENT_AUTO_APPROVE === "true" ||
    process.env.MINI_AGENT_AUTO_APPROVE === "1";

  const server = await createMiniAgentServer({ port });
  console.log(
    `Mini-Agent listening on http://${server.host === "0.0.0.0" ? "127.0.0.1" : server.host}:${server.port}`,
  );
  console.log("Health check: GET /healthz");
  if (envPath) console.log(`Loaded env: ${envPath}`);
  console.log(`LLM: model=${model} baseUrl=${baseUrl} apiKey=${hasApiKey ? "set" : "missing"}`);
  console.log(
    `Tools: workspace=${server.agent.workspaceRoot} autoApprove=${autoApprove} builtins=${server.agent
      .listTools()
      .map((t) => t.name)
      .join(",")}`,
  );

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
