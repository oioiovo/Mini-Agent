import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  createAgent,
  CronScheduler,
  loadCronConfigFile,
  SqliteCronJobStore,
  syncCronJobsFromConfig,
  type CreateAgentOptions,
  type CronJobStore,
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
  /** Path to cron.jobs.yaml/json. Missing file is ignored. */
  cronFile?: string;
  /** Override cron sqlite path (default: beside sessions under data dir). */
  cronSqlitePath?: string;
  /** Disable in-process cron scheduler. */
  enableCron?: boolean;
}

export interface MiniAgentServer {
  agent: MiniAgent;
  port: number;
  host: string;
  cronStore?: CronJobStore;
  cronScheduler?: CronScheduler;
  close(): Promise<void>;
}

function resolveSqlitePath(agentOptions?: CreateAgentOptions): string {
  if (agentOptions?.sqlitePath) return agentOptions.sqlitePath;
  const dataDir = process.env.MINI_AGENT_DATA_DIR ?? "./data";
  return join(dataDir, "sessions.sqlite");
}

function resolveCronSqlitePath(
  options: MiniAgentServerOptions,
  sessionSqlitePath: string,
): string {
  if (options.cronSqlitePath) return options.cronSqlitePath;
  return join(dirname(sessionSqlitePath), "cron.sqlite");
}

export async function createMiniAgentServer(
  options: MiniAgentServerOptions = {},
): Promise<MiniAgentServer> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.MINI_AGENT_PORT ?? 8787);
  const apiKey = options.apiKey ?? process.env.MINI_AGENT_API_KEY;

  let agent = options.agent;
  const sessionSqlitePath = resolveSqlitePath(options.agentOptions);
  if (!agent) {
    mkdirSync(dirname(sessionSqlitePath), { recursive: true });
    agent = await createAgent({
      sessionBackend: "sqlite",
      ...options.agentOptions,
      sqlitePath: sessionSqlitePath,
      includeBuiltinTools: options.enableBuiltinTools !== false,
      tools: options.agentOptions?.tools ?? [],
    });
  }

  const enableCron = options.enableCron !== false;
  let cronStore: CronJobStore | undefined;
  let cronScheduler: CronScheduler | undefined;

  if (enableCron) {
    const cronSqlitePath = resolveCronSqlitePath(options, sessionSqlitePath);
    mkdirSync(dirname(cronSqlitePath), { recursive: true });
    cronStore = new SqliteCronJobStore(cronSqlitePath);

    const cronFile =
      options.cronFile ??
      process.env.MINI_AGENT_CRON_FILE ??
      undefined;
    if (cronFile) {
      const jobs = loadCronConfigFile(cronFile);
      const { upserted, deleted } = syncCronJobsFromConfig(cronStore, jobs);
      if (upserted.length || deleted) {
        console.info(
          `Cron config ${cronFile}: upserted=${upserted.length} deletedFileJobs=${deleted}`,
        );
      }
    }

    cronScheduler = new CronScheduler({
      store: cronStore,
      agent,
      logger: {
        debug: (m, meta) => console.debug(m, meta ?? ""),
        info: (m, meta) => console.info(m, meta ?? ""),
        warn: (m, meta) => console.warn(m, meta ?? ""),
        error: (m, meta) => console.error(m, meta ?? ""),
      },
    });
  }

  const handler = connectNodeAdapter({
    routes: (router) => {
      registerAgentRoutes(router, agent!, {
        apiKey,
        cronStore,
      });
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

  cronScheduler?.start();

  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;

  return {
    agent,
    port: boundPort,
    host,
    cronStore,
    cronScheduler,
    async close() {
      await cronScheduler?.stop();
      cronStore?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await agent!.close();
    },
  };
}
