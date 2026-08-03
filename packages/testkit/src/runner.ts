import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./load-cases.js";
import { loadHooks } from "./hooks.js";
import { runExpect } from "./expect.js";
import { createCaseLogger } from "./report/logger.js";
import { writeAiReport } from "./report/write-ai.js";
import { writeHumanReport } from "./report/write-human.js";
import { runUnitCase } from "./modes/unit.js";
import { runE2eCase } from "./modes/e2e.js";
import { runLiveCase } from "./modes/live.js";
import type {
  CaseContext,
  CaseDef,
  CaseResult,
  SuiteReport,
  TestMode,
} from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const testkitRoot = resolve(here, "..");
export const defaultCasesDir = resolve(testkitRoot, "cases");

export interface RunnerOptions {
  modes: TestMode[];
  only?: string[] | null;
  tags?: string[] | null;
  casesDir?: string;
  outDir?: string;
  listOnly?: boolean;
}

function caseFileDir(casesDir: string, _caseDef: CaseDef): string {
  return casesDir;
}

export async function runSuite(options: RunnerOptions): Promise<{
  report: SuiteReport;
  outDir: string;
  exitCode: number;
}> {
  const casesDir = options.casesDir ?? defaultCasesDir;
  const all = loadCases(casesDir);

  if (options.listOnly) {
    for (const c of all) {
      console.log(`${c.id}\t[${c.modes.join(",")}]\t${c.description ?? ""}`);
    }
    const empty = emptyReport(options.modes);
    return { report: empty, outDir: "", exitCode: 0 };
  }

  const selected = all.filter((c) => {
    if (options.only?.length && !options.only.includes(c.id)) return false;
    if (options.tags?.length && !options.tags.some((t) => c.tags?.includes(t))) {
      return false;
    }
    return c.modes.some((m) => options.modes.includes(m));
  });

  if (options.only?.length) {
    const known = new Set(all.map((c) => c.id));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown case id(s): ${unknown.join(", ")}`);
  }

  const startedAt = new Date();
  const outDir =
    options.outDir ??
    resolve(
      testkitRoot,
      "../../artifacts/test-runs",
      startedAt.toISOString().replace(/[:.]/g, "-"),
    );
  mkdirSync(outDir, { recursive: true });

  const results: CaseResult[] = [];
  const clientAutoApprove =
    process.env.MINI_AGENT_EXAMPLE_AUTO_APPROVE !== "false" &&
    process.env.MINI_AGENT_EXAMPLE_AUTO_APPROVE !== "0";

  for (const mode of options.modes) {
    const modeCases = selected.filter((c) => c.modes.includes(mode));
    for (const caseDef of modeCases) {
      const result = await runOneCase({
        caseDef,
        mode,
        casesDir,
        outDir,
        clientAutoApprove,
      });
      results.push(result);
      const label = `${caseDef.id}[${mode}]`;
      if (result.status === "passed") {
        console.log(`→ ${label} … ok (${result.durationMs}ms)`);
      } else {
        console.log(`→ ${label} … FAIL (${result.durationMs}ms)`);
        if (result.error) console.error(`  ${result.error.message}`);
      }
    }
  }

  const finishedAt = new Date();
  const report: SuiteReport = {
    schema_version: 1,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    modes: options.modes,
    env: {
      model: process.env.OPENAI_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
      miniAgentUrl: process.env.MINI_AGENT_URL ?? "http://127.0.0.1:8787",
    },
    summary: {
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
    },
    cases: results.map((r) => ({
      id: r.id,
      mode: r.mode,
      status: r.status,
      duration_ms: r.durationMs,
      description: r.description,
      tools_called: r.trace.toolsCalled,
      events: r.trace.events,
      final_text: r.trace.finalText,
      delta_chunks: r.trace.deltas.length,
      assertions: r.assertions,
      log_path: r.logPath,
      error: r.error,
    })),
  };

  const md = writeHumanReport(outDir, report);
  const json = writeAiReport(outDir, report);
  console.log(`report: ${md}`);
  console.log(`report: ${json}`);

  return {
    report,
    outDir,
    exitCode: report.summary.failed > 0 ? 1 : 0,
  };
}

async function runOneCase(input: {
  caseDef: CaseDef;
  mode: TestMode;
  casesDir: string;
  outDir: string;
  clientAutoApprove: boolean;
}): Promise<CaseResult> {
  const { caseDef, mode, casesDir, outDir, clientAutoApprove } = input;
  const started = Date.now();
  const logger = createCaseLogger(outDir, caseDef.id, mode);
  logger.flushHeader();

  const repoRoot = resolve(testkitRoot, "../..");
  const liveWorkspace = resolve(
    repoRoot,
    process.env.MINI_AGENT_WORKSPACE?.trim() || "workspace",
  );
  const workspaceRoot =
    mode === "live" ? liveWorkspace : mkdtempSync(join(tmpdir(), `mini-agent-${caseDef.id}-`));
  if (mode === "live") mkdirSync(liveWorkspace, { recursive: true });
  const ctx: CaseContext = {
    mode,
    caseDef,
    workspaceRoot,
    vars: {},
    log: logger.log,
    autoApprove: clientAutoApprove,
    extraTools: [],
  };

  let result: CaseResult = {
    id: caseDef.id,
    mode,
    status: "passed",
    durationMs: 0,
    description: caseDef.description,
    trace: {
      events: [],
      toolsCalled: [],
      deltas: [],
      finalText: "",
      approvalCount: 0,
      toolResults: [],
    },
    assertions: [],
    logPath: logger.logPath,
  };

  try {
    const hooks = await loadHooks(caseFileDir(casesDir, caseDef), caseDef.hooks);
    if (hooks.before) await hooks.before(ctx);

    const trace =
      mode === "unit"
        ? await runUnitCase(ctx)
        : mode === "e2e"
          ? await runE2eCase(ctx)
          : await runLiveCase(ctx);

    result.trace = trace;
    result.assertions = runExpect(caseDef.expect, trace);
    const failedAssert = result.assertions.find((a) => !a.ok);
    if (failedAssert) {
      result.status = "failed";
      result.error = { message: failedAssert.message ?? failedAssert.name };
    }

    if (hooks.after) await hooks.after(ctx, result);
    // Re-check if after hook marked failure
    if (result.status === "failed" && !result.error) {
      result.error = { message: "failed in after hook" };
    }
  } catch (err) {
    result.status = "failed";
    result.error = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    ctx.log("case.error", { message: result.error.message });
  }

  result.durationMs = Date.now() - started;
  ctx.log("case.end", { status: result.status, durationMs: result.durationMs });
  return result;
}

function emptyReport(modes: TestMode[]): SuiteReport {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    started_at: now,
    finished_at: now,
    modes,
    env: {},
    summary: { passed: 0, failed: 0, skipped: 0, duration_ms: 0 },
    cases: [],
  };
}
