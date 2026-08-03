import { mkdirSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function ensureWorkspaceRoot(root: string): string {
  const absolute = resolve(root);
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

export function resolveSafePath(workspaceRoot: string, userPath: string): string {
  const root = resolve(workspaceRoot);
  const combined = resolve(root, normalize(userPath || "."));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (combined !== root && !combined.startsWith(rootWithSep)) {
    throw new WorkspacePathError(`Path escapes workspace: ${userPath}`);
  }
  return combined;
}

export function defaultWorkspaceRoot(): string {
  return resolve(process.env.MINI_AGENT_WORKSPACE ?? join(process.cwd(), "workspace"));
}

export function parentDir(filePath: string): string {
  return dirname(filePath);
}
