import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogFn } from "../types.js";

export function createCaseLogger(
  outDir: string,
  caseId: string,
  mode: string,
): {
  log: LogFn;
  logPath: string;
  flushHeader: () => void;
} {
  const logsDir = join(outDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `${caseId}.${mode}.log`);
  writeFileSync(logPath, "", "utf8");

  const log: LogFn = (message: string, extra?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    appendFileSync(logPath, `[${ts}] ${message}${suffix}\n`, "utf8");
  };

  return {
    log,
    logPath,
    flushHeader: () => log("case.start", { caseId, mode }),
  };
}
