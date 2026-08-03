import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CaseContext } from "../src/types.js";

export async function before(ctx: CaseContext): Promise<void> {
  mkdirSync(ctx.workspaceRoot, { recursive: true });
  const relative = "live-fixture.txt";
  const marker = "LIVE_FIXTURE_MARKER_7f3a";
  const line = `Mini-Agent live fixture ${marker}. pad=${"x".repeat(64)}\n`;
  let body = "";
  let i = 1;
  while (Buffer.byteLength(body, "utf8") < 16 * 1024) {
    body += `${i}. ${line}`;
    i += 1;
  }
  writeFileSync(resolve(ctx.workspaceRoot, relative), body, "utf8");
  ctx.vars.fixture_path = relative;
  ctx.vars.fixture_marker = marker;
  ctx.log("fixture.ready", { path: relative, bytes: Buffer.byteLength(body, "utf8") });
}
