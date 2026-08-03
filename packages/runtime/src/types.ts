export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  source: "local" | "http" | "mcp";
  sideEffect?: boolean;
  requiresApproval?: boolean;
  /** Security risk classification used by ToolPolicy. */
  risk?: "read" | "write" | "network" | "exec";
}

export interface ToolContext {
  sessionId: string;
  runId: string;
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type AgentEvent =
  | { type: "run.started"; runId: string; sessionId: string; model: string; timestampMs: number }
  | { type: "message.delta"; runId: string; sessionId: string; text: string; timestampMs: number }
  | {
      type: "tool.started";
      runId: string;
      sessionId: string;
      toolCallId: string;
      toolName: string;
      argumentsJson: string;
      timestampMs: number;
    }
  | {
      type: "tool.completed";
      runId: string;
      sessionId: string;
      toolCallId: string;
      toolName: string;
      resultJson: string;
      isError: boolean;
      timestampMs: number;
    }
  | {
      type: "tool.approval_required";
      runId: string;
      sessionId: string;
      approvalId: string;
      toolCallId: string;
      toolName: string;
      argumentsJson: string;
      risk: "read" | "write" | "network" | "exec";
      reason: string;
      timestampMs: number;
    }
  | {
      type: "memory.hit";
      runId: string;
      sessionId: string;
      memoryId: string;
      content: string;
      score: number;
      timestampMs: number;
    }
  | {
      type: "run.completed";
      runId: string;
      sessionId: string;
      finalText: string;
      steps: number;
      timestampMs: number;
    }
  | {
      type: "run.error";
      runId: string;
      sessionId: string;
      code: string;
      message: string;
      timestampMs: number;
    };

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: LlmToolSpec[];
  abortSignal?: AbortSignal;
}

export interface LlmChatResponse {
  message: ChatMessage;
  finishReason: "stop" | "tool_calls" | "length" | "error";
}

export interface LlmClient {
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
}

export interface SessionRecord {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  metadata: Record<string, string>;
  systemPrompt: string;
  messages: ChatMessage[];
}

export interface MemoryHit {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, string>;
}

export interface MemoryStore {
  append(sessionId: string, messages: ChatMessage[]): Promise<void>;
  getHistory(sessionId: string): Promise<ChatMessage[]>;
  search(sessionId: string, query: string, limit?: number): Promise<MemoryHit[]>;
  summarizeIfNeeded(sessionId: string, maxMessages: number): Promise<void>;
  rememberLongTerm?(content: string, metadata?: Record<string, string>): Promise<string>;
}
