import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteReport } from "../types.js";

export function writeHumanReport(outDir: string, report: SuiteReport): string {
  const lines: string[] = [];
  lines.push(`# Mini-Agent Test Report`);
  lines.push("");
  lines.push(`- Started: ${report.started_at}`);
  lines.push(`- Finished: ${report.finished_at}`);
  lines.push(`- Modes: ${report.modes.join(", ")}`);
  if (report.env.model) lines.push(`- Model: ${report.env.model}`);
  if (report.env.baseUrl) lines.push(`- LLM baseUrl: ${report.env.baseUrl}`);
  if (report.env.miniAgentUrl) lines.push(`- Mini-Agent URL: ${report.env.miniAgentUrl}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(
    `| passed | failed | skipped | duration_ms |`,
  );
  lines.push(`| ---: | ---: | ---: | ---: |`);
  lines.push(
    `| ${report.summary.passed} | ${report.summary.failed} | ${report.summary.skipped} | ${report.summary.duration_ms} |`,
  );
  lines.push("");
  lines.push(`## Cases`);
  lines.push("");

  for (const c of report.cases) {
    const icon = c.status === "passed" ? "PASS" : c.status === "failed" ? "FAIL" : "SKIP";
    lines.push(`### ${c.id} [${c.mode}] — ${icon} (${c.duration_ms}ms)`);
    if (c.description) lines.push("");
    if (c.description) lines.push(c.description);
    lines.push("");
    lines.push(`- Tools: ${c.tools_called.join(", ") || "(none)"}`);
    lines.push(`- Events: ${c.events.join(" → ") || "(none)"}`);
    lines.push(`- Delta chunks: ${c.delta_chunks}`);
    if (c.log_path) lines.push(`- Log: \`${c.log_path}\``);
    if (c.assertions.length) {
      lines.push(`- Assertions:`);
      for (const a of c.assertions) {
        lines.push(`  - ${a.ok ? "ok" : "FAIL"} ${a.name}${a.message ? ` — ${a.message}` : ""}`);
      }
    }
    if (c.error) {
      lines.push(`- Error: ${c.error.message}`);
    }
    if (c.final_text) {
      const preview = c.final_text.length > 240 ? `${c.final_text.slice(0, 240)}…` : c.final_text;
      lines.push("");
      lines.push("```");
      lines.push(preview);
      lines.push("```");
    }
    lines.push("");
  }

  const path = join(outDir, "report.md");
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}
