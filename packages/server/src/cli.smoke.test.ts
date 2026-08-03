import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { findRepoRoot } from "./paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPkg = resolve(here, "..");

async function collectUntil(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}\n--- output ---\n${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        cleanup();
        resolvePromise(buffer);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((r) => child.once("exit", () => r()));
}

describe("cli smoke", () => {
  it("starts via dist/cli.js and reports the configured workspace", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "mini-agent-cli-"));
    const workspace = join(fixture, "workspace");
    const dataDir = join(fixture, "data");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "notes.txt"), "hello from cli smoke\n");

    const child = spawn(process.execPath, ["dist/cli.js", "serve", "--port", "0"], {
      cwd: serverPkg,
      env: {
        ...process.env,
        MINI_AGENT_API_KEY: "smoke-key",
        MINI_AGENT_WORKSPACE: workspace,
        MINI_AGENT_DATA_DIR: dataDir,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const output = await collectUntil(
        child,
        /Mini-Agent listening on http:\/\/127\.0\.0\.1:(\d+)[\s\S]*workspace=/,
      );
      const port = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      assert.ok(port, "expected bound port in CLI output");
      assert.ok(
        output.includes(`workspace=${workspace}`),
        `expected workspace=${workspace} in:\n${output}`,
      );

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
    } finally {
      await stop(child);
    }
  });

  it("treats relative ./workspace as monorepo-root workspace, not packages/server/workspace", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "mini-agent-repo-"));
    writeFileSync(join(fixtureRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    const nestedCwd = join(fixtureRoot, "packages", "server");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(join(fixtureRoot, "workspace"), { recursive: true });

    const root = findRepoRoot([nestedCwd]);
    assert.equal(root, resolve(fixtureRoot));

    const fromRepo = resolve(root, "./workspace");
    const fromPackageCwd = resolve(nestedCwd, "./workspace");
    assert.equal(fromRepo, join(fixtureRoot, "workspace"));
    assert.notEqual(fromRepo, fromPackageCwd);
  });
});
