import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import {
  AgentService,
  CreateSessionRequestSchema,
  GetSessionRequestSchema,
  RunAgentRequestSchema,
  CancelRunRequestSchema,
  ListToolsRequestSchema,
  RegisterHttpToolRequestSchema,
  UpsertMcpServerRequestSchema,
  type AgentEvent,
  type Session,
  type ToolInfo,
} from "@mini-agent/shared";

export interface MiniAgentClientOptions {
  baseUrl: string;
  apiKey?: string;
  httpVersion?: "1.1" | "2";
}

export type ClientAgentEvent = AgentEvent;

export class MiniAgentClient {
  private readonly client: Client<typeof AgentService>;

  constructor(options: MiniAgentClientOptions) {
    const interceptors: Interceptor[] = [];
    if (options.apiKey) {
      interceptors.push((next) => async (req) => {
        req.header.set("x-api-key", options.apiKey!);
        return next(req);
      });
    }

    const transport = createConnectTransport({
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      httpVersion: options.httpVersion ?? "1.1",
      interceptors,
    });
    this.client = createClient(AgentService, transport);
  }

  async createSession(input: {
    metadata?: Record<string, string>;
    systemPrompt?: string;
  } = {}): Promise<Session> {
    const res = await this.client.createSession(
      create(CreateSessionRequestSchema, {
        metadata: input.metadata ?? {},
        systemPrompt: input.systemPrompt ?? "",
      }),
    );
    if (!res.session) throw new Error("CreateSession returned empty session");
    return res.session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const res = await this.client.getSession(
      create(GetSessionRequestSchema, { sessionId }),
    );
    if (!res.session) throw new Error("GetSession returned empty session");
    return res.session;
  }

  async *run(input: {
    sessionId: string;
    message: string;
    model?: string;
    maxSteps?: number;
    timeoutMs?: number;
  }): AsyncGenerator<ClientAgentEvent> {
    const stream = this.client.runAgent(
      create(RunAgentRequestSchema, {
        sessionId: input.sessionId,
        message: input.message,
        model: input.model ?? "",
        maxSteps: input.maxSteps ?? 0,
        timeoutMs: input.timeoutMs ?? 0,
      }),
    );
    for await (const event of stream) {
      yield event;
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const res = await this.client.cancelRun(
      create(CancelRunRequestSchema, { runId }),
    );
    return res.cancelled;
  }

  async listTools(): Promise<ToolInfo[]> {
    const res = await this.client.listTools(create(ListToolsRequestSchema, {}));
    return res.tools;
  }

  async registerHttpTool(input: {
    name: string;
    description: string;
    url: string;
    inputSchema?: Record<string, unknown>;
    headers?: Record<string, string>;
    sideEffect?: boolean;
    requiresApproval?: boolean;
  }): Promise<ToolInfo> {
    const res = await this.client.registerHttpTool(
      create(RegisterHttpToolRequestSchema, {
        name: input.name,
        description: input.description,
        url: input.url,
        inputSchemaJson: JSON.stringify(input.inputSchema ?? { type: "object", properties: {} }),
        headers: input.headers ?? {},
        sideEffect: input.sideEffect ?? true,
        requiresApproval: input.requiresApproval ?? false,
      }),
    );
    if (!res.tool) throw new Error("RegisterHttpTool returned empty tool");
    return res.tool;
  }

  async upsertMcpServer(input: {
    name: string;
    transport: "stdio" | "sse" | "http";
    endpoint: string;
    args?: string[];
    env?: Record<string, string>;
  }): Promise<{ name: string; toolCount: number }> {
    const res = await this.client.upsertMcpServer(
      create(UpsertMcpServerRequestSchema, {
        name: input.name,
        transport: input.transport,
        endpoint: input.endpoint,
        args: input.args ?? [],
        env: input.env ?? {},
      }),
    );
    return { name: res.name, toolCount: res.toolCount };
  }
}
