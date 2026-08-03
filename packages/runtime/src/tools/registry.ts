import type {
  JsonSchema,
  ToolContext,
  ToolDefinition,
} from "../types.js";
import { toErrorMessage } from "../utils.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown> | unknown;

export interface RegisteredTool extends ToolDefinition {
  execute: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  upsert(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  removeByPrefix(prefix: string): void {
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) this.tools.delete(name);
    }
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(
      ({ execute: _execute, ...def }) => def,
    );
  }

  async execute(
    name: string,
    argumentsJson: string,
    ctx: ToolContext,
  ): Promise<{ resultJson: string; isError: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        resultJson: JSON.stringify({ error: `Unknown tool: ${name}` }),
        isError: true,
      };
    }
    if (tool.requiresApproval) {
      return {
        resultJson: JSON.stringify({
          error: "Tool requires approval and no approver is configured",
        }),
        isError: true,
      };
    }
    try {
      let args: Record<string, unknown> = {};
      if (argumentsJson.trim()) {
        const parsed = JSON.parse(argumentsJson) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          return {
            resultJson: JSON.stringify({ error: "Tool arguments must be an object" }),
            isError: true,
          };
        }
      }
      const result = await tool.execute(args, ctx);
      return {
        resultJson: JSON.stringify(result ?? null),
        isError: false,
      };
    } catch (err) {
      return {
        resultJson: JSON.stringify({ error: toErrorMessage(err) }),
        isError: true,
      };
    }
  }
}

export function defineLocalTool(options: {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  sideEffect?: boolean;
  requiresApproval?: boolean;
  execute: ToolHandler;
}): RegisteredTool {
  return {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema ?? { type: "object", properties: {} },
    source: "local",
    sideEffect: options.sideEffect ?? false,
    requiresApproval: options.requiresApproval ?? false,
    execute: options.execute,
  };
}

export function defineHttpTool(options: {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  url: string;
  headers?: Record<string, string>;
  sideEffect?: boolean;
  requiresApproval?: boolean;
}): RegisteredTool {
  return {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema ?? { type: "object", properties: {} },
    source: "http",
    sideEffect: options.sideEffect ?? true,
    requiresApproval: options.requiresApproval ?? false,
    async execute(args, ctx) {
      const response = await fetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify({
          arguments: args,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
        }),
        signal: ctx.abortSignal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP tool ${options.name} failed: ${response.status} ${text}`);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { raw: text };
      }
    },
  };
}
