/** Default system-prompt section copy (s10-style). */

export const DEFAULT_IDENTITY =
  "You are a helpful agent. Prefer tools when they improve accuracy. " +
  "For multi-step work, use todo_write / todo_read when available. " +
  "Durable memories may be listed below; use memory_read for full content when needed. Act, don't only explain.";

export const DEFAULT_SUBAGENT_IDENTITY =
  "You are a focused subagent. Complete the assigned task concisely using available tools.";

export function formatToolsSection(toolNames: string[]): string {
  const list = toolNames.length > 0 ? toolNames.join(", ") : "(none)";
  return (
    `Available tools (schemas are provided via the tools API): ${list}.\n` +
    `Call tools when they help; do not invent tool results.`
  );
}

export function formatWorkspaceSection(workspaceRoot: string): string {
  return `Working directory: ${workspaceRoot}`;
}

export function formatMemorySection(memoryIndex: string): string {
  const trimmed = memoryIndex.trim();
  if (!trimmed) return "";
  return (
    `# Durable memories\n` +
    `The following is an index of durable memories that survive context compaction and sessions.\n` +
    `Use memory_read to load full content when needed.\n\n` +
    trimmed
  );
}
