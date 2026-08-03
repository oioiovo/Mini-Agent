import type { ChatMessage, LlmChatRequest, LlmChatResponse, LlmClient } from "../types.js";
import { toErrorMessage } from "../utils.js";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

interface OpenAIMessage {
  role: string;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export class OpenAICompatibleClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly defaultModel: string;

  constructor(config: OpenAICompatibleConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.defaultModel = config.defaultModel ?? "gpt-4o-mini";
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const body = {
      model: request.model || this.defaultModel,
      messages: request.messages.map(toOpenAIMessage),
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: OpenAIMessage;
        finish_reason?: string;
      }>;
    };

    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error("LLM response missing choices");
    }

    const message = fromOpenAIMessage(choice.message);
    const finish = choice.finish_reason;
    const finishReason =
      finish === "tool_calls"
        ? "tool_calls"
        : finish === "length"
          ? "length"
          : "stop";

    return { message, finishReason };
  }
}

export class FakeLlmClient implements LlmClient {
  constructor(
    private readonly responder: (request: LlmChatRequest) => LlmChatResponse | Promise<LlmChatResponse>,
  ) {}

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    return Promise.resolve(this.responder(request));
  }
}

function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    };
  }
  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return {
    role: message.role,
    content: message.content,
    name: message.name,
  };
}

function fromOpenAIMessage(message: OpenAIMessage): ChatMessage {
  return {
    role: (message.role as ChatMessage["role"]) ?? "assistant",
    content: message.content ?? "",
    toolCallId: message.tool_call_id,
    name: message.name,
    toolCalls: message.tool_calls?.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  };
}

export function createErrorLlmResponse(err: unknown): LlmChatResponse {
  return {
    message: {
      role: "assistant",
      content: `LLM error: ${toErrorMessage(err)}`,
    },
    finishReason: "error",
  };
}
