import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CaseContext, CaseResult } from "./types.js";

export interface CaseHooks {
  before?: (ctx: CaseContext) => void | Promise<void>;
  after?: (ctx: CaseContext, result: CaseResult) => void | Promise<void>;
}

export async function loadHooks(
  caseFileDir: string,
  hooks: { before?: string; after?: string } | undefined,
): Promise<CaseHooks> {
  if (!hooks) return {};
  const loaded: CaseHooks = {};
  if (hooks.before) {
    const mod = await import(pathToFileURL(resolve(caseFileDir, hooks.before)).href);
    if (typeof mod.before !== "function") {
      throw new Error(`Hook ${hooks.before} must export function before()`);
    }
    loaded.before = mod.before;
  }
  if (hooks.after) {
    const mod = await import(pathToFileURL(resolve(caseFileDir, hooks.after)).href);
    if (typeof mod.after !== "function") {
      throw new Error(`Hook ${hooks.after} must export function after()`);
    }
    loaded.after = mod.after;
  }
  return loaded;
}
