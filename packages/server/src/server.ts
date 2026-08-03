import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  createAgent,
  type CreateAgentOptions,
  type MiniAgent,
} from "@mini-agent/runtime";
import { registerAgentRoutes } from "./routes.js";

export interface MiniAgentServerOptions {
  port?: number;
  host?: string;
  apiKey?: string;
  agent?: MiniAgent;
  agentOptions?: CreateAgentOptions;
  enableBuiltinTools?: boolean;
}

export interface MiniAgentServer {
  agent: MiniAgent;
  port: number;
  host: string;
  close(): Promise<void>;
}

function resolveSqlitePath(agentOptions?: CreateAgentOptions): string {
  if (agentOptions?.sqlitePath) return agentOptions.sqlitePath;
  const dataDir = process.env.MINI_AGENT_DATA_DIR ?? "./data";
  return join(dataDir, "sessions.sqlite");
}

export async function createMiniAgentServer(
  options: MiniAgentServerOptions = {},
): Promise<MiniAgentServer> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.MINI_AGENT_PORT ?? 8787);
  const apiKey = options.apiKey ?? process.env.MINI_AGENT_API_KEY;

  let agent = options.agent;
  if (!agent) {
    const sqlitePath = resolveSqlitePath(options.agentOptions);
    mkdirSync(dirname(sqlitePath), { recursive: true });
    agent = await createAgent({
      sessionBackend: "sqlite",
      ...options.agentOptions,
      sqlitePath,
      includeBuiltinTools: options.enableBuiltinTools !== false,
      tools: options.agentOptions?.tools ?? [],
    });
  }

  const handler = connectNodeAdapter({
    routes: (router) => {
      registerAgentRoutes(router, agent!, { apiKey });
    },
  });

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;

  return {
    agent,
    port: boundPort,
    host,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await agent!.close();
    },
  };
}
