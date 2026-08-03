import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import type { LlmClient, Logger, ToolContext } from "../types.js";
import type { SessionStore } from "../session/memory-store.js";
import type { MemoryStore } from "../types.js";
import { ApprovalBroker } from "../tools/approval.js";
import { ToolPolicy } from "../tools/policy.js";
import { ToolRegistry, defineLocalTool, type RegisteredTool } from "../tools/registry.js";
import { nowMs, toErrorMessage } from "../utils.js";
import { AgentLoop } from "./loop.js";

export const DEFAULT_SUBAGENT_TOOLS = [
  "now",
  "calculator",
  "list_dir",
  "read_file",
  "todo_read",
  "todo_write",
] as const;

export interface SubagentOptions {
  /** Override default read-only allowlist. `run_subagent` is always excluded. */
  allowTools?: string[];
  maxSteps?: number;
  timeoutMs?: number;
}

interface DepthState {
  depth: number;
}

const depthStorage = new AsyncLocalStorage<DepthState>();

export function getSubagentDepth(): number {
  return depthStorage.getStore()?.depth ?? 0;
}

export interface SubagentRunnerDeps {
  llm: LlmClient;
  sessions: SessionStore;
  memory: MemoryStore;
  parentTools: ToolRegistry;
  logger: Logger;
  defaultModel: string;
  policy: ToolPolicy;
  options?: SubagentOptions;
}

export interface RunSubagentInput {
  prompt: string;
  description?: string;
  systemPrompt?: string;
  maxSteps?: number;
  parentCtx: ToolContext;
}

export interface RunSubagentResult {
  subagent_id: string;
  child_run_id: string;
  child_session_id: string;
  final_text: string;
  is_error: boolean;
}

function truncate(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function filterTools(parent: ToolRegistry, allow: Set<string>): ToolRegistry {
  const child = new ToolRegistry();
  for (const def of parent.list()) {
    if (!allow.has(def.name) || def.name === "run_subagent") continue;
    const full = parent.get(def.name);
    if (full) child.register(full);
  }
  return child;
}

export class SubagentRunner {
  private readonly allowTools: Set<string>;
  private readonly maxSteps: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: SubagentRunnerDeps) {
    const configured = deps.options?.allowTools ?? [...DEFAULT_SUBAGENT_TOOLS];
    this.allowTools = new Set(configured.filter((n) => n !== "run_subagent"));
    this.maxSteps = deps.options?.maxSteps ?? 6;
    this.timeoutMs = deps.options?.timeoutMs ?? 60_000;
  }

  createTool(): RegisteredTool {
    return defineLocalTool({
      name: "run_subagent",
      description:
        "Start a read-only subagent with an isolated session to handle a focused subtask. Progress streams as subagent.* events on the parent run.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task for the subagent" },
          description: { type: "string" },
          system_prompt: { type: "string" },
          max_steps: { type: "number" },
        },
        required: ["prompt"],
      },
      execute: async (args, ctx) => this.run({
        prompt: String(args.prompt ?? ""),
        description: args.description ? String(args.description) : undefined,
        systemPrompt: args.system_prompt ? String(args.system_prompt) : undefined,
        maxSteps: typeof args.max_steps === "number" ? args.max_steps : undefined,
        parentCtx: ctx,
      }),
    });
  }

  async run(input: RunSubagentInput): Promise<RunSubagentResult> {
    if (!input.prompt.trim()) throw new Error("prompt is required");
    if (getSubagentDepth() >= 1) {
      throw new Error("Nested run_subagent is not allowed (max depth 1)");
    }

    const subagentId = nanoid();
    const childTools = filterTools(this.deps.parentTools, this.allowTools);
    const childApprovals = new ApprovalBroker();
    const childPolicy = new ToolPolicy({ autoApprove: true });
    const childLoop = new AgentLoop({
      llm: this.deps.llm,
      tools: childTools,
      sessions: this.deps.sessions,
      memory: this.deps.memory,
      logger: this.deps.logger,
      defaultModel: this.deps.defaultModel,
      maxSteps: input.maxSteps ?? this.maxSteps,
      timeoutMs: this.timeoutMs,
      policy: childPolicy,
      approvals: childApprovals,
      systemPrompt:
        input.systemPrompt ??
        "You are a focused subagent. Complete the assigned task concisely using available tools.",
    });

    const childSession = await this.deps.sessions.create({
      metadata: {
        parent_session_id: input.parentCtx.sessionId,
        parent_run_id: input.parentCtx.runId,
        subagent_id: subagentId,
        ...(input.description ? { description: input.description } : {}),
      },
      systemPrompt: input.systemPrompt,
    });

    const parentEmit = input.parentCtx.emitEvent.bind(input.parentCtx);
    const baseParent = {
      runId: input.parentCtx.runId,
      sessionId: input.parentCtx.sessionId,
    };

    let childRunId = "";
    let finalText = "";
    let isError = false;

    const abortChild = () => {
      if (childRunId) childLoop.cancel(childRunId);
    };
    input.parentCtx.abortSignal.addEventListener("abort", abortChild, { once: true });

    try {
      await depthStorage.run({ depth: getSubagentDepth() + 1 }, async () => {
        for await (const event of childLoop.run({
          sessionId: childSession.id,
          message: input.prompt,
        })) {
          if (input.parentCtx.abortSignal.aborted) {
            abortChild();
            throw new Error("Parent run aborted");
          }

          if (!childRunId) childRunId = event.runId;

          if (event.type === "run.started") {
            parentEmit({
              type: "subagent.started",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              childSessionId: childSession.id,
              prompt: truncate(input.prompt),
              timestampMs: nowMs(),
            });
            continue;
          }

          if (event.type === "message.delta") {
            parentEmit({
              type: "subagent.progress",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              kind: "text_delta",
              text: event.text,
              timestampMs: nowMs(),
            });
            input.parentCtx.emitDelta(event.text);
            continue;
          }

          if (event.type === "tool.started") {
            parentEmit({
              type: "subagent.progress",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              kind: "tool_call",
              toolName: event.toolName,
              payloadJson: event.argumentsJson,
              timestampMs: nowMs(),
            });
            continue;
          }

          if (event.type === "tool.completed") {
            parentEmit({
              type: "subagent.progress",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              kind: "tool_result",
              toolName: event.toolName,
              payloadJson: event.resultJson,
              text: event.isError ? "error" : "ok",
              timestampMs: nowMs(),
            });
            continue;
          }

          if (event.type === "tool.result_delta") {
            parentEmit({
              type: "subagent.progress",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              kind: "tool_result_delta",
              toolName: event.toolName,
              text: event.chunk,
              timestampMs: nowMs(),
            });
            continue;
          }

          if (event.type === "run.completed") {
            finalText = event.finalText;
            parentEmit({
              type: "subagent.completed",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              finalText: event.finalText,
              isError: false,
              timestampMs: nowMs(),
            });
            continue;
          }

          if (event.type === "run.error") {
            isError = true;
            finalText = event.message;
            parentEmit({
              type: "subagent.progress",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              kind: "error",
              text: event.message,
              payloadJson: JSON.stringify({ code: event.code }),
              timestampMs: nowMs(),
            });
            parentEmit({
              type: "subagent.completed",
              ...baseParent,
              subagentId,
              childRunId: event.runId,
              finalText: event.message,
              isError: true,
              timestampMs: nowMs(),
            });
          }
        }
      });
    } finally {
      input.parentCtx.abortSignal.removeEventListener("abort", abortChild);
    }

    if (!childRunId) {
      throw new Error("Subagent produced no events");
    }

    return {
      subagent_id: subagentId,
      child_run_id: childRunId,
      child_session_id: childSession.id,
      final_text: finalText,
      is_error: isError,
    };
  }
}

export function mapSubagentError(err: unknown): RunSubagentResult {
  return {
    subagent_id: "",
    child_run_id: "",
    child_session_id: "",
    final_text: toErrorMessage(err),
    is_error: true,
  };
}
