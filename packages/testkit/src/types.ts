export type TestMode = "unit" | "e2e" | "live";

export interface FakeLlmToolCall {
  name: string;
  arguments?: Record<string, unknown> | string;
}

export interface FakeLlmStep {
  tool_calls?: FakeLlmToolCall[];
  content?: string;
}

export interface ExpectDef {
  tools_called?: string[];
  final_text_matches?: string[];
  events_include?: string[];
  min_deltas?: number;
  approval_required?: boolean;
}

export interface CaseDef {
  id: string;
  description?: string;
  modes: TestMode[];
  tags?: string[];
  system_prompt?: string;
  prompt: string;
  builtins?: boolean;
  auto_approve?: boolean;
  fake_llm?: FakeLlmStep[];
  expect?: ExpectDef;
  hooks?: {
    before?: string;
    after?: string;
  };
}

export interface AssertionResult {
  name: string;
  ok: boolean;
  message?: string;
}

export interface RunTrace {
  events: string[];
  toolsCalled: string[];
  deltas: string[];
  finalText: string;
  approvalCount: number;
  toolResults: Array<{ toolName: string; resultJson: string; isError: boolean }>;
}

export interface CaseResult {
  id: string;
  mode: TestMode;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  description?: string;
  trace: RunTrace;
  assertions: AssertionResult[];
  logPath?: string;
  error?: { message: string; stack?: string };
}

export type LogFn = (message: string, extra?: Record<string, unknown>) => void;

export interface CaseContext {
  mode: TestMode;
  caseDef: CaseDef;
  workspaceRoot: string;
  vars: Record<string, string>;
  log: LogFn;
  autoApprove: boolean;
  /** Extra local tools registered by hooks (unit/e2e). */
  extraTools: import("@mini-agent/runtime").RegisteredTool[];
}

export interface SuiteReport {
  schema_version: 1;
  started_at: string;
  finished_at: string;
  modes: TestMode[];
  env: {
    model?: string;
    baseUrl?: string;
    miniAgentUrl?: string;
  };
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
  };
  cases: Array<{
    id: string;
    mode: TestMode;
    status: CaseResult["status"];
    duration_ms: number;
    description?: string;
    tools_called: string[];
    events: string[];
    final_text: string;
    delta_chunks: number;
    assertions: AssertionResult[];
    log_path?: string;
    error?: { message: string; stack?: string };
  }>;
}
