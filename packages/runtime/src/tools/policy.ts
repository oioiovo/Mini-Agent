export type ToolRisk = "read" | "write" | "network" | "exec";

export type PolicyDecision = "allow" | "require_approval" | "deny";

export interface ToolPolicyInput {
  name: string;
  risk?: ToolRisk;
  requiresApproval?: boolean;
  sideEffect?: boolean;
  source?: "local" | "http" | "mcp";
  argumentsJson?: string;
}

export interface ToolPolicyOptions {
  autoApprove?: boolean;
  denyToolNames?: string[];
}

export interface ToolPolicyResult {
  decision: PolicyDecision;
  risk: ToolRisk;
  reason: string;
}

export function inferRisk(input: ToolPolicyInput): ToolRisk {
  if (input.risk) return input.risk;
  if (input.source === "mcp" || input.name.startsWith("mcp.")) return "exec";
  if (input.source === "http") return "network";
  if (input.sideEffect) return "write";
  return "read";
}

export class ToolPolicy {
  private readonly autoApprove: boolean;
  private readonly denyToolNames: Set<string>;

  constructor(options: ToolPolicyOptions = {}) {
    this.autoApprove =
      options.autoApprove ??
      (process.env.MINI_AGENT_AUTO_APPROVE === "true" ||
        process.env.MINI_AGENT_AUTO_APPROVE === "1");
    this.denyToolNames = new Set(options.denyToolNames ?? []);
  }

  evaluate(input: ToolPolicyInput): ToolPolicyResult {
    const risk = inferRisk(input);

    if (this.denyToolNames.has(input.name)) {
      return {
        decision: "deny",
        risk,
        reason: `Tool ${input.name} is denied by policy`,
      };
    }

    if (this.autoApprove) {
      return {
        decision: "allow",
        risk,
        reason: "MINI_AGENT_AUTO_APPROVE enabled",
      };
    }

    if (input.requiresApproval || risk === "write" || risk === "network" || risk === "exec") {
      return {
        decision: "require_approval",
        risk,
        reason: input.requiresApproval
          ? "Tool declares requiresApproval"
          : `Tool risk level is ${risk}`,
      };
    }

    return {
      decision: "allow",
      risk,
      reason: "Read tool auto-allowed",
    };
  }
}
