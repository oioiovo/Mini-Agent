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
  ResolveToolApprovalRequestSchema,
  UpsertMcpServerRequestSchema,
  UpsertCronJobRequestSchema,
  GetCronJobRequestSchema,
  ListCronJobsRequestSchema,
  DeleteCronJobRequestSchema,
  SetCronJobEnabledRequestSchema,
  CompactSessionRequestSchema,
  type AgentEvent,
  type CronJob,
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

  async resolveToolApproval(input: {
    runId: string;
    approvalId: string;
    decision: "approve" | "deny";
    note?: string;
  }): Promise<{ ok: boolean; status: string }> {
    const res = await this.client.resolveToolApproval(
      create(ResolveToolApprovalRequestSchema, {
        runId: input.runId,
        approvalId: input.approvalId,
        decision: input.decision,
        note: input.note ?? "",
      }),
    );
    return { ok: res.ok, status: res.status };
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

  async upsertCronJob(input: {
    id?: string;
    cron: string;
    message: string;
    timezone?: string;
    systemPrompt?: string;
    sessionMode?: "sticky" | "ephemeral";
    sessionId?: string;
    model?: string;
    maxSteps?: number;
    timeoutMs?: number;
    enabled?: boolean;
    autoApprove?: boolean;
    overlap?: "skip";
  }): Promise<CronJob> {
    const res = await this.client.upsertCronJob(
      create(UpsertCronJobRequestSchema, {
        id: input.id ?? "",
        cron: input.cron,
        timezone: input.timezone ?? "",
        message: input.message,
        systemPrompt: input.systemPrompt ?? "",
        sessionMode: input.sessionMode ?? "",
        sessionId: input.sessionId ?? "",
        model: input.model ?? "",
        maxSteps: input.maxSteps ?? 0,
        timeoutMs: input.timeoutMs ?? 0,
        enabled: input.enabled,
        autoApprove: input.autoApprove,
        overlap: input.overlap ?? "",
      }),
    );
    if (!res.job) throw new Error("UpsertCronJob returned empty job");
    return res.job;
  }

  async getCronJob(id: string): Promise<CronJob> {
    const res = await this.client.getCronJob(
      create(GetCronJobRequestSchema, { id }),
    );
    if (!res.job) throw new Error("GetCronJob returned empty job");
    return res.job;
  }

  async listCronJobs(): Promise<CronJob[]> {
    const res = await this.client.listCronJobs(
      create(ListCronJobsRequestSchema, {}),
    );
    return res.jobs;
  }

  async deleteCronJob(id: string): Promise<boolean> {
    const res = await this.client.deleteCronJob(
      create(DeleteCronJobRequestSchema, { id }),
    );
    return res.deleted;
  }

  async setCronJobEnabled(id: string, enabled: boolean): Promise<CronJob> {
    const res = await this.client.setCronJobEnabled(
      create(SetCronJobEnabledRequestSchema, { id, enabled }),
    );
    if (!res.job) throw new Error("SetCronJobEnabled returned empty job");
    return res.job;
  }

  async compactSession(input: {
    sessionId: string;
    forceLlm?: boolean;
  }): Promise<{
    tokensBefore: number;
    tokensAfter: number;
    messagesBefore: number;
    messagesAfter: number;
    layers: string[];
    transcriptPath: string;
  }> {
    const res = await this.client.compactSession(
      create(CompactSessionRequestSchema, {
        sessionId: input.sessionId,
        forceLlm: input.forceLlm ?? true,
      }),
    );
    return {
      tokensBefore: res.tokensBefore,
      tokensAfter: res.tokensAfter,
      messagesBefore: res.messagesBefore,
      messagesAfter: res.messagesAfter,
      layers: res.layers,
      transcriptPath: res.transcriptPath,
    };
  }
}
