import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { nowMs } from "../utils.js";
import {
  assertValidCron,
  computeNextRunAtMs,
  normalizeOverlap,
  normalizeSessionMode,
  type CronJobRecord,
  type CronJobSource,
  type CronJobUpsertInput,
  type CronLastStatus,
} from "./types.js";

export interface CronJobStore {
  upsert(input: CronJobUpsertInput): CronJobRecord;
  get(id: string): CronJobRecord | undefined;
  list(): CronJobRecord[];
  delete(id: string): boolean;
  setEnabled(id: string, enabled: boolean): CronJobRecord;
  updateSessionId(id: string, sessionId: string): CronJobRecord;
  updateRunResult(
    id: string,
    patch: {
      lastRunAtMs: number;
      lastStatus: CronLastStatus;
      lastError?: string;
      lastRunId?: string;
      nextRunAtMs?: number;
    },
  ): CronJobRecord;
  deleteBySourceExcept(source: CronJobSource, keepIds: string[]): number;
  close(): void;
}

type CronRow = {
  id: string;
  cron: string;
  timezone: string;
  message: string;
  system_prompt: string;
  session_mode: string;
  session_id: string;
  model: string;
  max_steps: number;
  timeout_ms: number;
  enabled: number;
  auto_approve: number;
  overlap: string;
  source: string;
  last_run_at_ms: number;
  last_status: string;
  last_error: string;
  last_run_id: string;
  next_run_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
};

function rowToRecord(row: CronRow): CronJobRecord {
  return {
    id: row.id,
    cron: row.cron,
    timezone: row.timezone,
    message: row.message,
    systemPrompt: row.system_prompt,
    sessionMode: normalizeSessionMode(row.session_mode),
    sessionId: row.session_id,
    model: row.model,
    maxSteps: row.max_steps,
    timeoutMs: row.timeout_ms,
    enabled: Boolean(row.enabled),
    autoApprove: Boolean(row.auto_approve),
    overlap: normalizeOverlap(row.overlap),
    source: row.source === "file" ? "file" : "api",
    lastRunAtMs: row.last_run_at_ms,
    lastStatus: (row.last_status as CronLastStatus) || "",
    lastError: row.last_error,
    lastRunId: row.last_run_id,
    nextRunAtMs: row.next_run_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export class SqliteCronJobStore implements CronJobStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        message TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        session_mode TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        auto_approve INTEGER NOT NULL,
        overlap TEXT NOT NULL,
        source TEXT NOT NULL,
        last_run_at_ms INTEGER NOT NULL,
        last_status TEXT NOT NULL,
        last_error TEXT NOT NULL,
        last_run_id TEXT NOT NULL,
        next_run_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  upsert(input: CronJobUpsertInput): CronJobRecord {
    if (!input.message?.trim()) {
      throw new Error("Cron job message is required");
    }
    const timezone = input.timezone?.trim() || "UTC";
    assertValidCron(input.cron, timezone);
    const sessionMode = normalizeSessionMode(input.sessionMode);
    const overlap = normalizeOverlap(input.overlap);
    const source = input.source ?? "api";
    const now = nowMs();
    const existing = input.id ? this.get(input.id) : undefined;
    const id = input.id?.trim() || existing?.id || nanoid();
    const nextRunAtMs = computeNextRunAtMs(input.cron, timezone, now);

    const record: CronJobRecord = {
      id,
      cron: input.cron.trim(),
      timezone,
      message: input.message,
      systemPrompt: input.systemPrompt ?? existing?.systemPrompt ?? "",
      sessionMode,
      sessionId: input.sessionId ?? existing?.sessionId ?? "",
      model: input.model ?? existing?.model ?? "",
      maxSteps: input.maxSteps ?? existing?.maxSteps ?? 0,
      timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? 0,
      enabled: input.enabled ?? existing?.enabled ?? true,
      autoApprove: input.autoApprove ?? existing?.autoApprove ?? false,
      overlap,
      source,
      lastRunAtMs: existing?.lastRunAtMs ?? 0,
      lastStatus: existing?.lastStatus ?? "",
      lastError: existing?.lastError ?? "",
      lastRunId: existing?.lastRunId ?? "",
      nextRunAtMs,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };

    this.db
      .prepare(
        `INSERT INTO cron_jobs (
          id, cron, timezone, message, system_prompt, session_mode, session_id,
          model, max_steps, timeout_ms, enabled, auto_approve, overlap, source,
          last_run_at_ms, last_status, last_error, last_run_id, next_run_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cron=excluded.cron,
          timezone=excluded.timezone,
          message=excluded.message,
          system_prompt=excluded.system_prompt,
          session_mode=excluded.session_mode,
          session_id=CASE WHEN excluded.session_id = '' THEN cron_jobs.session_id ELSE excluded.session_id END,
          model=excluded.model,
          max_steps=excluded.max_steps,
          timeout_ms=excluded.timeout_ms,
          enabled=excluded.enabled,
          auto_approve=excluded.auto_approve,
          overlap=excluded.overlap,
          source=excluded.source,
          next_run_at_ms=excluded.next_run_at_ms,
          updated_at_ms=excluded.updated_at_ms`,
      )
      .run(
        record.id,
        record.cron,
        record.timezone,
        record.message,
        record.systemPrompt,
        record.sessionMode,
        record.sessionId,
        record.model,
        record.maxSteps,
        record.timeoutMs,
        record.enabled ? 1 : 0,
        record.autoApprove ? 1 : 0,
        record.overlap,
        record.source,
        record.lastRunAtMs,
        record.lastStatus,
        record.lastError,
        record.lastRunId,
        record.nextRunAtMs,
        record.createdAtMs,
        record.updatedAtMs,
      );

    return this.get(id)!;
  }

  get(id: string): CronJobRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cron_jobs WHERE id = ?`)
      .get(id) as CronRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(): CronJobRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM cron_jobs ORDER BY id ASC`)
      .all() as CronRow[];
    return rows.map(rowToRecord);
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  setEnabled(id: string, enabled: boolean): CronJobRecord {
    const existing = this.get(id);
    if (!existing) throw new Error(`Cron job not found: ${id}`);
    const now = nowMs();
    const nextRunAtMs = enabled
      ? computeNextRunAtMs(existing.cron, existing.timezone, now)
      : existing.nextRunAtMs;
    this.db
      .prepare(
        `UPDATE cron_jobs SET enabled = ?, next_run_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, nextRunAtMs, now, id);
    return this.get(id)!;
  }

  updateSessionId(id: string, sessionId: string): CronJobRecord {
    const now = nowMs();
    this.db
      .prepare(`UPDATE cron_jobs SET session_id = ?, updated_at_ms = ? WHERE id = ?`)
      .run(sessionId, now, id);
    const job = this.get(id);
    if (!job) throw new Error(`Cron job not found: ${id}`);
    return job;
  }

  updateRunResult(
    id: string,
    patch: {
      lastRunAtMs: number;
      lastStatus: CronLastStatus;
      lastError?: string;
      lastRunId?: string;
      nextRunAtMs?: number;
    },
  ): CronJobRecord {
    const existing = this.get(id);
    if (!existing) throw new Error(`Cron job not found: ${id}`);
    const now = nowMs();
    const nextRunAtMs =
      patch.nextRunAtMs ??
      (existing.enabled
        ? computeNextRunAtMs(existing.cron, existing.timezone, patch.lastRunAtMs)
        : existing.nextRunAtMs);
    this.db
      .prepare(
        `UPDATE cron_jobs SET
          last_run_at_ms = ?,
          last_status = ?,
          last_error = ?,
          last_run_id = ?,
          next_run_at_ms = ?,
          updated_at_ms = ?
        WHERE id = ?`,
      )
      .run(
        patch.lastRunAtMs,
        patch.lastStatus,
        patch.lastError ?? "",
        patch.lastRunId ?? "",
        nextRunAtMs,
        now,
        id,
      );
    return this.get(id)!;
  }

  deleteBySourceExcept(source: CronJobSource, keepIds: string[]): number {
    if (keepIds.length === 0) {
      const result = this.db
        .prepare(`DELETE FROM cron_jobs WHERE source = ?`)
        .run(source);
      return Number(result.changes);
    }
    const placeholders = keepIds.map(() => "?").join(",");
    const result = this.db
      .prepare(`DELETE FROM cron_jobs WHERE source = ? AND id NOT IN (${placeholders})`)
      .run(source, ...keepIds);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
