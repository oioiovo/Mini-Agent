import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, LlmClient } from "../types.js";
import { nowMs } from "../utils.js";
import {
  estimateTokens,
  resolveCompactOptions,
  type CompactLayer,
  type CompactOptions,
} from "./estimate.js";

export interface CompactStepResult {
  messages: ChatMessage[];
  layers: CompactLayer[];
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  transcriptPath?: string;
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    toolCalls: m.toolCalls ? m.toolCalls.map((c) => ({ ...c })) : undefined,
  }));
}

function messageHasToolUse(message: ChatMessage | undefined): boolean {
  return Boolean(message?.toolCalls && message.toolCalls.length > 0);
}

function isToolResultMessage(message: ChatMessage | undefined): boolean {
  return message?.role === "tool";
}

/** Advance index past any tool results following an assistant tool_use. */
function extendPastToolResults(messages: ChatMessage[], index: number): number {
  let i = index;
  while (i < messages.length && isToolResultMessage(messages[i])) {
    i += 1;
  }
  return i;
}

/** Move start left so we don't begin on an orphan tool_result. */
function protectTailStart(messages: ChatMessage[], tailStart: number): number {
  let start = tailStart;
  if (
    start > 0 &&
    isToolResultMessage(messages[start]) &&
    messageHasToolUse(messages[start - 1])
  ) {
    start -= 1;
  }
  return Math.max(0, start);
}

/**
 * L1: snip middle messages when over maxMessages.
 * Keep head + tail; never split assistant(tool_use) from following tool results.
 */
export function snipCompact(
  messages: ChatMessage[],
  options?: Pick<CompactOptions, "maxMessages" | "keepHeadMessages">,
): { messages: ChatMessage[]; changed: boolean; snipped: number } {
  const opts = resolveCompactOptions(options);
  if (messages.length <= opts.maxMessages) {
    return { messages, changed: false, snipped: 0 };
  }

  let headEnd = Math.min(opts.keepHeadMessages, messages.length);
  if (messageHasToolUse(messages[headEnd - 1])) {
    headEnd = extendPastToolResults(messages, headEnd);
  }

  const keepTail = opts.maxMessages - headEnd;
  let tailStart = Math.max(headEnd, messages.length - Math.max(keepTail, 0));
  tailStart = protectTailStart(messages, tailStart);

  if (tailStart <= headEnd) {
    return { messages, changed: false, snipped: 0 };
  }

  const snipped = tailStart - headEnd;
  const placeholder: ChatMessage = {
    role: "user",
    content: `[snipped ${snipped} messages from conversation middle]`,
  };
  return {
    messages: [...messages.slice(0, headEnd), placeholder, ...messages.slice(tailStart)],
    changed: true,
    snipped,
  };
}

/**
 * L2: replace older tool result contents with a short placeholder.
 * Keep the most recent N tool results intact.
 */
export function microCompact(
  messages: ChatMessage[],
  options?: Pick<CompactOptions, "keepRecentToolResults">,
): { messages: ChatMessage[]; changed: boolean; compacted: number } {
  const opts = resolveCompactOptions(options);
  const next = cloneMessages(messages);
  const toolIndexes: number[] = [];
  for (let i = 0; i < next.length; i += 1) {
    if (next[i]?.role === "tool") toolIndexes.push(i);
  }
  if (toolIndexes.length <= opts.keepRecentToolResults) {
    return { messages: next, changed: false, compacted: 0 };
  }

  const drop = toolIndexes.slice(0, toolIndexes.length - opts.keepRecentToolResults);
  let compacted = 0;
  for (const idx of drop) {
    const msg = next[idx]!;
    if ((msg.content?.length ?? 0) > 120) {
      msg.content = "[Earlier tool result compacted. Re-run if needed.]";
      compacted += 1;
    }
  }
  return { messages: next, changed: compacted > 0, compacted };
}

export interface ToolResultBudgetOptions {
  sessionId: string;
  workspaceRoot: string;
  maxToolResultBytes?: number;
  toolResultPreviewChars?: number;
}

/**
 * L3: persist oversized tool results under workspace and leave a short preview.
 * Operates across all tool messages (budget is global, largest first).
 */
export function toolResultBudget(
  messages: ChatMessage[],
  options: ToolResultBudgetOptions,
): { messages: ChatMessage[]; changed: boolean; persisted: number } {
  const opts = resolveCompactOptions({
    maxToolResultBytes: options.maxToolResultBytes,
    toolResultPreviewChars: options.toolResultPreviewChars,
  });
  const next = cloneMessages(messages);
  const toolEntries = next
    .map((msg, index) => ({ msg, index }))
    .filter((e) => e.msg.role === "tool");

  let total = toolEntries.reduce((sum, e) => sum + (e.msg.content?.length ?? 0), 0);
  if (total <= opts.maxToolResultBytes) {
    return { messages: next, changed: false, persisted: 0 };
  }

  const dir = join(
    options.workspaceRoot,
    ".mini-agent",
    "tool-results",
    options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"),
  );
  mkdirSync(dir, { recursive: true });

  const ranked = [...toolEntries].sort(
    (a, b) => (b.msg.content?.length ?? 0) - (a.msg.content?.length ?? 0),
  );
  let persisted = 0;
  for (const entry of ranked) {
    if (total <= opts.maxToolResultBytes) break;
    const content = entry.msg.content ?? "";
    if (content.length <= opts.toolResultPreviewChars) continue;
    const id = entry.msg.toolCallId || `idx-${entry.index}`;
    const fileName = `${id}.txt`;
    const absPath = join(dir, fileName);
    writeFileSync(absPath, content, "utf8");
    const preview = content.slice(0, opts.toolResultPreviewChars);
    const relative = join(".mini-agent", "tool-results", options.sessionId, fileName).replace(
      /\\/g,
      "/",
    );
    entry.msg.content =
      `<persisted-output path="${relative}">\n${preview}\n…[truncated; full output persisted to workspace]`;
    total = toolEntries.reduce((sum, e) => sum + (e.msg.content?.length ?? 0), 0);
    persisted += 1;
  }

  return { messages: next, changed: persisted > 0, persisted };
}

const SUMMARY_SYSTEM = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
You are compressing a conversation for an AI agent. Produce a concise summary that preserves:
1. Current user goal / task
2. Important findings and decisions
3. Files created or modified
4. Remaining work
5. User constraints / preferences
Prefer bullet points. Do not invent facts.`;

function formatHistoryForSummary(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const tools =
        m.toolCalls?.map((c) => `tool_call ${c.name}(${c.arguments})`).join("; ") ?? "";
      const head = `[${m.role}${m.name ? `:${m.name}` : ""}${m.toolCallId ? ` tool=${m.toolCallId}` : ""}]`;
      return `${head}\n${m.content}${tools ? `\n${tools}` : ""}`;
    })
    .join("\n\n")
    .slice(0, 120_000);
}

export function writeTranscript(
  messages: ChatMessage[],
  workspaceRoot: string,
  sessionId: string,
): string {
  const dir = join(workspaceRoot, ".mini-agent", "transcripts");
  mkdirSync(dir, { recursive: true });
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(dir, `${safeId}-${nowMs()}.jsonl`);
  const body = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  writeFileSync(path, body, "utf8");
  return path;
}

export async function compactHistoryWithLlm(
  messages: ChatMessage[],
  input: {
    llm: LlmClient;
    model: string;
    workspaceRoot: string;
    sessionId: string;
    abortSignal?: AbortSignal;
    keepTailGroups?: number;
    label?: string;
  },
): Promise<{ messages: ChatMessage[]; transcriptPath: string; summary: string }> {
  const transcriptPath = writeTranscript(messages, input.workspaceRoot, input.sessionId);
  const response = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      {
        role: "user",
        content: `Summarize this agent conversation for continued work:\n\n${formatHistoryForSummary(messages)}`,
      },
    ],
    abortSignal: input.abortSignal,
  });
  const summary = response.message.content?.trim() || "(empty summary)";
  const label = input.label ?? "Compacted";
  const compacted: ChatMessage = {
    role: "user",
    content: `[${label}]\n\n${summary}`,
  };

  const keepTail = input.keepTailGroups ?? 0;
  if (keepTail <= 0) {
    return { messages: [compacted], transcriptPath, summary };
  }

  let tailStart = Math.max(0, messages.length - keepTail);
  tailStart = protectTailStart(messages, tailStart);
  return {
    messages: [compacted, ...messages.slice(tailStart)],
    transcriptPath,
    summary,
  };
}

export interface RunCompactPipelineInput {
  messages: ChatMessage[];
  sessionId: string;
  workspaceRoot: string;
  options?: CompactOptions;
  llm?: LlmClient;
  model?: string;
  abortSignal?: AbortSignal;
  /** Force L4 even below threshold (manual / compact tool). */
  forceLlm?: boolean;
  /** Skip L4 (e.g. when circuit breaker open). */
  skipLlm?: boolean;
  llmFailureCount?: number;
}

/**
 * Cheap-first pipeline: budget → snip → micro → (optional) LLM compact.
 */
export async function runCompactPipeline(
  input: RunCompactPipelineInput,
): Promise<CompactStepResult> {
  const opts = resolveCompactOptions(input.options);
  const tokensBefore = estimateTokens(input.messages);
  const messagesBefore = input.messages.length;
  const layers: CompactLayer[] = [];
  let messages = cloneMessages(input.messages);

  if (!opts.enabled && !input.forceLlm) {
    return {
      messages,
      layers,
      tokensBefore,
      tokensAfter: tokensBefore,
      messagesBefore,
      messagesAfter: messagesBefore,
    };
  }

  const budget = toolResultBudget(messages, {
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    maxToolResultBytes: opts.maxToolResultBytes,
    toolResultPreviewChars: opts.toolResultPreviewChars,
  });
  messages = budget.messages;
  if (budget.changed) layers.push("budget");

  const snip = snipCompact(messages, {
    maxMessages: opts.maxMessages,
    keepHeadMessages: opts.keepHeadMessages,
  });
  messages = snip.messages;
  if (snip.changed) layers.push("snip");

  const micro = microCompact(messages, {
    keepRecentToolResults: opts.keepRecentToolResults,
  });
  messages = micro.messages;
  if (micro.changed) layers.push("micro");

  let transcriptPath: string | undefined;
  const shouldLlm =
    input.forceLlm ||
    (!input.skipLlm &&
      input.llm &&
      input.model &&
      (input.llmFailureCount ?? 0) < opts.maxConsecutiveLlmFailures &&
      estimateTokens(messages) > opts.autoCompactThreshold);

  if (shouldLlm && input.llm && input.model) {
    const result = await compactHistoryWithLlm(messages, {
      llm: input.llm,
      model: input.model,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      abortSignal: input.abortSignal,
      label: input.forceLlm ? "Compacted" : "auto compact",
    });
    messages = result.messages;
    transcriptPath = result.transcriptPath;
    layers.push(input.forceLlm ? "manual" : "llm");
  }

  return {
    messages,
    layers,
    tokensBefore,
    tokensAfter: estimateTokens(messages),
    messagesBefore,
    messagesAfter: messages.length,
    transcriptPath,
  };
}

export async function reactiveCompact(
  messages: ChatMessage[],
  input: {
    llm: LlmClient;
    model: string;
    workspaceRoot: string;
    sessionId: string;
    abortSignal?: AbortSignal;
  },
): Promise<CompactStepResult> {
  const tokensBefore = estimateTokens(messages);
  const messagesBefore = messages.length;
  const result = await compactHistoryWithLlm(messages, {
    ...input,
    keepTailGroups: 5,
    label: "Reactive compact",
  });
  return {
    messages: result.messages,
    layers: ["reactive"],
    tokensBefore,
    tokensAfter: estimateTokens(result.messages),
    messagesBefore,
    messagesAfter: result.messages.length,
    transcriptPath: result.transcriptPath,
  };
}
