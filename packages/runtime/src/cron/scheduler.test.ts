import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../types.js";
import { CronScheduler, type CronSchedulerAgent } from "./scheduler.js";
import type { CronJobStore } from "./store.js";
import type { CronJobRecord, CronJobUpsertInput, CronLastStatus } from "./types.js";
import { computeNextRunAtMs } from "./types.js";

function memoryStore(seed: CronJobRecord[] = []): CronJobStore {
  const jobs = new Map(seed.map((j) => [j.id, { ...j }]));
  return {
    upsert(input: CronJobUpsertInput) {
      const now = Date.now();
      const id = input.id ?? "auto";
      const existing = jobs.get(id);
      const record: CronJobRecord = {
        id,
        cron: input.cron,
        timezone: input.timezone ?? "UTC",
        message: input.message,
        systemPrompt: input.systemPrompt ?? "",
        sessionMode: input.sessionMode === "ephemeral" ? "ephemeral" : "sticky",
        sessionId: input.sessionId ?? existing?.sessionId ?? "",
        model: input.model ?? "",
        maxSteps: input.maxSteps ?? 0,
        timeoutMs: input.timeoutMs ?? 0,
        enabled: input.enabled ?? true,
        autoApprove: input.autoApprove ?? false,
        overlap: "skip",
        source: input.source ?? "api",
        lastRunAtMs: existing?.lastRunAtMs ?? 0,
        lastStatus: existing?.lastStatus ?? "",
        lastError: existing?.lastError ?? "",
        lastRunId: existing?.lastRunId ?? "",
        nextRunAtMs: computeNextRunAtMs(input.cron, input.timezone ?? "UTC", now),
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
      };
      jobs.set(id, record);
      return { ...record };
    },
    get(id) {
      const job = jobs.get(id);
      return job ? { ...job } : undefined;
    },
    list() {
      return [...jobs.values()].map((j) => ({ ...j }));
    },
    delete(id) {
      return jobs.delete(id);
    },
    setEnabled(id, enabled) {
      const job = jobs.get(id);
      if (!job) throw new Error("missing");
      job.enabled = enabled;
      job.updatedAtMs = Date.now();
      return { ...job };
    },
    updateSessionId(id, sessionId) {
      const job = jobs.get(id)!;
      job.sessionId = sessionId;
      return { ...job };
    },
    updateRunResult(id, patch) {
      const job = jobs.get(id)!;
      job.lastRunAtMs = patch.lastRunAtMs;
      job.lastStatus = patch.lastStatus;
      job.lastError = patch.lastError ?? "";
      job.lastRunId = patch.lastRunId ?? "";
      if (patch.nextRunAtMs !== undefined) job.nextRunAtMs = patch.nextRunAtMs;
      return { ...job };
    },
    deleteBySourceExcept() {
      return 0;
    },
    close() {},
  };
}

describe("cron scheduler", () => {
  it("skips overlap when previous run is still in progress", async () => {
    let now = Date.parse("2026-08-04T09:00:00.000Z");
    const store = memoryStore([
      {
        id: "slow",
        cron: "* * * * *",
        timezone: "UTC",
        message: "hi",
        systemPrompt: "",
        sessionMode: "sticky",
        sessionId: "",
        model: "",
        maxSteps: 0,
        timeoutMs: 0,
        enabled: true,
        autoApprove: false,
        overlap: "skip",
        source: "api",
        lastRunAtMs: 0,
        lastStatus: "" as CronLastStatus,
        lastError: "",
        lastRunId: "",
        nextRunAtMs: now,
        createdAtMs: now,
        updatedAtMs: now,
      },
    ]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;

    const agent: CronSchedulerAgent = {
      async createSession() {
        return { id: "sess-1" };
      },
      async getSession() {
        return { id: "sess-1" };
      },
      async *run(): AsyncGenerator<AgentEvent> {
        runs += 1;
        yield {
          type: "run.started",
          runId: `run-${runs}`,
          sessionId: "sess-1",
          model: "fake",
          timestampMs: now,
        };
        await gate;
        yield {
          type: "run.completed",
          runId: `run-${runs}`,
          sessionId: "sess-1",
          finalText: "done",
          steps: 1,
          timestampMs: now,
        };
      },
      resolveApproval() {
        return { ok: true, status: "approved" };
      },
    };

    const scheduler = new CronScheduler({
      store,
      agent,
      tickMs: 60_000,
      now: () => now,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    });

    await scheduler.tick();
    assert.equal(runs, 1);

    now += 60_000;
    store.get("slow")!.nextRunAtMs = now;
    // Force due again while first still running.
    const job = store.get("slow")!;
    store.updateRunResult("slow", {
      lastRunAtMs: job.lastRunAtMs,
      lastStatus: job.lastStatus,
      nextRunAtMs: now,
    });

    await scheduler.tick();
    const afterSkip = store.get("slow")!;
    assert.equal(afterSkip.lastStatus, "skipped");
    assert.equal(runs, 1);

    release();
    await new Promise((r) => setTimeout(r, 20));
    await scheduler.stop();
  });
});
