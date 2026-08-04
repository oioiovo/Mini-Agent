import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  computeNextRunAtMs,
  CronScheduler,
  loadCronConfigFile,
  parseCronConfigText,
  SqliteCronJobStore,
  syncCronJobsFromConfig,
  type AgentEvent,
  type CronSchedulerAgent,
} from "../index.js";

describe("cron parse", () => {
  it("computes a next run after fromMs", () => {
    const from = Date.parse("2026-01-01T00:00:00.000Z");
    const next = computeNextRunAtMs("0 * * * *", "UTC", from);
    assert.equal(next, Date.parse("2026-01-01T01:00:00.000Z"));
  });

  it("rejects invalid cron", () => {
    assert.throws(() => computeNextRunAtMs("not-a-cron", "UTC"), /Invalid cron/);
  });
});

describe("cron config", () => {
  it("parses yaml jobs", () => {
    const jobs = parseCronConfigText(`
jobs:
  - id: dig
    cron: "0 9 * * *"
    timezone: Asia/Shanghai
    message: hello
    auto_approve: true
`);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.id, "dig");
    assert.equal(jobs[0]?.autoApprove, true);
  });

  it("syncs file jobs and deletes removed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-cron-cfg-"));
    const dbPath = join(dir, "cron.sqlite");
    const store = new SqliteCronJobStore(dbPath);
    try {
      store.upsert({
        id: "gone",
        cron: "0 1 * * *",
        message: "old",
        source: "file",
      });
      store.upsert({
        id: "api-keep",
        cron: "0 2 * * *",
        message: "api",
        source: "api",
      });
      const file = join(dir, "cron.jobs.yaml");
      writeFileSync(
        file,
        `jobs:\n  - id: stay\n    cron: "0 3 * * *"\n    message: stay\n`,
      );
      const { upserted, deleted } = syncCronJobsFromConfig(store, loadCronConfigFile(file));
      assert.equal(upserted.length, 1);
      assert.equal(deleted, 1);
      assert.ok(store.get("stay"));
      assert.equal(store.get("gone"), undefined);
      assert.ok(store.get("api-keep"));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cron store", () => {
  it("upserts get lists and toggles enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-cron-store-"));
    const store = new SqliteCronJobStore(join(dir, "cron.sqlite"));
    try {
      const created = store.upsert({
        cron: "*/5 * * * *",
        message: "tick",
        timezone: "UTC",
      });
      assert.ok(created.id);
      assert.equal(created.enabled, true);
      assert.ok(created.nextRunAtMs > 0);

      const listed = store.list();
      assert.equal(listed.length, 1);

      const disabled = store.setEnabled(created.id, false);
      assert.equal(disabled.enabled, false);
      assert.equal(store.delete(created.id), true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cron scheduler", () => {
  it("fires due jobs and skips overlap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-cron-sched-"));
    const store = new SqliteCronJobStore(join(dir, "cron.sqlite"));
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const gate = {
      waiters: [] as Array<() => void>,
      wait() {
        return new Promise<void>((resolve) => this.waiters.push(resolve));
      },
      release() {
        for (const w of this.waiters.splice(0)) w();
      },
    };

    const agent: CronSchedulerAgent = {
      async createSession() {
        return { id: "sess-1" };
      },
      async getSession(id) {
        return { id };
      },
      async *run(): AsyncGenerator<AgentEvent> {
        const runId = "run-1";
        yield {
          type: "run.started",
          runId,
          sessionId: "sess-1",
          model: "fake",
          timestampMs: clock,
        };
        await gate.wait();
        yield {
          type: "run.completed",
          runId,
          sessionId: "sess-1",
          finalText: "done",
          steps: 1,
          timestampMs: clock,
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
      now: () => clock,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    });

    try {
      const job = store.upsert({
        id: "j1",
        cron: "* * * * *",
        message: "hi",
        timezone: "UTC",
      });
      // Make it due now
      store.updateRunResult(job.id, {
        lastRunAtMs: 0,
        lastStatus: "",
        nextRunAtMs: clock,
      });

      scheduler.start();
      await scheduler.tick();
      // Let executeJob reach the approval/run gate
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(store.get(job.id)!.sessionId, "sess-1");

      // Second tick while first still running → skipped
      clock += 60_000;
      store.updateRunResult(job.id, {
        lastRunAtMs: 0,
        lastStatus: "",
        nextRunAtMs: clock,
      });
      await scheduler.tick();
      const afterSkip = store.get(job.id)!;
      assert.equal(afterSkip.lastStatus, "skipped");

      gate.release();
      // Allow executeJob to finish
      await new Promise((r) => setTimeout(r, 30));
      const finished = store.get(job.id)!;
      assert.equal(finished.lastStatus, "ok");
      assert.equal(finished.lastRunId, "run-1");
      assert.equal(finished.sessionId, "sess-1");
    } finally {
      gate.release();
      await scheduler.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
