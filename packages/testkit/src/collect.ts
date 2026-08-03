import type { AgentEvent } from "@mini-agent/runtime";
import type { ClientAgentEvent } from "@mini-agent/sdk";
import type { CaseContext, LogFn, RunTrace } from "./types.js";

function emptyTrace(): RunTrace {
  return {
    events: [],
    toolsCalled: [],
    deltas: [],
    finalText: "",
    approvalCount: 0,
    toolResults: [],
  };
}

export function createTrace(): RunTrace {
  return emptyTrace();
}

export function ingestRuntimeEvent(trace: RunTrace, event: AgentEvent, log: LogFn): void {
  switch (event.type) {
    case "run.started":
      trace.events.push("runStarted");
      log("run.started", { model: event.model });
      break;
    case "message.delta":
      trace.events.push("textDelta");
      break;
    case "tool.started":
      trace.events.push("toolCall");
      trace.toolsCalled.push(event.toolName);
      log("tool →", { tool: event.toolName, args: event.argumentsJson });
      break;
    case "tool.completed":
      trace.events.push("toolResult");
      trace.toolResults.push({
        toolName: event.toolName,
        resultJson: event.resultJson,
        isError: event.isError,
      });
      log("tool ←", { tool: event.toolName, isError: event.isError });
      break;
    case "tool.result_delta":
      trace.events.push("toolResultDelta");
      trace.deltas.push(event.chunk);
      log("tool delta", { tool: event.toolName, bytes: event.chunk.length });
      break;
    case "tool.approval_required":
      trace.events.push("toolApprovalRequired");
      trace.approvalCount += 1;
      log("approval?", { tool: event.toolName, risk: event.risk });
      break;
    case "memory.hit":
      trace.events.push("memoryHit");
      break;
    case "run.completed":
      trace.events.push("runCompleted");
      trace.finalText = event.finalText;
      log("run.completed", { chars: event.finalText.length });
      break;
    case "run.error":
      trace.events.push("runError");
      log("run.error", { code: event.code, message: event.message });
      throw new Error(`${event.code}: ${event.message}`);
  }
}

export async function ingestClientEvent(
  ctx: CaseContext,
  trace: RunTrace,
  event: ClientAgentEvent,
  resolveApproval: (input: {
    runId: string;
    approvalId: string;
    decision: "approve" | "deny";
  }) => Promise<{ ok: boolean; status: string }>,
): Promise<void> {
  if (event.payload.case) trace.events.push(event.payload.case);

  switch (event.payload.case) {
    case "toolCall":
      trace.toolsCalled.push(event.payload.value.toolName);
      ctx.log("tool →", {
        tool: event.payload.value.toolName,
        args: event.payload.value.argumentsJson,
      });
      break;
    case "toolResult":
      trace.toolResults.push({
        toolName: event.payload.value.toolName,
        resultJson: event.payload.value.resultJson,
        isError: event.payload.value.isError,
      });
      ctx.log("tool ←", {
        tool: event.payload.value.toolName,
        isError: event.payload.value.isError,
      });
      break;
    case "toolResultDelta":
      trace.deltas.push(event.payload.value.chunk);
      ctx.log("tool delta", { bytes: event.payload.value.chunk.length });
      break;
    case "toolApprovalRequired": {
      trace.approvalCount += 1;
      ctx.log("approval?", {
        tool: event.payload.value.toolName,
        risk: event.payload.value.risk,
      });
      if (!ctx.autoApprove) {
        throw new Error(
          `approval required for ${event.payload.value.toolName} but autoApprove is disabled`,
        );
      }
      const res = await resolveApproval({
        runId: event.runId,
        approvalId: event.payload.value.approvalId,
        decision: "approve",
      });
      if (!res.ok) throw new Error(`ResolveToolApproval failed: ${res.status}`);
      ctx.log("approval →", { status: res.status });
      break;
    }
    case "runCompleted":
      trace.finalText = event.payload.value.finalText;
      ctx.log("run.completed", { chars: event.payload.value.finalText.length });
      break;
    case "runError":
      ctx.log("run.error", {
        code: event.payload.value.code,
        message: event.payload.value.message,
      });
      throw new Error(`${event.payload.value.code}: ${event.payload.value.message}`);
    default:
      break;
  }
}
