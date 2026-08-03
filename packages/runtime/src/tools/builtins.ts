import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import type { ToolRisk } from "./policy.js";
import { defineLocalTool, type RegisteredTool } from "./registry.js";
import {
  ensureWorkspaceRoot,
  parentDir,
  resolveSafePath,
} from "./workspace.js";

const MAX_READ_BYTES = 256 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;

export interface BuiltinToolsOptions {
  workspaceRoot: string;
  allowPrivateHttp?: boolean;
  toolTimeoutMs?: number;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    return true;
  }
  const ipVersion = isIP(host);
  if (!ipVersion) return false;
  if (host === "127.0.0.1" || host === "::1") return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (host.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

export function createBuiltinTools(options: BuiltinToolsOptions): RegisteredTool[] {
  const workspaceRoot = ensureWorkspaceRoot(options.workspaceRoot);
  const allowPrivateHttp =
    options.allowPrivateHttp ??
    (process.env.MINI_AGENT_HTTP_ALLOW_PRIVATE === "true" ||
      process.env.MINI_AGENT_HTTP_ALLOW_PRIVATE === "1");

  const withRisk = (tool: RegisteredTool, risk: ToolRisk): RegisteredTool => ({
    ...tool,
    risk,
  });

  return [
    withRisk(
      defineLocalTool({
        name: "now",
        description: "Return the current UTC timestamp in ISO format",
        risk: "read",
        execute: () => ({ now: new Date().toISOString() }),
      }),
      "read",
    ),
    withRisk(
      defineLocalTool({
        name: "calculator",
        description:
          "Evaluate a simple arithmetic expression with + - * / and parentheses",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: {
            expression: { type: "string" },
          },
          required: ["expression"],
        },
        execute: ({ expression }) => {
          const expr = String(expression ?? "");
          if (!/^[\d\s+\-*/().]+$/.test(expr)) {
            throw new Error("Only basic arithmetic is allowed");
          }
          // eslint-disable-next-line no-new-func
          const value = Function(`"use strict"; return (${expr});`)() as number;
          return { expression: expr, value };
        },
      }),
      "read",
    ),
    withRisk(
      defineLocalTool({
        name: "list_dir",
        description: "List files and directories under a path inside the agent workspace",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path inside workspace" },
          },
        },
        execute: ({ path: userPath }) => {
          const target = resolveSafePath(workspaceRoot, String(userPath ?? "."));
          const entries = readdirSync(target, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          }));
          return { path: userPath ?? ".", entries };
        },
      }),
      "read",
    ),
    withRisk(
      defineLocalTool({
        name: "read_file",
        description: "Read a UTF-8 text file from the agent workspace (max 256KB)",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
        execute: ({ path: userPath }, ctx) => {
          const target = resolveSafePath(workspaceRoot, String(userPath ?? ""));
          const stat = statSync(target);
          if (!stat.isFile()) throw new Error("Not a file");
          if (stat.size > MAX_READ_BYTES) {
            throw new Error(`File too large: ${stat.size} bytes (max ${MAX_READ_BYTES})`);
          }
          const content = readFileSync(target, "utf8");
          const CHUNK = 8 * 1024;
          if (content.length > CHUNK) {
            for (let i = 0; i < content.length; i += CHUNK) {
              ctx.emitDelta(content.slice(i, i + CHUNK));
            }
          }
          return { path: userPath, content, bytes: Buffer.byteLength(content, "utf8") };
        },
      }),
      "read",
    ),
    withRisk(
      defineLocalTool({
        name: "write_file",
        description: "Write a UTF-8 text file inside the agent workspace (requires approval)",
        risk: "write",
        sideEffect: true,
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
        execute: ({ path: userPath, content }) => {
          const target = resolveSafePath(workspaceRoot, String(userPath ?? ""));
          mkdirSync(parentDir(target), { recursive: true });
          const text = String(content ?? "");
          writeFileSync(target, text, "utf8");
          return {
            path: userPath,
            bytes: Buffer.byteLength(text, "utf8"),
            written: true,
          };
        },
      }),
      "write",
    ),
    withRisk(
      defineLocalTool({
        name: "http_request",
        description:
          "Perform an HTTP(S) request (requires approval). Private network hosts are blocked by default.",
        risk: "network",
        sideEffect: true,
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string" },
            url: { type: "string" },
            headers: { type: "object" },
            body: { type: "string" },
          },
          required: ["url"],
        },
        execute: async ({ method, url, headers, body }, ctx) => {
          const targetUrl = String(url ?? "");
          let parsed: URL;
          try {
            parsed = new URL(targetUrl);
          } catch {
            throw new Error("Invalid URL");
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Only http and https are allowed");
          }
          if (!allowPrivateHttp && isPrivateHostname(parsed.hostname)) {
            throw new Error(`Private network host blocked: ${parsed.hostname}`);
          }

          const response = await fetch(parsed, {
            method: String(method ?? "GET").toUpperCase(),
            headers:
              headers && typeof headers === "object" && !Array.isArray(headers)
                ? (headers as Record<string, string>)
                : undefined,
            body: body == null ? undefined : String(body),
            signal: ctx.abortSignal,
          });

          const chunks: Buffer[] = [];
          let total = 0;
          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const buf = Buffer.from(value);
              chunks.push(buf);
              total += buf.length;
              ctx.emitDelta(buf.toString("utf8"));
              if (total >= MAX_HTTP_RESPONSE_BYTES) {
                // keep reading? plan says truncate final; stop emitting more after cap
                // still drain briefly for accuracy of byte count
              }
            }
          } else {
            const raw = Buffer.from(await response.arrayBuffer());
            chunks.push(raw);
            total = raw.length;
            if (raw.length > 0) ctx.emitDelta(raw.toString("utf8"));
          }

          const raw = Buffer.concat(chunks);
          const truncated = raw.length > MAX_HTTP_RESPONSE_BYTES;
          const slice = truncated ? raw.subarray(0, MAX_HTTP_RESPONSE_BYTES) : raw;
          return {
            status: response.status,
            ok: response.ok,
            headers: Object.fromEntries(response.headers.entries()),
            body: slice.toString("utf8"),
            truncated,
            bytes: raw.length,
          };
        },
      }),
      "network",
    ),
  ];
}
