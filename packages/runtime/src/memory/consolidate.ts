import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "../types.js";
import {
  listMemoryFiles,
  replaceAllMemoryFiles,
  type MemoryType,
} from "./files.js";

const LOCK_NAME = ".consolidate-lock";
const LOCK_TTL_MS = 60 * 60 * 1000;

function parseMemoryType(raw: unknown): MemoryType {
  const value = String(raw ?? "project");
  if (value === "user" || value === "feedback" || value === "project" || value === "reference") {
    return value;
  }
  return "project";
}

function tryAcquireLock(root: string): boolean {
  const path = join(root, LOCK_NAME);
  if (existsSync(path)) {
    try {
      const raw = Number(readFileSync(path, "utf8"));
      if (Number.isFinite(raw) && Date.now() - raw < LOCK_TTL_MS) {
        return false;
      }
    } catch {
      // stale/unreadable → take lock
    }
  }
  writeFileSync(path, String(Date.now()), "utf8");
  return true;
}

function releaseLock(root: string): void {
  const path = join(root, LOCK_NAME);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}

export async function consolidateMemories(input: {
  root: string;
  llm: LlmClient;
  model: string;
  abortSignal?: AbortSignal;
}): Promise<{ replaced: number }> {
  const files = listMemoryFiles(input.root);
  if (files.length === 0) return { replaced: 0 };
  if (!tryAcquireLock(input.root)) return { replaced: 0 };

  try {
    const catalog = files
      .map(
        (f) =>
          `### ${f.name} (${f.type})\nfilename: ${f.filename}\ndescription: ${f.description}\n\n${f.body}`,
      )
      .join("\n\n---\n\n")
      .slice(0, 80_000);

    const response = await input.llm.chat({
      model: input.model,
      messages: [
        {
          role: "system",
          content:
            "Consolidate durable memories: dedupe, merge contradictions, drop stale items. " +
            "Respond with TEXT ONLY as a JSON array: " +
            '[{ "name", "type", "description", "body" }]. Do not call tools.',
        },
        {
          role: "user",
          content: `Memories to consolidate:\n\n${catalog}`,
        },
      ],
      abortSignal: input.abortSignal,
    });

    const text = response.message.content ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return { replaced: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]!);
    } catch {
      return { replaced: 0 };
    }
    if (!Array.isArray(parsed)) return { replaced: 0 };

    const next = parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const rec = item as Record<string, unknown>;
        return {
          name: String(rec.name ?? "").trim(),
          description: String(rec.description ?? "").trim(),
          type: parseMemoryType(rec.type),
          body: String(rec.body ?? "").trim(),
        };
      })
      .filter((m) => m.name && m.body);

    if (next.length === 0) return { replaced: 0 };
    const written = replaceAllMemoryFiles(input.root, next);
    return { replaced: written.length };
  } finally {
    releaseLock(input.root);
  }
}
