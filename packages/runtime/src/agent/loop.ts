import { nanoid } from "nanoid";
import type {
  AgentEvent,
  ChatMessage,
  LlmClient,
  Logger,
  MemoryStore,
} from "../types.js";
import type { SessionStore } from "../session/memory-store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { consoleLogger, nowMs, toErrorMessage } from "../utils.js";

export interface AgentLoopOptions {
  llm: LlmClient;
  tools: ToolRegistry;
  sessions: SessionStore;
  memory?: MemoryStore;
  logger?: Logger;
  defaultModel: string;
  maxSteps?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

export interface RunInput {
  sessionId: string;
  message: string;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
  runId?: string;
}

export class AgentLoop {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly logger: Logger;
  private readonly defaultMaxSteps: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultSystemPrompt: string;

  constructor(private readonly options: AgentLoopOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.defaultMaxSteps = options.maxSteps ?? 8;
    this.defaultTimeoutMs = options.timeoutMs ?? 120_000;
    this.defaultSystemPrompt =
      options.systemPrompt ??
      "You are a helpful agent. Use tools when they improve accuracy.";
  }

  cancel(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    const runId = input.runId ?? nanoid();
    const sessionId = input.sessionId;
    const model = input.model || this.options.defaultModel;
    const maxSteps = input.maxSteps && input.maxSteps > 0 ? input.maxSteps : this.defaultMaxSteps;
    const timeoutMs =
      input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : this.defaultTimeoutMs;

    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const emitBase = { runId, sessionId };

    try {
      const session = await this.options.sessions.get(sessionId);
      if (!session) {
        yield {
          type: "run.error",
          ...emitBase,
          code: "session_not_found",
          message: `Session not found: ${sessionId}`,
          timestampMs: nowMs(),
        };
        return;
      }

      yield {
        type: "run.started",
        ...emitBase,
        model,
        timestampMs: nowMs(),
      };

      if (this.options.memory) {
        const hits = await this.options.memory.search(sessionId, input.message, 3);
        for (const hit of hits) {
          yield {
            type: "memory.hit",
            ...emitBase,
            memoryId: hit.id,
            content: hit.content,
            score: hit.score,
            timestampMs: nowMs(),
          };
        }
        await this.options.memory.summarizeIfNeeded(sessionId, 40);
      }

      const userMessage: ChatMessage = { role: "user", content: input.message };
      await this.options.sessions.appendMessages(sessionId, [userMessage]);
      await this.options.memory?.append(sessionId, [userMessage]);

      let steps = 0;
      let finalText = "";

      while (steps < maxSteps) {
        if (controller.signal.aborted) {
          throw new Error("Run cancelled or timed out");
        }

        steps += 1;
        const latest = await this.options.sessions.get(sessionId);
        if (!latest) throw new Error(`Session not found: ${sessionId}`);

        const systemPrompt = latest.systemPrompt || this.defaultSystemPrompt;
        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...latest.messages,
        ];

        const toolDefs = this.options.tools.list();
        const response = await this.options.llm.chat({
          model,
          messages,
          tools: toolDefs.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
          abortSignal: controller.signal,
        });

        const assistant = response.message;
        if (assistant.content) {
          yield {
            type: "message.delta",
            ...emitBase,
            text: assistant.content,
            timestampMs: nowMs(),
          };
          finalText = assistant.content;
        }

        await this.options.sessions.appendMessages(sessionId, [assistant]);
        await this.options.memory?.append(sessionId, [assistant]);

        const toolCalls = assistant.toolCalls ?? [];
        if (toolCalls.length === 0 || response.finishReason === "stop") {
          yield {
            type: "run.completed",
            ...emitBase,
            finalText,
            steps,
            timestampMs: nowMs(),
          };
          return;
        }

        const toolMessages: ChatMessage[] = [];
        for (const call of toolCalls) {
          yield {
            type: "tool.started",
            ...emitBase,
            toolCallId: call.id,
            toolName: call.name,
            argumentsJson: call.arguments,
            timestampMs: nowMs(),
          };

          const executed = await this.options.tools.execute(call.name, call.arguments, {
            sessionId,
            runId,
            abortSignal: controller.signal,
            logger: this.logger,
          });

          yield {
            type: "tool.completed",
            ...emitBase,
            toolCallId: call.id,
            toolName: call.name,
            resultJson: executed.resultJson,
            isError: executed.isError,
            timestampMs: nowMs(),
          };

          toolMessages.push({
            role: "tool",
            content: executed.resultJson,
            toolCallId: call.id,
            name: call.name,
          });
        }

        await this.options.sessions.appendMessages(sessionId, toolMessages);
        await this.options.memory?.append(sessionId, toolMessages);
      }

      yield {
        type: "run.completed",
        ...emitBase,
        finalText: finalText || "Reached max steps without a final answer.",
        steps,
        timestampMs: nowMs(),
      };
    } catch (err) {
      this.logger.error("Agent run failed", { runId, sessionId, error: toErrorMessage(err) });
      yield {
        type: "run.error",
        ...emitBase,
        code: controller.signal.aborted ? "cancelled" : "run_failed",
        message: toErrorMessage(err),
        timestampMs: nowMs(),
      };
    } finally {
      clearTimeout(timeout);
      this.activeRuns.delete(runId);
    }
  }
}
