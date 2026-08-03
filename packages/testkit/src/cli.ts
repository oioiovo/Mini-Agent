#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { runSuite, testkitRoot } from "./runner.js";
import type { TestMode } from "./types.js";

function loadDotEnv(): void {
  const repoRoot = resolve(testkitRoot, "../..");
  for (const path of [resolve(process.cwd(), ".env"), resolve(repoRoot, ".env")]) {
    if (existsSync(path)) {
      loadEnv({ path, override: true });
      return;
    }
  }
}

function parseArgs(argv: string[]): {
  modes: TestMode[];
  only: string[] | null;
  tags: string[] | null;
  list: boolean;
  help: boolean;
  out?: string;
} {
  const modes: TestMode[] = [];
  const only = new Set<string>();
  const tags = new Set<string>();
  let list = false;
  let help = false;
  let out: string | undefined;
  let modeFlag = false;
  let onlyFlag = false;
  let tagsFlag = false;
  let outFlag = false;

  for (const raw of argv) {
    if (raw === "--") continue;
    if (raw === "--help" || raw === "-h") {
      help = true;
      continue;
    }
    if (raw === "--list" || raw === "-l") {
      list = true;
      continue;
    }
    if (raw === "--mode") {
      modeFlag = true;
      continue;
    }
    if (raw.startsWith("--mode=")) {
      for (const m of raw.slice("--mode=".length).split(",")) pushMode(modes, m.trim());
      continue;
    }
    if (raw === "--only") {
      onlyFlag = true;
      continue;
    }
    if (raw.startsWith("--only=")) {
      for (const id of raw.slice("--only=".length).split(",")) {
        if (id.trim()) only.add(id.trim());
      }
      continue;
    }
    if (raw === "--tags") {
      tagsFlag = true;
      continue;
    }
    if (raw.startsWith("--tags=")) {
      for (const t of raw.slice("--tags=".length).split(",")) {
        if (t.trim()) tags.add(t.trim());
      }
      continue;
    }
    if (raw === "--out") {
      outFlag = true;
      continue;
    }
    if (raw.startsWith("--out=")) {
      out = raw.slice("--out=".length);
      continue;
    }
    if (modeFlag) {
      for (const m of raw.split(",")) pushMode(modes, m.trim());
      modeFlag = false;
      continue;
    }
    if (onlyFlag) {
      for (const id of raw.split(",")) if (id.trim()) only.add(id.trim());
      onlyFlag = false;
      continue;
    }
    if (tagsFlag) {
      for (const t of raw.split(",")) if (t.trim()) tags.add(t.trim());
      tagsFlag = false;
      continue;
    }
    if (outFlag) {
      out = raw;
      outFlag = false;
      continue;
    }
    if (raw.startsWith("-")) throw new Error(`Unknown flag: ${raw}`);
    only.add(raw);
  }

  return {
    modes: modes.length ? modes : ["unit"],
    only: only.size ? [...only] : null,
    tags: tags.size ? [...tags] : null,
    list,
    help,
    out,
  };
}

function pushMode(modes: TestMode[], raw: string): void {
  if (!raw) return;
  for (const part of raw.split(/[,\s]+/)) {
    const m = part.trim();
    if (!m) continue;
    if (m !== "unit" && m !== "e2e" && m !== "live") {
      throw new Error(`Unknown mode: ${m}`);
    }
    if (!modes.includes(m)) modes.push(m);
  }
}

function printHelp(): void {
  console.log(`Usage:
  pnpm testkit -- --mode unit,e2e
  pnpm testkit -- --mode live --only calculator
  pnpm testkit -- --list

Flags:
  --mode unit|e2e|live[,...]   Execution mode(s) (default: unit)
  --only <id>[,id...]          Run selected case ids
  --tags <tag>[,...]           Filter by tags
  --out <dir>                  Artifacts directory
  --list                       List cases
  --help                       Show help
`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.list) {
    const { exitCode } = await runSuite({
      modes: args.modes.includes("live") && args.modes.length === 1 ? ["unit", "e2e", "live"] : args.modes,
      only: args.only,
      tags: args.tags,
      listOnly: true,
    });
    process.exitCode = exitCode;
    return;
  }

  if (args.modes.includes("live")) {
    if (process.env.MINI_AGENT_LIVE_TEST !== "1" && process.env.MINI_AGENT_LIVE_TEST !== "true") {
      console.log("Skip live mode (set MINI_AGENT_LIVE_TEST=1 to enable).");
      if (args.modes.length === 1) return;
      args.modes = args.modes.filter((m) => m !== "live");
    }
  }

  if (!args.modes.length) {
    console.log("No modes to run.");
    return;
  }

  const { exitCode } = await runSuite({
    modes: args.modes,
    only: args.only,
    tags: args.tags,
    outDir: args.out,
    listOnly: args.list,
  });
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
