import type { ChatMessage, LlmClient, MemoryHit, MemoryStore } from "../types.js";
import { extractMemories } from "./extract.js";
import {
  ensureMemoryRoot,
  listMemoryFiles,
  readMemoryFile,
  readMemoryIndex,
  rebuildMemoryIndex,
  resolveMemoryRoot,
  writeMemoryFile,
  type MemoryType,
} from "./files.js";
import {
  formatRelevantMemoriesBlock,
  loadMemoryBodies,
  selectRelevantMemories,
} from "./select.js";

export interface DurableMemoryOptions {
  enabled?: boolean;
  root?: string;
  workspaceRoot: string;
  consolidateThreshold?: number;
  maxSelect?: number;
  autoExtract?: boolean;
}

export interface PreparedMemoryContext {
  /** Raw MEMORY.md contents (assembler formats the memory section). */
  memoryIndex: string;
  userPrefix: string;
  hits: MemoryHit[];
}

/**
 * File-backed durable memory (s09/CC style) that also implements MemoryStore
 * for append/search compatibility with the agent loop.
 */
export class FileMemoryStore implements MemoryStore {
  readonly root: string;
  readonly enabled: boolean;
  readonly consolidateThreshold: number;
  readonly maxSelect: number;
  readonly autoExtract: boolean;
  private readonly history = new Map<string, ChatMessage[]>();

  constructor(options: DurableMemoryOptions) {
    this.enabled = options.enabled !== false;
    this.root = resolveMemoryRoot({
      root: options.root,
      workspaceRoot: options.workspaceRoot,
    });
    this.consolidateThreshold = options.consolidateThreshold ?? 10;
    this.maxSelect = options.maxSelect ?? 5;
    this.autoExtract = options.autoExtract !== false;
    if (this.enabled) {
      ensureMemoryRoot(this.root);
      if (!readMemoryIndex(this.root)) {
        rebuildMemoryIndex(this.root);
      }
    }
  }

  async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const existing = this.history.get(sessionId) ?? [];
    existing.push(...messages);
    this.history.set(sessionId, existing);
  }

  async getHistory(sessionId: string): Promise<ChatMessage[]> {
    return [...(this.history.get(sessionId) ?? [])];
  }

  async search(sessionId: string, query: string, limit = 5): Promise<MemoryHit[]> {
    if (!this.enabled) return [];
    const files = await selectRelevantMemories({
      root: this.root,
      query,
      recentMessages: this.history.get(sessionId),
      maxItems: limit,
    });
    return files.map((f) => ({
      id: f.filename,
      content: `${f.name}: ${f.description}`,
      score: 1,
      metadata: { type: f.type, filename: f.filename },
    }));
  }

  async summarizeIfNeeded(_sessionId: string, _maxMessages: number): Promise<void> {
    // No-op: context compact owns session compression.
  }

  async rememberLongTerm(
    content: string,
    metadata: Record<string, string> = {},
  ): Promise<string> {
    const file = writeMemoryFile(this.root, {
      name: metadata.name || `note-${Date.now()}`,
      description: metadata.description || content.slice(0, 120),
      type: (metadata.type as MemoryType) || "project",
      body: content,
    });
    return file.filename;
  }

  async prepareForRun(input: {
    sessionId: string;
    query: string;
    llm?: LlmClient;
    model?: string;
    abortSignal?: AbortSignal;
  }): Promise<PreparedMemoryContext> {
    if (!this.enabled) {
      return { memoryIndex: "", userPrefix: "", hits: [] };
    }
    const memoryIndex = readMemoryIndex(this.root);
    const selected = await selectRelevantMemories({
      root: this.root,
      query: input.query,
      recentMessages: this.history.get(input.sessionId),
      llm: input.llm,
      model: input.model,
      maxItems: this.maxSelect,
      abortSignal: input.abortSignal,
    });
    const loaded = loadMemoryBodies(this.root, selected);
    const userPrefix = formatRelevantMemoriesBlock(loaded);
    const hits: MemoryHit[] = loaded.map(({ file, body }) => ({
      id: file.filename,
      content: body.slice(0, 500),
      score: 1,
      metadata: { type: file.type, name: file.name },
    }));
    return { memoryIndex, userPrefix, hits };
  }

  async extractAfterRun(input: {
    messages: ChatMessage[];
    llm: LlmClient;
    model: string;
    abortSignal?: AbortSignal;
  }): Promise<{ written: number; consolidated: boolean }> {
    if (!this.enabled || !this.autoExtract) {
      return { written: 0, consolidated: false };
    }
    return extractMemories({
      root: this.root,
      messages: input.messages,
      llm: input.llm,
      model: input.model,
      consolidateThreshold: this.consolidateThreshold,
      abortSignal: input.abortSignal,
    });
  }

  write(input: {
    name: string;
    description: string;
    type: MemoryType;
    body: string;
  }) {
    return writeMemoryFile(this.root, input);
  }

  read(filename: string) {
    return readMemoryFile(this.root, filename);
  }

  list() {
    return listMemoryFiles(this.root);
  }
}
