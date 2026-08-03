import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Walk upward from starts until pnpm-workspace.yaml is found. */
export function findRepoRoot(starts: string[]): string {
  for (const start of starts) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(starts[0] ?? process.cwd());
}

/** Resolve env path values relative to the monorepo root (not process.cwd()). */
export function resolveFromRepo(
  repoRoot: string,
  value: string | undefined,
  fallback: string,
): string {
  const raw = value?.trim() || fallback;
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
}
