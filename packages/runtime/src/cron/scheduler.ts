import type { AgentEvent, Logger } from "../types.js";
import { consoleLogger, nowMs } from "../utils.js";
import type { CronJobStore } from "./store.js";
import { computeNextRunAtMs, type CronJobRecord } from "./types.js";

export interface CronSchedulerAgent {
  createSession(input?: {
    metadata?: Record<string, string>;
    systemPrompt?: string;
  }): Promise<{ id: string }>;
  getSession(sessionId: string): Promise<{ id: string } | undefined>;
  run(input: {
    sessionId: string;
    message: string;
    model?: string;
    maxSteps?: number;
    timeoutMs?: number;
  }): AsyncGenerator<AgentEvent>;
  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): { ok: boolean; status: string };
}

export interface CronSchedulerOptions {
  store: CronJobStore;
  agent: CronSchedulerAgent;
  logger?: Logger;
  /** Tick interval in ms (default 1000). */
  tickMs?: number;
  /** Global max concurrent cron runs (default 3). */
  maxConcurrent?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class CronScheduler {
  private readonly store: CronJobStore;
  private readonly agent: CronSchedulerAgent;
  private readonly logger: Logger;
  private readonly tickMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();
  private stopped = true;

  constructor(options: CronSchedulerOptions) {
    this.store = options.store;
    this.agent = options.agent;
    this.logger = options.logger ?? consoleLogger;
    this.tickMs = options.tickMs ?? 1000;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.now = options.now ?? nowMs;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Avoid keeping the process alive solely because of the scheduler in tests.
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Wait briefly for in-flight runs to finish marking status.
    const deadline = this.now() + 5_000;
    while (this.running.size > 0 && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const due = this.store
      .list()
      .filter((job) => job.enabled && job.nextRunAtMs > 0 && job.nextRunAtMs <= now)
      .sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);

    for (const job of due) {
      if (this.stopped) break;
      if (this.running.size >= this.maxConcurrent) break;
      if (job.overlap === "skip" && this.running.has(job.id)) {
        this.store.updateRunResult(job.id, {
          lastRunAtMs: now,
          lastStatus: "skipped",
          lastError: "overlap: previous run still in progress",
          nextRunAtMs: computeNextRunAtMs(job.cron, job.timezone, now),
        });
        continue;
      }
      this.running.add(job.id);
      void this.executeJob(job).finally(() => {
        this.running.delete(job.id);
      });
    }
  }

  private async executeJob(job: CronJobRecord): Promise<void> {
    const startedAt = this.now();
    let runId = "";
    try {
      const sessionId = await this.resolveSessionId(job);
      let status: "ok" | "error" = "ok";
      let error = "";

      for await (const event of this.agent.run({
        sessionId,
        message: job.message,
        model: job.model || undefined,
        maxSteps: job.maxSteps || undefined,
        timeoutMs: job.timeoutMs || undefined,
      })) {
        if (!runId) runId = event.runId;
        if (event.type === "tool.approval_required" && job.autoApprove) {
          this.agent.resolveApproval(event.runId, event.approvalId, "approve");
        }
        if (event.type === "run.error") {
          status = "error";
          error = `${event.code}: ${event.message}`;
        }
      }

      this.store.updateRunResult(job.id, {
        lastRunAtMs: startedAt,
        lastStatus: status,
        lastError: error,
        lastRunId: runId,
        nextRunAtMs: computeNextRunAtMs(job.cron, job.timezone, this.now()),
      });
      this.logger.info("cron job finished", {
        jobId: job.id,
        status,
        runId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateRunResult(job.id, {
        lastRunAtMs: startedAt,
        lastStatus: "error",
        lastError: message,
        lastRunId: runId,
        nextRunAtMs: computeNextRunAtMs(job.cron, job.timezone, this.now()),
      });
      this.logger.error("cron job failed", { jobId: job.id, error: message });
    }
  }

  private async resolveSessionId(job: CronJobRecord): Promise<string> {
    if (job.sessionMode === "ephemeral") {
      const session = await this.agent.createSession({
        systemPrompt: job.systemPrompt || undefined,
        metadata: { cron_job_id: job.id, cron_session_mode: "ephemeral" },
      });
      return session.id;
    }

    if (job.sessionId) {
      const existing = await this.agent.getSession(job.sessionId);
      if (existing) return existing.id;
    }

    const session = await this.agent.createSession({
      systemPrompt: job.systemPrompt || undefined,
      metadata: { cron_job_id: job.id, cron_session_mode: "sticky" },
    });
    this.store.updateSessionId(job.id, session.id);
    return session.id;
  }
}
