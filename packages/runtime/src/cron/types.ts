import { Cron } from "croner";

export type CronSessionMode = "sticky" | "ephemeral";
export type CronOverlap = "skip";
export type CronJobSource = "file" | "api";
export type CronLastStatus = "ok" | "error" | "skipped" | "";

export interface CronJobRecord {
  id: string;
  cron: string;
  timezone: string;
  message: string;
  systemPrompt: string;
  sessionMode: CronSessionMode;
  sessionId: string;
  model: string;
  maxSteps: number;
  timeoutMs: number;
  enabled: boolean;
  autoApprove: boolean;
  overlap: CronOverlap;
  source: CronJobSource;
  lastRunAtMs: number;
  lastStatus: CronLastStatus;
  lastError: string;
  lastRunId: string;
  nextRunAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CronJobUpsertInput {
  id?: string;
  cron: string;
  timezone?: string;
  message: string;
  systemPrompt?: string;
  sessionMode?: CronSessionMode | string;
  sessionId?: string;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
  enabled?: boolean;
  autoApprove?: boolean;
  overlap?: CronOverlap | string;
  source?: CronJobSource;
}

export function normalizeSessionMode(value?: string): CronSessionMode {
  return value === "ephemeral" ? "ephemeral" : "sticky";
}

export function normalizeOverlap(value?: string): CronOverlap {
  if (value && value !== "skip") {
    throw new Error(`Unsupported overlap policy: ${value}`);
  }
  return "skip";
}

/** Validate cron expression and optionally compute next fire time. */
export function assertValidCron(expression: string, timezone = "UTC"): void {
  try {
    // eslint-disable-next-line no-new
    new Cron(expression, { timezone, paused: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression "${expression}": ${msg}`);
  }
}

export function computeNextRunAtMs(
  expression: string,
  timezone: string,
  fromMs = Date.now(),
): number {
  assertValidCron(expression, timezone);
  const job = new Cron(expression, { timezone, paused: true });
  const next = job.nextRun(new Date(fromMs));
  if (!next) {
    throw new Error(`Cron expression has no next run: ${expression}`);
  }
  return next.getTime();
}
