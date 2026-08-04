import type { ChatMessage, LlmClient } from "../types.js";
import { listMemoryFiles, writeMemoryFile, type MemoryType } from "./files.js";
import { consolidateMemories } from "./consolidate.js";

function formatDialogue(messages: ChatMessage[], limit = 10): string {
  return messages
    .slice(-limit)
    .map((m) => {
      const tools =
        m.toolCalls?.map((c) => ` tool_call:${c.name}`).join("") ?? "";
      return `[${m.role}${tools}] ${m.content.slice(0, 800)}`;
    })
    .join("\n\n")
    .slice(0, 4000);
}

function parseMemoryType(raw: unknown): MemoryType {
  const value = String(raw ?? "project");
  if (value === "user" || value === "feedback" || value === "project" || value === "reference") {
    return value;
  }
  return "project";
}

export async function extractMemories(input: {
  root: string;
  messages: ChatMessage[];
  llm: LlmClient;
  model: string;
  consolidateThreshold?: number;
  abortSignal?: AbortSignal;
}): Promise<{ written: number; consolidated: boolean }> {
  const existing = listMemoryFiles(input.root);
  const catalog = existing
    .map((m) => `- ${m.name}: ${m.description}`)
    .join("\n");
  const dialogue = formatDialogue(input.messages);
  if (!dialogue.trim()) return { written: 0, consolidated: false };

  const response = await input.llm.chat({
    model: input.model,
    messages: [
      {
        role: "system",
        content:
          "Extract durable user preferences, constraints, or project facts worth keeping across sessions. " +
          "Respond with TEXT ONLY as a JSON array of objects: " +
          '[{ "name", "type", "description", "body" }]. ' +
          "type must be one of: user, feedback, project, reference. " +
          "If nothing new or already covered, return []. Do not call tools.",
      },
      {
        role: "user",
        content:
          `Existing memories:\n${catalog || "(none)"}\n\n` +
          `Dialogue:\n${dialogue}`,
      },
    ],
    abortSignal: input.abortSignal,
  });

  const text = response.message.content ?? "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return { written: 0, consolidated: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]!);
  } catch {
    return { written: 0, consolidated: false };
  }
  if (!Array.isArray(parsed)) return { written: 0, consolidated: false };

  const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));
  let written = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    const description = String(rec.description ?? "").trim();
    const body = String(rec.body ?? "").trim();
    if (!name || !body) continue;
    if (existingNames.has(name.toLowerCase())) continue;
    writeMemoryFile(input.root, {
      name,
      description: description || name,
      type: parseMemoryType(rec.type),
      body,
    });
    existingNames.add(name.toLowerCase());
    written += 1;
  }

  let consolidated = false;
  const threshold = input.consolidateThreshold ?? 10;
  if (listMemoryFiles(input.root).length >= threshold) {
    await consolidateMemories({
      root: input.root,
      llm: input.llm,
      model: input.model,
      abortSignal: input.abortSignal,
    });
    consolidated = true;
  }

  return { written, consolidated };
}
