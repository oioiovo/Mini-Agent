import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryFile {
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  mtimeMs: number;
}

const INDEX_NAME = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25 * 1024;

const MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

export function resolveMemoryRoot(input: {
  root?: string;
  workspaceRoot: string;
  dataDir?: string;
}): string {
  const fromEnv = process.env.MINI_AGENT_MEMORY_DIR?.trim();
  const raw = input.root?.trim() || fromEnv || "";
  if (raw) {
    return isAbsolute(raw) ? raw : resolve(input.workspaceRoot, raw);
  }
  return join(input.workspaceRoot, ".mini-agent", "memory");
}

export function ensureMemoryRoot(root: string): string {
  mkdirSync(root, { recursive: true });
  return root;
}

export function slugifyMemoryName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `memory-${Date.now()}`;
}

function parseFrontmatter(raw: string): {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      name: "untitled",
      description: "",
      type: "project",
      body: raw.trim(),
    };
  }
  let meta: Record<string, unknown> = {};
  try {
    meta = (parseYaml(match[1]!) as Record<string, unknown>) ?? {};
  } catch {
    meta = {};
  }
  const typeRaw = String(meta.type ?? "project");
  const type = MEMORY_TYPES.has(typeRaw as MemoryType)
    ? (typeRaw as MemoryType)
    : "project";
  return {
    name: String(meta.name ?? "untitled"),
    description: String(meta.description ?? ""),
    type,
    body: (match[2] ?? "").trim(),
  };
}

function serializeMemoryFile(input: {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}): string {
  return (
    `---\n` +
    `name: ${JSON.stringify(input.name)}\n` +
    `description: ${JSON.stringify(input.description)}\n` +
    `type: ${input.type}\n` +
    `---\n\n` +
    `${input.body.trim()}\n`
  );
}

export function listMemoryFiles(root: string): MemoryFile[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root)
    .filter((name) => name.endsWith(".md") && name !== INDEX_NAME)
    .map((filename) => {
      const path = join(root, filename);
      const stat = statSync(path);
      const parsed = parseFrontmatter(readFileSync(path, "utf8"));
      return {
        filename,
        name: parsed.name,
        description: parsed.description,
        type: parsed.type,
        body: parsed.body,
        mtimeMs: stat.mtimeMs,
      } satisfies MemoryFile;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

export function readMemoryIndex(root: string): string {
  const path = join(root, INDEX_NAME);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export function rebuildMemoryIndex(root: string): string {
  ensureMemoryRoot(root);
  const files = listMemoryFiles(root);
  const lines = files.map(
    (f) => `- [${f.name}](${f.filename}) — ${f.description || f.name}`,
  );
  let text = "# Memory Index\n\n" + (lines.length ? lines.join("\n") + "\n" : "");
  const truncatedLines = text.split("\n");
  if (truncatedLines.length > MAX_INDEX_LINES) {
    text = truncatedLines.slice(0, MAX_INDEX_LINES).join("\n") + "\n";
  }
  if (Buffer.byteLength(text, "utf8") > MAX_INDEX_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, MAX_INDEX_BYTES).toString("utf8");
  }
  writeFileSync(join(root, INDEX_NAME), text, "utf8");
  return text;
}

export function writeMemoryFile(
  root: string,
  input: {
    name: string;
    description: string;
    type: MemoryType;
    body: string;
    filename?: string;
  },
): MemoryFile {
  ensureMemoryRoot(root);
  const filename = input.filename ?? `${slugifyMemoryName(input.name)}.md`;
  const safe = basename(filename).replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, "-");
  const finalName = safe.endsWith(".md") ? safe : `${safe}.md`;
  if (finalName === INDEX_NAME) {
    throw new Error("Cannot overwrite MEMORY.md via writeMemoryFile");
  }
  const path = join(root, finalName);
  const content = serializeMemoryFile(input);
  writeFileSync(path, content, "utf8");
  rebuildMemoryIndex(root);
  const stat = statSync(path);
  return {
    filename: finalName,
    name: input.name,
    description: input.description,
    type: input.type,
    body: input.body.trim(),
    mtimeMs: stat.mtimeMs,
  };
}

export function readMemoryFile(root: string, filename: string): MemoryFile | undefined {
  const safe = basename(filename);
  if (!safe.endsWith(".md") || safe === INDEX_NAME) return undefined;
  const path = join(root, safe);
  if (!existsSync(path)) return undefined;
  const parsed = parseFrontmatter(readFileSync(path, "utf8"));
  const stat = statSync(path);
  return {
    filename: safe,
    name: parsed.name,
    description: parsed.description,
    type: parsed.type,
    body: parsed.body,
    mtimeMs: stat.mtimeMs,
  };
}

export function deleteMemoryFile(root: string, filename: string): boolean {
  const safe = basename(filename);
  if (!safe.endsWith(".md") || safe === INDEX_NAME) return false;
  const path = join(root, safe);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  rebuildMemoryIndex(root);
  return true;
}

export function replaceAllMemoryFiles(
  root: string,
  memories: Array<{
    name: string;
    description: string;
    type: MemoryType;
    body: string;
  }>,
): MemoryFile[] {
  ensureMemoryRoot(root);
  for (const file of listMemoryFiles(root)) {
    unlinkSync(join(root, file.filename));
  }
  const written: MemoryFile[] = [];
  for (const mem of memories) {
    written.push(writeMemoryFile(root, mem));
  }
  rebuildMemoryIndex(root);
  return written;
}

/** Truncate body for injection budgets. */
export function clipMemoryBody(
  body: string,
  maxLines = 200,
  maxBytes = 4096,
): string {
  let text = body;
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n") + "\n…[truncated]";
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    text =
      Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8") +
      "\n…[truncated]";
  }
  return text;
}

export function formatMemoryIndexBlock(indexMarkdown: string): string {
  const trimmed = indexMarkdown.trim();
  if (!trimmed) return "";
  // Leading newlines kept for callers that append onto an existing system string.
  return (
    `\n\n# Durable memories\n` +
    `The following is an index of durable memories that survive context compaction and sessions.\n` +
    `Use memory_read to load full content when needed.\n\n` +
    trimmed
  );
}
