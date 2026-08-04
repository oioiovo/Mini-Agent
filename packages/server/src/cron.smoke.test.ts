import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeLlmClient } from "@mini-agent/runtime";
import { MiniAgentClient } from "@mini-agent/client";
import { createMiniAgentServer } from "./server.js";

describe("cron api smoke", () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upserts lists and deletes cron jobs via client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-cron-api-"));
    dirs.push(dir);
    const cronFile = join(dir, "cron.jobs.yaml");
    writeFileSync(
      cronFile,
      `jobs:\n  - id: from-file\n    cron: "0 9 * * *"\n    message: from file\n    enabled: false\n`,
    );

    const server = await createMiniAgentServer({
      port: 0,
      apiKey: "test-key",
      cronFile,
      cronSqlitePath: join(dir, "cron.sqlite"),
      agentOptions: {
        llm: new FakeLlmClient([
          { content: "ok", toolCalls: [] },
        ]),
        sessionBackend: "memory",
        includeBuiltinTools: false,
        sqlitePath: join(dir, "sessions.sqlite"),
      },
    });

    try {
      const client = new MiniAgentClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "test-key",
      });

      const listed = await client.listCronJobs();
      assert.ok(listed.some((j) => j.id === "from-file"));

      const created = await client.upsertCronJob({
        id: "api-job",
        cron: "*/10 * * * *",
        message: "api hello",
        autoApprove: true,
      });
      assert.equal(created.id, "api-job");
      assert.equal(created.enabled, true);
      assert.equal(created.source, "api");

      const got = await client.getCronJob("api-job");
      assert.equal(got.message, "api hello");

      const disabled = await client.setCronJobEnabled("api-job", false);
      assert.equal(disabled.enabled, false);

      assert.equal(await client.deleteCronJob("api-job"), true);
      assert.equal(await client.deleteCronJob("missing"), false);
    } finally {
      await server.close();
    }
  });
});
