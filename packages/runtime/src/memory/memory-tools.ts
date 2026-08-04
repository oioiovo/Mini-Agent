import type { FileMemoryStore } from "./file-store.js";
import { defineLocalTool, type RegisteredTool } from "../tools/registry.js";
import type { MemoryType } from "./files.js";

function parseType(raw: unknown): MemoryType {
  const value = String(raw ?? "project");
  if (value === "user" || value === "feedback" || value === "project" || value === "reference") {
    return value;
  }
  return "project";
}

export function createMemoryTools(memory: FileMemoryStore): RegisteredTool[] {
  if (!memory.enabled) return [];

  return [
    defineLocalTool({
      name: "memory_write",
      description:
        "Save a durable memory (user preference, feedback, project fact, or reference) that survives context compaction and future sessions.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          type: {
            type: "string",
            description: "user | feedback | project | reference",
          },
          body: { type: "string" },
        },
        required: ["name", "body"],
      },
      execute: (args) => {
        const file = memory.write({
          name: String(args.name ?? ""),
          description: String(args.description ?? args.name ?? ""),
          type: parseType(args.type),
          body: String(args.body ?? ""),
        });
        return {
          ok: true,
          filename: file.filename,
          name: file.name,
          type: file.type,
        };
      },
    }),
    defineLocalTool({
      name: "memory_read",
      description: "Read a durable memory file by filename (from the MEMORY.md index).",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
        },
        required: ["filename"],
      },
      execute: (args) => {
        const file = memory.read(String(args.filename ?? ""));
        if (!file) {
          return { ok: false, error: "Memory not found" };
        }
        return {
          ok: true,
          filename: file.filename,
          name: file.name,
          description: file.description,
          type: file.type,
          body: file.body,
        };
      },
    }),
  ];
}
