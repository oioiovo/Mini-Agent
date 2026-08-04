import { AgentLoop, type AgentLoopOptions, type RunInput } from "./agent/loop.js";
import { SubagentRunner, type SubagentOptions } from "./agent/subagent.js";
import type { CompactStepResult } from "./context/compact.js";
import { createCompactTool } from "./context/compact-tool.js";
import type { CompactOptions } from "./context/estimate.js";
import { FileMemoryStore } from "./memory/file-store.js";
import { createMemoryTools } from "./memory/memory-tools.js";
import { InMemoryMemoryStore } from "./memory/store.js";
import type { MemoryStore } from "./types.js";
import { McpManager, type McpServerConfig } from "./mcp/manager.js";
import {
  OpenAICompatibleClient,
  type OpenAICompatibleConfig,
} from "./providers/openai-compatible.js";
import { InMemorySessionStore, type SessionStore } from "./session/memory-store.js";
import { SqliteSessionStore } from "./session/sqlite-store.js";
import { ApprovalBroker } from "./tools/approval.js";
import { createBuiltinTools } from "./tools/builtins.js";
import { ToolPolicy, type ToolPolicyOptions } from "./tools/policy.js";
import {
  ToolRegistry,
  defineHttpTool,
  defineLocalTool,
  type RegisteredTool,
} from "./tools/registry.js";
import { defaultWorkspaceRoot, ensureWorkspaceRoot } from "./tools/workspace.js";
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
  includeBuiltinTools?: boolean;
  workspaceRoot?: string;
  policy?: ToolPolicyOptions;
  subagent?: SubagentOptions;
  compact?: CompactOptions;
  mcp?: { servers?: McpServerConfig[] };
  memory?: {
    enabled?: boolean;
    root?: string;
    consolidateThreshold?: number;
    maxSelect?: number;
    autoExtract?: boolean;
    /** Escape hatch for tests; skips FileMemoryStore when set. */
    store?: MemoryStore;
  };
  sessions?: SessionStore;
  sessionBackend?: "memory" | "sqlite";
  sqlitePath?: string;
  logger?: Logger;
  maxSteps?: number;
  timeoutMs?: number;
  toolTimeoutMs?: number;
  approvalTimeoutMs?: number;
  systemPrompt?: string;
}

export interface MiniAgent {
  loop: AgentLoop;
  tools: ToolRegistry;
  sessions: SessionStore;
  memory: MemoryStore;
  durableMemory?: FileMemoryStore;
  mcp: McpManager;
  llm: LlmClient;
  approvals: ApprovalBroker;
  policy: ToolPolicy;
  workspaceRoot: string;
  defaultModel: string;
  createSession(input?: {
    metadata?: Record<string, string>;
    systemPrompt?: string;
  }): Promise<{
    id: string;
    createdAtMs: number;
    updatedAtMs: number;
    metadata: Record<string, string>;
    systemPrompt: string;
    messageCount: number;
  }>;
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
  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): { ok: boolean; status: string };
  compactSession(input: {
    sessionId: string;
    forceLlm?: boolean;
  }): Promise<CompactStepResult>;
  listTools(): ToolDefinition[];
  registerTool(tool: RegisteredTool): void;
  registerHttpTool(options: Parameters<typeof defineHttpTool>[0]): void;
  upsertMcpServer(config: McpServerConfig): Promise<number>;
  close(): Promise<void>;
}

export async function createAgent(options: CreateAgentOptions = {}): Promise<MiniAgent> {
  const logger = options.logger ?? consoleLogger;
  const workspaceRoot = ensureWorkspaceRoot(options.workspaceRoot ?? defaultWorkspaceRoot());
  const tools = new ToolRegistry();

  if (options.includeBuiltinTools) {
    for (const tool of createBuiltinTools({ workspaceRoot })) {
      tools.register(tool);
    }
  }

  for (const tool of options.tools ?? []) {
    tools.upsert(tool);
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

  const durableMemory =
    options.memory?.store != null
      ? undefined
      : new FileMemoryStore({
          enabled: options.memory?.enabled,
          root: options.memory?.root,
          workspaceRoot,
          consolidateThreshold: options.memory?.consolidateThreshold,
          maxSelect: options.memory?.maxSelect,
          autoExtract: options.memory?.autoExtract,
        });
  const memory = options.memory?.store ?? durableMemory ?? new InMemoryMemoryStore();
  const policy = new ToolPolicy(options.policy);
  const approvals = new ApprovalBroker();

  if (options.includeBuiltinTools && durableMemory) {
    for (const tool of createMemoryTools(durableMemory)) {
      tools.upsert(tool);
    }
  }

  const mcp = new McpManager(tools, logger);
  for (const server of options.mcp?.servers ?? []) {
    await mcp.upsert(server);
  }

  const loopOptions: AgentLoopOptions = {
    llm,
    tools,
    sessions,
    memory,
    durableMemory,
    logger,
    defaultModel,
    maxSteps: options.maxSteps,
    timeoutMs: options.timeoutMs,
    toolTimeoutMs: options.toolTimeoutMs,
    approvalTimeoutMs: options.approvalTimeoutMs,
    systemPrompt: options.systemPrompt,
    policy,
    approvals,
    workspaceRoot,
    compact: options.compact,
  };
  const loop = new AgentLoop(loopOptions);

  const subagentRunner = new SubagentRunner({
    llm,
    sessions,
    memory,
    parentTools: tools,
    logger,
    defaultModel,
    policy,
    options: options.subagent,
  });
  tools.upsert(subagentRunner.createTool());
  tools.upsert(createCompactTool(loop));

  return {
    loop,
    tools,
    sessions,
    memory,
    durableMemory,
    mcp,
    llm,
    approvals,
    policy,
    workspaceRoot,
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
    resolveApproval(runId, approvalId, decision) {
      return loop.resolveApproval(runId, approvalId, decision);
    },
    async compactSession(input) {
      return loop.compactSession(input);
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
      approvals.clearAll();
      await mcp.closeAll();
      if (sessions instanceof SqliteSessionStore) {
        sessions.close();
      }
    },
  };
}

export { defineLocalTool, defineHttpTool };
