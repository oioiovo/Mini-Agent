import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { CronJobStore } from "./store.js";
import type { CronJobRecord, CronJobUpsertInput } from "./types.js";

export interface CronConfigFile {
  jobs?: Array<{
    id?: string;
    cron: string;
    timezone?: string;
    message: string;
    system_prompt?: string;
    systemPrompt?: string;
    session_mode?: string;
    sessionMode?: string;
    session_id?: string;
    sessionId?: string;
    model?: string;
    max_steps?: number;
    maxSteps?: number;
    timeout_ms?: number;
    timeoutMs?: number;
    enabled?: boolean;
    auto_approve?: boolean;
    autoApprove?: boolean;
    overlap?: string;
  }>;
}

function toUpsertInput(
  raw: NonNullable<CronConfigFile["jobs"]>[number],
): CronJobUpsertInput {
  return {
    id: raw.id,
    cron: raw.cron,
    timezone: raw.timezone,
    message: raw.message,
    systemPrompt: raw.system_prompt ?? raw.systemPrompt,
    sessionMode: raw.session_mode ?? raw.sessionMode,
    sessionId: raw.session_id ?? raw.sessionId,
    model: raw.model,
    maxSteps: raw.max_steps ?? raw.maxSteps,
    timeoutMs: raw.timeout_ms ?? raw.timeoutMs,
    enabled: raw.enabled,
    autoApprove: raw.auto_approve ?? raw.autoApprove,
    overlap: raw.overlap,
    source: "file",
  };
}

export function parseCronConfigText(text: string, filePath?: string): CronJobUpsertInput[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    if (filePath?.endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
      parsed = JSON.parse(trimmed) as unknown;
    } else {
      parsed = parseYaml(trimmed) as unknown;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse cron config${filePath ? ` (${filePath})` : ""}: ${msg}`);
  }

  const root = parsed as CronConfigFile | CronConfigFile["jobs"];
  const jobs = Array.isArray(root) ? root : root?.jobs;
  if (!jobs) return [];
  if (!Array.isArray(jobs)) {
    throw new Error("Cron config must contain a jobs array");
  }
  return jobs.map(toUpsertInput);
}

export function loadCronConfigFile(filePath: string): CronJobUpsertInput[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  return parseCronConfigText(text, filePath);
}

/** Upsert file jobs and delete file-sourced jobs missing from the config. */
export function syncCronJobsFromConfig(
  store: CronJobStore,
  jobs: CronJobUpsertInput[],
): { upserted: CronJobRecord[]; deleted: number } {
  const upserted: CronJobRecord[] = [];
  const keepIds: string[] = [];
  for (const job of jobs) {
    const record = store.upsert({ ...job, source: "file" });
    upserted.push(record);
    keepIds.push(record.id);
  }
  const deleted = store.deleteBySourceExcept("file", keepIds);
  return { upserted, deleted };
}
