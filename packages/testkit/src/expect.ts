import type { AssertionResult, ExpectDef, RunTrace } from "./types.js";

export function runExpect(expect: ExpectDef | undefined, trace: RunTrace): AssertionResult[] {
  if (!expect) return [];
  const results: AssertionResult[] = [];

  if (expect.tools_called) {
    for (const name of expect.tools_called) {
      const ok = trace.toolsCalled.includes(name);
      results.push({
        name: `tools_called:${name}`,
        ok,
        message: ok ? undefined : `expected tool ${name}, got [${trace.toolsCalled.join(",")}]`,
      });
    }
  }

  if (expect.final_text_matches) {
    for (const pattern of expect.final_text_matches) {
      const re = new RegExp(pattern);
      const blob = `${trace.finalText}\n${trace.deltas.join("")}`;
      const ok = re.test(blob);
      results.push({
        name: `final_text_matches:/${pattern}/`,
        ok,
        message: ok ? undefined : `pattern /${pattern}/ not found in final text/deltas`,
      });
    }
  }

  if (expect.events_include) {
    for (const ev of expect.events_include) {
      const ok = trace.events.includes(ev);
      results.push({
        name: `events_include:${ev}`,
        ok,
        message: ok ? undefined : `expected event ${ev}, got [${trace.events.join(",")}]`,
      });
    }
  }

  if (typeof expect.min_deltas === "number") {
    const ok = trace.deltas.length >= expect.min_deltas;
    results.push({
      name: `min_deltas:${expect.min_deltas}`,
      ok,
      message: ok
        ? undefined
        : `expected >= ${expect.min_deltas} delta chunks, got ${trace.deltas.length}`,
    });
  }

  if (typeof expect.approval_required === "boolean") {
    const has = trace.approvalCount > 0 || trace.events.includes("toolApprovalRequired");
    const ok = expect.approval_required ? has : !has;
    results.push({
      name: `approval_required:${expect.approval_required}`,
      ok,
      message: ok
        ? undefined
        : expect.approval_required
          ? "expected toolApprovalRequired event"
          : "did not expect approval",
    });
  }

  return results;
}
