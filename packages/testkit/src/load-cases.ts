import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseCase } from "./schema.js";
import type { CaseDef } from "./types.js";

function walkYamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkYamlFiles(full));
    else if (name.endsWith(".yaml") || name.endsWith(".yml")) out.push(full);
  }
  return out;
}

export function loadCases(casesDir: string): CaseDef[] {
  const files = walkYamlFiles(casesDir).sort();
  const cases = files.map((file) => {
    const raw = parseYaml(readFileSync(file, "utf8"));
    return parseCase(raw, file);
  });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate case id: ${c.id}`);
    ids.add(c.id);
  }
  return cases;
}
