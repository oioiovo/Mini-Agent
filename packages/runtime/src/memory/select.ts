import type { ChatMessage, LlmClient } from "../types.js";
import {
  clipMemoryBody,
  listMemoryFiles,
  readMemoryFile,
  type MemoryFile,
} from "./files.js";

const MAX_SELECT = 5;
const SESSION_BUDGET_BYTES = 60 * 1024;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter(Boolean);
}

function scoreKeyword(query: string, file: MemoryFile): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const hay = tokenize(`${file.name} ${file.description} ${file.body.slice(0, 500)}`);
  const set = new Set(hay);
  let hit = 0;
  for (const t of q) {
    if (set.has(t)) hit += 1;
  }
  return hit / q.size;
}

export function selectMemoriesByKeyword(
  files: MemoryFile[],
  query: string,
  maxItems = MAX_SELECT,
): MemoryFile[] {
  return files
    .map((f) => ({ f, score: scoreKeyword(query, f) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map((x) => x.f);
}

function formatRecent(messages: ChatMessage[], limit = 8): string {
  return messages
    .slice(-limit)
    .map((m) => `[${m.role}] ${m.content.slice(0, 400)}`)
    .join("\n");
}

export async function selectRelevantMemories(input: {
  root: string;
  query: string;
  recentMessages?: ChatMessage[];
  llm?: LlmClient;
  model?: string;
  maxItems?: number;
  abortSignal?: AbortSignal;
}): Promise<MemoryFile[]> {
  const maxItems = input.maxItems ?? MAX_SELECT;
  const files = listMemoryFiles(input.root).slice(0, 200);
  if (files.length === 0) return [];

  if (input.llm && input.model) {
    try {
      const catalog = files
        .map((f, i) => `${i}: ${f.name} — ${f.description || f.filename}`)
        .join("\n");
      const recent = formatRecent(input.recentMessages ?? []);
      const response = await input.llm.chat({
        model: input.model,
        messages: [
          {
            role: "system",
            content:
              "Select relevant durable memory indices for the current request. " +
              "Respond with TEXT ONLY: a JSON array of integer indices. " +
              "If unsure, return []. Do not call tools.",
          },
          {
            role: "user",
            content:
              `Recent conversation:\n${recent || "(none)"}\n\n` +
              `Current request:\n${input.query}\n\n` +
              `Memory catalog:\n${catalog}\n\n` +
              `Return JSON array of up to ${maxItems} indices.`,
          },
        ],
        abortSignal: input.abortSignal,
      });
      const text = response.message.content ?? "";
      const match = text.match(/\[[\s\S]*?\]/);
      if (match) {
        const indices = JSON.parse(match[0]) as unknown;
        if (Array.isArray(indices)) {
          const picked: MemoryFile[] = [];
          for (const raw of indices) {
            const i = Number(raw);
            if (!Number.isInteger(i) || i < 0 || i >= files.length) continue;
            const file = files[i]!;
            if (!picked.some((p) => p.filename === file.filename)) {
              picked.push(file);
            }
            if (picked.length >= maxItems) break;
          }
          if (picked.length > 0) return picked;
        }
      }
    } catch {
      // fall through to keyword
    }
  }

  return selectMemoriesByKeyword(files, input.query, maxItems);
}

export function loadMemoryBodies(
  root: string,
  files: MemoryFile[],
  budgetBytes = SESSION_BUDGET_BYTES,
): Array<{ file: MemoryFile; body: string }> {
  const out: Array<{ file: MemoryFile; body: string }> = [];
  let used = 0;
  for (const meta of files) {
    const full = readMemoryFile(root, meta.filename) ?? meta;
    const body = clipMemoryBody(full.body);
    const size = Buffer.byteLength(body, "utf8");
    if (used + size > budgetBytes) break;
    out.push({ file: full, body });
    used += size;
  }
  return out;
}

export function formatRelevantMemoriesBlock(
  loaded: Array<{ file: MemoryFile; body: string }>,
): string {
  if (loaded.length === 0) return "";
  const parts = loaded.map(
    ({ file, body }) =>
      `### ${file.name} (${file.type})\n${file.description}\n\n${body}`,
  );
  return `[Relevant memories]\n\n${parts.join("\n\n")}\n\n---\n\n`;
}
