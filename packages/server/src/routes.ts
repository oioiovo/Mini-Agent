import { Code, ConnectError, type ConnectRouter, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import type { AgentEvent as RuntimeEvent, MiniAgent } from "@mini-agent/runtime";
import {
  AgentEventSchema,
  AgentService,
  type AgentEvent,
  type CancelRunRequest,
  type CreateSessionRequest,
  type GetSessionRequest,
  type ListToolsRequest,
  type RegisterHttpToolRequest,
  type RunAgentRequest,
  type UpsertMcpServerRequest,
  SessionSchema,
  ToolInfoSchema,
} from "@mini-agent/shared";
import { MemoryRateLimiter } from "./rate-limit.js";

function requireApiKey(ctx: HandlerContext, expected?: string): void {
  if (!expected) return;
  const provided =
    ctx.requestHeader.get("x-api-key") ??
    ctx.requestHeader.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expected) {
    throw new ConnectError("unauthorized", Code.Unauthenticated);
  }
}

function clientKey(ctx: HandlerContext): string {
  return (
    ctx.requestHeader.get("x-api-key") ??
    ctx.requestHeader.get("x-forwarded-for") ??
    ctx.requestHeader.get("x-real-ip") ??
    "anonymous"
  );
}

function toProtoSession(session: {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  metadata: Record<string, string>;
  systemPrompt: string;
  messageCount: number;
}) {
  return create(SessionSchema, {
    id: session.id,
    createdAtMs: BigInt(session.createdAtMs),
    updatedAtMs: BigInt(session.updatedAtMs),
    metadata: session.metadata,
    systemPrompt: session.systemPrompt,
    messageCount: session.messageCount,
  });
}

function toProtoEvent(event: RuntimeEvent): AgentEvent {
  const base = {
    runId: event.runId,
    sessionId: event.sessionId,
    timestampMs: BigInt(event.timestampMs),
  };

  switch (event.type) {
    case "run.started":
      return create(AgentEventSchema, {
        ...base,
        payload: {
          case: "runStarted",
          value: { model: event.model },
        },
      });
    case "message.delta":
      return create(AgentEventSchema, {
        ...base,
        payload: {
          case: "textDelta",
          value: { text: event.text },
        },
      });
    case "tool.started":
      return create(AgentEventSchema, {
        ...base,
        payload: {
          case: "toolCall",
          value: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argumentsJson: event.argumentsJson,
          },
        },
      });
    case "tool.completed":
      return create(AgentEventSchema, {
        ...base,
        payload: {
          case: "toolResult",
          value: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            resultJson: event.resultJson,
            isError: event.isError,
          },
        },
      });
    case "memory.hit":
      return create(AgentEventSchema, {
        ...base,
        payload: {
          case: "memoryHit",
          value: {
            memoryId: event.memoryId,
            content: event.content,
            score: event.score,
          },
        },
      });
    case "run.completed":
      return create(AgentEventSchema, {
        ...base,
        payload: {
          case: "runCompleted",
          value: {
            finalText: event.finalText,
            steps: event.steps,
          },
        },
      });
    case "run.error":
      return create(AgentEventSchema, {
        ...base,
        payload: {
          case: "runError",
          value: {
            code: event.code,
            message: event.message,
          },
        },
      });
  }
}

export function registerAgentRoutes(
  router: ConnectRouter,
  agent: MiniAgent,
  options: { apiKey?: string; rateLimiter?: MemoryRateLimiter } = {},
): void {
  const rateLimiter = options.rateLimiter ?? new MemoryRateLimiter();

  const guard = (ctx: HandlerContext) => {
    requireApiKey(ctx, options.apiKey);
    if (!rateLimiter.allow(clientKey(ctx))) {
      throw new ConnectError("rate limit exceeded", Code.ResourceExhausted);
    }
  };

  router.service(AgentService, {
    async createSession(req: CreateSessionRequest, ctx) {
      guard(ctx);
      const session = await agent.createSession({
        metadata: req.metadata,
        systemPrompt: req.systemPrompt || undefined,
      });
      return { session: toProtoSession(session) };
    },

    async getSession(req: GetSessionRequest, ctx) {
      guard(ctx);
      const session = await agent.getSession(req.sessionId);
      if (!session) {
        throw new ConnectError(`Session not found: ${req.sessionId}`, Code.NotFound);
      }
      return { session: toProtoSession(session) };
    },

    async *runAgent(req: RunAgentRequest, ctx): AsyncIterable<AgentEvent> {
      guard(ctx);
      for await (const event of agent.run({
        sessionId: req.sessionId,
        message: req.message,
        model: req.model || undefined,
        maxSteps: req.maxSteps || undefined,
        timeoutMs: req.timeoutMs || undefined,
      })) {
        if (ctx.signal.aborted) break;
        yield toProtoEvent(event);
      }
    },

    async cancelRun(req: CancelRunRequest, ctx) {
      guard(ctx);
      return { cancelled: agent.cancel(req.runId) };
    },

    async listTools(_req: ListToolsRequest, ctx) {
      guard(ctx);
      return {
        tools: agent.listTools().map((tool) =>
          create(ToolInfoSchema, {
            name: tool.name,
            description: tool.description,
            inputSchemaJson: JSON.stringify(tool.inputSchema ?? {}),
            source: tool.source,
            sideEffect: tool.sideEffect ?? false,
            requiresApproval: tool.requiresApproval ?? false,
          }),
        ),
      };
    },

    async registerHttpTool(req: RegisterHttpToolRequest, ctx) {
      guard(ctx);
      let inputSchema: Record<string, unknown> = { type: "object", properties: {} };
      if (req.inputSchemaJson) {
        inputSchema = JSON.parse(req.inputSchemaJson) as Record<string, unknown>;
      }
      agent.registerHttpTool({
        name: req.name,
        description: req.description,
        inputSchema,
        url: req.url,
        headers: req.headers,
        sideEffect: req.sideEffect,
        requiresApproval: req.requiresApproval,
      });
      const tool = agent.listTools().find((t) => t.name === req.name);
      if (!tool) {
        throw new ConnectError("Failed to register tool", Code.Internal);
      }
      return {
        tool: create(ToolInfoSchema, {
          name: tool.name,
          description: tool.description,
          inputSchemaJson: JSON.stringify(tool.inputSchema ?? {}),
          source: tool.source,
          sideEffect: tool.sideEffect ?? false,
          requiresApproval: tool.requiresApproval ?? false,
        }),
      };
    },

    async upsertMcpServer(req: UpsertMcpServerRequest, ctx) {
      guard(ctx);
      const transport = req.transport as "stdio" | "sse" | "http";
      if (!["stdio", "sse", "http"].includes(transport)) {
        throw new ConnectError(`Unsupported MCP transport: ${req.transport}`, Code.InvalidArgument);
      }
      const toolCount = await agent.upsertMcpServer({
        name: req.name,
        transport,
        endpoint: req.endpoint,
        args: req.args,
        env: req.env,
      });
      return { name: req.name, toolCount };
    },
  });
}

/** Optional Connect interceptor form of API key checks for custom servers. */
export function apiKeyInterceptor(expected?: string): Interceptor {
  return (next) => async (req) => {
    if (!expected) return next(req);
    const provided =
      req.header.get("x-api-key") ??
      req.header.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== expected) {
      throw new ConnectError("unauthorized", Code.Unauthenticated);
    }
    return next(req);
  };
}
