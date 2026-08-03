import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteReport } from "../types.js";

export function writeAiReport(outDir: string, report: SuiteReport): string {
  const path = join(outDir, "report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}
