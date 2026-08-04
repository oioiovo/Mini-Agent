import {
  DEFAULT_IDENTITY,
  formatMemorySection,
  formatToolsSection,
  formatWorkspaceSection,
} from "./sections.js";

export type PromptSectionName = "identity" | "tools" | "workspace" | "memory";

export interface PromptContext {
  identity: string;
  toolNames: string[];
  workspaceRoot: string;
  /** Raw MEMORY.md index markdown (without wrapper); empty → memory section omitted. */
  memoryIndex: string;
}

export interface AssembleResult {
  prompt: string;
  sectionsLoaded: PromptSectionName[];
}

export function buildPromptContext(input: {
  identity?: string;
  toolNames: string[];
  workspaceRoot: string;
  memoryIndex?: string;
}): PromptContext {
  return {
    identity: (input.identity?.trim() || DEFAULT_IDENTITY),
    toolNames: [...input.toolNames].sort(),
    workspaceRoot: input.workspaceRoot,
    memoryIndex: input.memoryIndex?.trim() ?? "",
  };
}

export function assembleSystemPrompt(context: PromptContext): AssembleResult {
  const sectionsLoaded: PromptSectionName[] = [];
  const parts: string[] = [];

  parts.push(context.identity);
  sectionsLoaded.push("identity");

  parts.push(formatToolsSection(context.toolNames));
  sectionsLoaded.push("tools");

  parts.push(formatWorkspaceSection(context.workspaceRoot));
  sectionsLoaded.push("workspace");

  const memory = formatMemorySection(context.memoryIndex);
  if (memory) {
    parts.push(memory);
    sectionsLoaded.push("memory");
  }

  return {
    prompt: parts.join("\n\n"),
    sectionsLoaded,
  };
}

function contextCacheKey(context: PromptContext): string {
  return JSON.stringify({
    identity: context.identity,
    toolNames: context.toolNames,
    workspaceRoot: context.workspaceRoot,
    memoryIndex: context.memoryIndex,
  });
}

export interface SystemPromptCacheStats {
  hits: number;
  misses: number;
}

/**
 * Instance-scoped cache: same PromptContext → reuse assembled string.
 * Avoids re-joining sections across LLM steps when state is unchanged.
 */
export class SystemPromptCache {
  private lastKey = "";
  private lastPrompt = "";
  private lastSections: PromptSectionName[] = [];
  readonly stats: SystemPromptCacheStats = { hits: 0, misses: 0 };

  get(context: PromptContext): AssembleResult {
    const key = contextCacheKey(context);
    if (key === this.lastKey && this.lastPrompt) {
      this.stats.hits += 1;
      return { prompt: this.lastPrompt, sectionsLoaded: this.lastSections };
    }
    this.stats.misses += 1;
    const assembled = assembleSystemPrompt(context);
    this.lastKey = key;
    this.lastPrompt = assembled.prompt;
    this.lastSections = assembled.sectionsLoaded;
    return assembled;
  }

  clear(): void {
    this.lastKey = "";
    this.lastPrompt = "";
    this.lastSections = [];
  }
}
