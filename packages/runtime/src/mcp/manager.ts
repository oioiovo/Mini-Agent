import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "../types.js";
import { defineLocalTool, type RegisteredTool, type ToolRegistry } from "../tools/registry.js";
import { consoleLogger, toErrorMessage } from "../utils.js";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse" | "http";
  endpoint: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  toolNames: string[];
}

export class McpManager {
  private readonly servers = new Map<string, ConnectedServer>();

  constructor(
    private readonly tools: ToolRegistry,
    private readonly logger: Logger = consoleLogger,
  ) {}

  list(): McpServerConfig[] {
    return [...this.servers.values()].map((s) => s.config);
  }

  async upsert(config: McpServerConfig): Promise<number> {
    await this.remove(config.name);

    const client = new Client(
      { name: "mini-agent", version: "0.1.0" },
      { capabilities: {} },
    );

    const transport = this.createTransport(config);
    await client.connect(transport);

    const listed = await client.listTools();
    const registered: string[] = [];
    const prefix = `mcp.${config.name}.`;

    for (const tool of listed.tools) {
      const name = `${prefix}${tool.name}`;
      const registeredTool = defineLocalTool({
        name,
        description: tool.description ?? `MCP tool ${tool.name} from ${config.name}`,
        inputSchema: (tool.inputSchema as RegisteredTool["inputSchema"]) ?? {
          type: "object",
          properties: {},
        },
        sideEffect: true,
        execute: async (args, ctx) => {
          const result = await client.callTool(
            {
              name: tool.name,
              arguments: args,
            },
            undefined,
            { signal: ctx.abortSignal },
          );
          return result;
        },
      });
      const mcpTool: RegisteredTool = { ...registeredTool, source: "mcp" };
      this.tools.upsert(mcpTool);
      registered.push(name);
    }

    this.servers.set(config.name, {
      config,
      client,
      toolNames: registered,
    });
    this.logger.info("MCP server connected", {
      name: config.name,
      toolCount: registered.length,
    });
    return registered.length;
  }

  async remove(name: string): Promise<void> {
    const existing = this.servers.get(name);
    if (!existing) return;
    this.tools.removeByPrefix(`mcp.${name}.`);
    try {
      await existing.client.close();
    } catch (err) {
      this.logger.warn("Failed to close MCP client", {
        name,
        error: toErrorMessage(err),
      });
    }
    this.servers.delete(name);
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      await this.remove(name);
    }
  }

  private createTransport(config: McpServerConfig) {
    if (config.transport === "stdio") {
      return new StdioClientTransport({
        command: config.endpoint,
        args: config.args ?? [],
        env: config.env,
      });
    }
    if (config.transport === "sse") {
      return new SSEClientTransport(new URL(config.endpoint));
    }
    return new StreamableHTTPClientTransport(new URL(config.endpoint));
  }
}
