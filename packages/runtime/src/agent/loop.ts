import { nanoid } from "nanoid";
import type {
  AgentEvent,
  ChatMessage,
  LlmClient,
  Logger,
  MemoryStore,
  ToolCall,
} from "../types.js";
import {
  reactiveCompact,
  runCompactPipeline,
} from "../context/compact.js";
import {
  isPromptTooLongError,
  resolveCompactOptions,
  type CompactOptions,
} from "../context/estimate.js";
import type { SessionStore } from "../session/memory-store.js";
import type { ApprovalBroker } from "../tools/approval.js";
import { AsyncEventQueue } from "../tools/event-queue.js";
import type { ToolPolicy, ToolPolicyResult } from "../tools/policy.js";
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
  toolTimeoutMs?: number;
  approvalTimeoutMs?: number;
  systemPrompt?: string;
  policy: ToolPolicy;
  approvals: ApprovalBroker;
  workspaceRoot?: string;
  compact?: CompactOptions;
}

export interface RunInput {
  sessionId: string;
  message: string;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
  runId?: string;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller.signal;
}

interface ToolCallOutcome {
  toolCallId: string;
  toolName: string;
  resultJson: string;
}

export class AgentLoop {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly logger: Logger;
  private readonly defaultMaxSteps: number;
  private readonly defaultTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly defaultSystemPrompt: string;
  private readonly workspaceRoot: string;
  private readonly compactOptions: CompactOptions;

  constructor(private readonly options: AgentLoopOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.defaultMaxSteps = options.maxSteps ?? 8;
    this.defaultTimeoutMs = options.timeoutMs ?? 120_000;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.defaultSystemPrompt =
      options.systemPrompt ??
      "You are a helpful agent. Use tools when they improve accuracy.";
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.compactOptions = options.compact ?? {};
  }

  cancel(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    this.options.approvals.cancelRun(runId);
    controller.abort();
    return true;
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): { ok: boolean; status: string } {
    return this.options.approvals.resolve(runId, approvalId, decision);
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
      }

      const userMessage: ChatMessage = { role: "user", content: input.message };
      await this.options.sessions.appendMessages(sessionId, [userMessage]);
      await this.options.memory?.append(sessionId, [userMessage]);

      let steps = 0;
      let finalText = "";
      let llmCompactFailures = 0;
      const compactOpts = resolveCompactOptions(this.compactOptions);

      while (steps < maxSteps) {
        if (controller.signal.aborted) {
          throw new Error("Run cancelled or timed out");
        }

        steps += 1;
        let latest = await this.options.sessions.get(sessionId);
        if (!latest) throw new Error(`Session not found: ${sessionId}`);

        if (compactOpts.enabled) {
          try {
            const compacted = await runCompactPipeline({
              messages: latest.messages,
              sessionId,
              workspaceRoot: this.workspaceRoot,
              options: this.compactOptions,
              llm: this.options.llm,
              model,
              abortSignal: controller.signal,
              llmFailureCount: llmCompactFailures,
            });
            if (compacted.layers.length > 0) {
              await this.options.sessions.replaceMessages(sessionId, compacted.messages);
              for (const layer of compacted.layers) {
                yield {
                  type: "context.compacted",
                  ...emitBase,
                  layer,
                  tokensBefore: compacted.tokensBefore,
                  tokensAfter: compacted.tokensAfter,
                  messagesBefore: compacted.messagesBefore,
                  messagesAfter: compacted.messagesAfter,
                  timestampMs: nowMs(),
                };
              }
              if (compacted.layers.includes("llm") || compacted.layers.includes("manual")) {
                llmCompactFailures = 0;
              }
              latest = await this.options.sessions.get(sessionId);
              if (!latest) throw new Error(`Session not found: ${sessionId}`);
            }
          } catch (err) {
            // Cheap layers shouldn't throw often; L4 failures trip the breaker.
            llmCompactFailures += 1;
            this.logger.warn("context compact failed", {
              runId,
              sessionId,
              error: toErrorMessage(err),
              llmCompactFailures,
            });
          }
        }

        if (!latest) throw new Error(`Session not found: ${sessionId}`);
        const systemPrompt = latest.systemPrompt || this.defaultSystemPrompt;
        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...latest.messages,
        ];

        const toolDefs = this.options.tools.list();
        let response;
        let reactiveRetries = 0;
        for (;;) {
          try {
            response = await this.options.llm.chat({
              model,
              messages,
              tools: toolDefs.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
              abortSignal: controller.signal,
            });
            break;
          } catch (err) {
            if (
              !isPromptTooLongError(err) ||
              reactiveRetries >= compactOpts.maxReactiveRetries
            ) {
              // Track L4 failures separately only when compact_history itself failed;
              // prompt-too-long after cheap layers still gets reactive below.
              throw err;
            }
            reactiveRetries += 1;
            const reactive = await reactiveCompact(latest!.messages, {
              llm: this.options.llm,
              model,
              workspaceRoot: this.workspaceRoot,
              sessionId,
              abortSignal: controller.signal,
            });
            await this.options.sessions.replaceMessages(sessionId, reactive.messages);
            for (const layer of reactive.layers) {
              yield {
                type: "context.compacted",
                ...emitBase,
                layer,
                tokensBefore: reactive.tokensBefore,
                tokensAfter: reactive.tokensAfter,
                messagesBefore: reactive.messagesBefore,
                messagesAfter: reactive.messagesAfter,
                timestampMs: nowMs(),
              };
            }
            latest = (await this.options.sessions.get(sessionId))!;
            messages.length = 0;
            messages.push(
              { role: "system", content: systemPrompt },
              ...latest.messages,
            );
          }
        }

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

        const outcomes = new Map<string, ToolCallOutcome>();
        const parallel: ToolCall[] = [];
        const serial: ToolCall[] = [];

        for (const call of toolCalls) {
          const tool = this.options.tools.get(call.name);
          const policy = this.options.policy.evaluate({
            name: call.name,
            risk: tool?.risk,
            requiresApproval: tool?.requiresApproval,
            sideEffect: tool?.sideEffect,
            source: tool?.source,
            argumentsJson: call.arguments,
          });
          if (policy.decision === "allow" && policy.risk === "read") {
            parallel.push(call);
          } else {
            serial.push(call);
          }
        }

        if (parallel.length > 0) {
          const queue = new AsyncEventQueue<AgentEvent>();
          const workers = parallel.map((call) =>
            this.executeToolCall({
              call,
              emitBase,
              runId,
              sessionId,
              abortSignal: controller.signal,
              push: (event) => queue.push(event),
              onOutcome: (outcome) => outcomes.set(outcome.toolCallId, outcome),
            }).catch((err) => {
              const resultJson = JSON.stringify({ error: toErrorMessage(err) });
              queue.push({
                type: "tool.completed",
                ...emitBase,
                toolCallId: call.id,
                toolName: call.name,
                resultJson,
                isError: true,
                timestampMs: nowMs(),
              });
              outcomes.set(call.id, {
                toolCallId: call.id,
                toolName: call.name,
                resultJson,
              });
            }),
          );

          const allDone = Promise.all(workers).finally(() => queue.close());
          for await (const event of queue) {
            yield event;
          }
          await allDone;
        }

        for (const call of serial) {
          const queue = new AsyncEventQueue<AgentEvent>();
          const worker = this.executeToolCall({
            call,
            emitBase,
            runId,
            sessionId,
            abortSignal: controller.signal,
            push: (event) => queue.push(event),
            onOutcome: (outcome) => outcomes.set(outcome.toolCallId, outcome),
          }).finally(() => queue.close());

          for await (const event of queue) {
            yield event;
          }
          await worker;
        }

        const toolMessages: ChatMessage[] = toolCalls.map((call) => {
          const outcome = outcomes.get(call.id);
          return {
            role: "tool" as const,
            content: outcome?.resultJson ?? JSON.stringify({ error: "Missing tool result" }),
            toolCallId: call.id,
            name: call.name,
          };
        });

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
      this.options.approvals.cancelRun(runId);
      this.activeRuns.delete(runId);
    }
  }

  /** Manually compact a session (RPC / compact tool). */
  async compactSession(input: {
    sessionId: string;
    forceLlm?: boolean;
    model?: string;
    abortSignal?: AbortSignal;
  }) {
    const session = await this.options.sessions.get(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    const result = await runCompactPipeline({
      messages: session.messages,
      sessionId: input.sessionId,
      workspaceRoot: this.workspaceRoot,
      options: this.compactOptions,
      llm: this.options.llm,
      model: input.model || this.options.defaultModel,
      abortSignal: input.abortSignal,
      forceLlm: input.forceLlm ?? true,
    });
    if (result.layers.length > 0 || result.messages !== session.messages) {
      await this.options.sessions.replaceMessages(input.sessionId, result.messages);
    }
    return result;
  }

  private async executeToolCall(input: {
    call: ToolCall;
    emitBase: { runId: string; sessionId: string };
    runId: string;
    sessionId: string;
    abortSignal: AbortSignal;
    push: (event: AgentEvent) => void;
    onOutcome: (outcome: ToolCallOutcome) => void;
  }): Promise<void> {
    const { call, emitBase, runId, sessionId, abortSignal, push, onOutcome } = input;
    const tool = this.options.tools.get(call.name);
    const policy: ToolPolicyResult = this.options.policy.evaluate({
      name: call.name,
      risk: tool?.risk,
      requiresApproval: tool?.requiresApproval,
      sideEffect: tool?.sideEffect,
      source: tool?.source,
      argumentsJson: call.arguments,
    });

    let allowed = policy.decision === "allow";

    if (policy.decision === "deny") {
      const resultJson = JSON.stringify({ error: policy.reason });
      push({
        type: "tool.completed",
        ...emitBase,
        toolCallId: call.id,
        toolName: call.name,
        resultJson,
        isError: true,
        timestampMs: nowMs(),
      });
      this.logger.info("tool denied", {
        runId,
        sessionId,
        tool_name: call.name,
        risk: policy.risk,
        decision: "deny",
      });
      onOutcome({ toolCallId: call.id, toolName: call.name, resultJson });
      return;
    }

    if (policy.decision === "require_approval") {
      const approvalId = nanoid();
      const decisionPromise = this.options.approvals.begin(
        runId,
        approvalId,
        this.approvalTimeoutMs,
      );
      push({
        type: "tool.approval_required",
        ...emitBase,
        approvalId,
        toolCallId: call.id,
        toolName: call.name,
        argumentsJson: call.arguments,
        risk: policy.risk,
        reason: policy.reason,
        timestampMs: nowMs(),
      });

      const decision = await decisionPromise;
      if (decision !== "approve") {
        const resultJson = JSON.stringify({
          error:
            decision === "timeout"
              ? "Tool approval timed out"
              : "Tool approval denied",
        });
        push({
          type: "tool.completed",
          ...emitBase,
          toolCallId: call.id,
          toolName: call.name,
          resultJson,
          isError: true,
          timestampMs: nowMs(),
        });
        this.logger.info("tool approval rejected", {
          runId,
          sessionId,
          tool_name: call.name,
          risk: policy.risk,
          decision,
        });
        onOutcome({ toolCallId: call.id, toolName: call.name, resultJson });
        return;
      }
      allowed = true;
    }

    if (!allowed) return;

    push({
      type: "tool.started",
      ...emitBase,
      toolCallId: call.id,
      toolName: call.name,
      argumentsJson: call.arguments,
      timestampMs: nowMs(),
    });

    let sequence = 0;
    const startedAt = nowMs();
    const toolTimeoutMs =
      call.name === "run_subagent"
        ? Math.max(this.toolTimeoutMs, 120_000)
        : this.toolTimeoutMs;
    const toolTimeout = AbortSignal.timeout(toolTimeoutMs);
    const executed = await this.options.tools.execute(call.name, call.arguments, {
      sessionId,
      runId,
      abortSignal: combineSignals([abortSignal, toolTimeout]),
      logger: this.logger,
      emitDelta: (chunk: string) => {
        push({
          type: "tool.result_delta",
          ...emitBase,
          toolCallId: call.id,
          toolName: call.name,
          chunk,
          sequence: sequence++,
          timestampMs: nowMs(),
        });
      },
      emitEvent: (event: AgentEvent) => {
        push(event);
      },
    });
    const durationMs = nowMs() - startedAt;

    push({
      type: "tool.completed",
      ...emitBase,
      toolCallId: call.id,
      toolName: call.name,
      resultJson: executed.resultJson,
      isError: executed.isError,
      timestampMs: nowMs(),
    });

    this.logger.info("tool executed", {
      runId,
      sessionId,
      tool_name: call.name,
      risk: policy.risk,
      decision: "allow",
      duration_ms: durationMs,
      is_error: executed.isError,
    });

    onOutcome({
      toolCallId: call.id,
      toolName: call.name,
      resultJson: executed.resultJson,
    });
  }
}
