import { AgentLoop, type AgentLoopOptions, type RunInput } from "./agent/loop.js";
import { InMemoryMemoryStore } from "./memory/store.js";
import type { MemoryStore } from "./types.js";
import { McpManager, type McpServerConfig } from "./mcp/manager.js";
import {
  OpenAICompatibleClient,
  type OpenAICompatibleConfig,
} from "./providers/openai-compatible.js";
import { InMemorySessionStore, type SessionStore } from "./session/memory-store.js";
import { SqliteSessionStore } from "./session/sqlite-store.js";
import {
  ToolRegistry,
  defineHttpTool,
  defineLocalTool,
  type RegisteredTool,
} from "./tools/registry.js";
import type { AgentEvent, LlmClient, Logger, ToolDefinition } from "./types.js";
import { consoleLogger } from "./utils.js";

export interface CreateAgentOptions {
  model?: {
    provider?: "openai" | "openai-compatible";
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  llm?: LlmClient;
  tools?: RegisteredTool[];
  mcp?: { servers?: McpServerConfig[] };
  memory?: {
    shortTerm?: "session" | "memory";
    longTerm?: "none" | "vector";
    store?: MemoryStore;
  };
  sessions?: SessionStore;
  sessionBackend?: "memory" | "sqlite";
  sqlitePath?: string;
  logger?: Logger;
  maxSteps?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

export interface MiniAgent {
  loop: AgentLoop;
  tools: ToolRegistry;
  sessions: SessionStore;
  memory: MemoryStore;
  mcp: McpManager;
  llm: LlmClient;
  defaultModel: string;
  createSession(input?: {
    metadata?: Record<string, string>;
    systemPrompt?: string;
  }): Promise<{ id: string; createdAtMs: number; updatedAtMs: number; metadata: Record<string, string>; systemPrompt: string; messageCount: number }>;
  getSession(sessionId: string): Promise<
    | {
        id: string;
        createdAtMs: number;
        updatedAtMs: number;
        metadata: Record<string, string>;
        systemPrompt: string;
        messageCount: number;
      }
    | undefined
  >;
  run(input: RunInput): AsyncGenerator<AgentEvent>;
  cancel(runId: string): boolean;
  listTools(): ToolDefinition[];
  registerTool(tool: RegisteredTool): void;
  registerHttpTool(options: Parameters<typeof defineHttpTool>[0]): void;
  upsertMcpServer(config: McpServerConfig): Promise<number>;
  close(): Promise<void>;
}

export async function createAgent(options: CreateAgentOptions = {}): Promise<MiniAgent> {
  const logger = options.logger ?? consoleLogger;
  const tools = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    tools.register(tool);
  }

  const defaultModel = options.model?.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const llm =
    options.llm ??
    new OpenAICompatibleClient({
      apiKey: options.model?.apiKey ?? process.env.OPENAI_API_KEY ?? "",
      baseUrl: options.model?.baseUrl ?? process.env.OPENAI_BASE_URL,
      defaultModel,
    } satisfies OpenAICompatibleConfig);

  const sessions =
    options.sessions ??
    (options.sessionBackend === "sqlite"
      ? new SqliteSessionStore(options.sqlitePath ?? "./data/sessions.sqlite")
      : new InMemorySessionStore());

  const memory =
    options.memory?.store ??
    new InMemoryMemoryStore();

  const mcp = new McpManager(tools, logger);
  for (const server of options.mcp?.servers ?? []) {
    await mcp.upsert(server);
  }

  const loopOptions: AgentLoopOptions = {
    llm,
    tools,
    sessions,
    memory,
    logger,
    defaultModel,
    maxSteps: options.maxSteps,
    timeoutMs: options.timeoutMs,
    systemPrompt: options.systemPrompt,
  };
  const loop = new AgentLoop(loopOptions);

  return {
    loop,
    tools,
    sessions,
    memory,
    mcp,
    llm,
    defaultModel,
    async createSession(input) {
      const session = await sessions.create(input ?? {});
      return {
        id: session.id,
        createdAtMs: session.createdAtMs,
        updatedAtMs: session.updatedAtMs,
        metadata: session.metadata,
        systemPrompt: session.systemPrompt,
        messageCount: session.messages.length,
      };
    },
    async getSession(sessionId) {
      const session = await sessions.get(sessionId);
      if (!session) return undefined;
      return {
        id: session.id,
        createdAtMs: session.createdAtMs,
        updatedAtMs: session.updatedAtMs,
        metadata: session.metadata,
        systemPrompt: session.systemPrompt,
        messageCount: session.messages.length,
      };
    },
    run(input) {
      return loop.run(input);
    },
    cancel(runId) {
      return loop.cancel(runId);
    },
    listTools() {
      return tools.list();
    },
    registerTool(tool) {
      tools.upsert(tool);
    },
    registerHttpTool(httpOptions) {
      tools.upsert(defineHttpTool(httpOptions));
    },
    async upsertMcpServer(config) {
      return mcp.upsert(config);
    },
    async close() {
      await mcp.closeAll();
      if (sessions instanceof SqliteSessionStore) {
        sessions.close();
      }
    },
  };
}

export { defineLocalTool, defineHttpTool };
