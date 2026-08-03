import type { CaseDef, FakeLlmStep, TestMode } from "./types.js";

const MODES = new Set<TestMode>(["unit", "e2e", "live"]);

export function parseCase(raw: unknown, source: string): CaseDef {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid case file ${source}: expected object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id.trim()) {
    throw new Error(`Invalid case file ${source}: id is required`);
  }
  if (typeof obj.prompt !== "string") {
    throw new Error(`Invalid case ${obj.id}: prompt is required`);
  }
  if (!Array.isArray(obj.modes) || obj.modes.length === 0) {
    throw new Error(`Invalid case ${obj.id}: modes must be a non-empty array`);
  }
  const modes = obj.modes.map((m) => {
    if (typeof m !== "string" || !MODES.has(m as TestMode)) {
      throw new Error(`Invalid case ${obj.id}: unknown mode ${String(m)}`);
    }
    return m as TestMode;
  });

  const fake_llm = Array.isArray(obj.fake_llm)
    ? (obj.fake_llm as FakeLlmStep[])
    : undefined;

  const hooks =
    obj.hooks && typeof obj.hooks === "object"
      ? (obj.hooks as CaseDef["hooks"])
      : undefined;

  const expect =
    obj.expect && typeof obj.expect === "object"
      ? (obj.expect as CaseDef["expect"])
      : undefined;

  return {
    id: obj.id,
    description: typeof obj.description === "string" ? obj.description : undefined,
    modes,
    tags: Array.isArray(obj.tags) ? obj.tags.map(String) : undefined,
    system_prompt: typeof obj.system_prompt === "string" ? obj.system_prompt : undefined,
    prompt: obj.prompt,
    builtins: obj.builtins !== false,
    auto_approve: typeof obj.auto_approve === "boolean" ? obj.auto_approve : undefined,
    fake_llm,
    expect,
    hooks,
  };
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing template var {{${key}}}`);
    }
    return vars[key]!;
  });
}
