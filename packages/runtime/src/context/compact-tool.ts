import type { AgentLoop } from "../agent/loop.js";
import { defineLocalTool, type RegisteredTool } from "../tools/registry.js";

/** Builtin tool so the model can request context compaction mid-run. */
export function createCompactTool(loop: AgentLoop): RegisteredTool {
  return defineLocalTool({
    name: "compact",
    description:
      "Compress the current session conversation history to free context window space. Prefer when history is long or tool outputs dominate.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: {
        force_llm: {
          type: "boolean",
          description: "When true (default), run LLM summarization after cheap layers",
        },
      },
    },
    execute: async (args, ctx) => {
      const forceLlm = args.force_llm === undefined ? true : Boolean(args.force_llm);
      const result = await loop.compactSession({
        sessionId: ctx.sessionId,
        forceLlm,
        abortSignal: ctx.abortSignal,
      });
      for (const layer of result.layers) {
        ctx.emitEvent({
          type: "context.compacted",
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          layer,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          messagesBefore: result.messagesBefore,
          messagesAfter: result.messagesAfter,
          timestampMs: Date.now(),
        });
      }
      return {
        ok: true,
        layers: result.layers,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        messagesBefore: result.messagesBefore,
        messagesAfter: result.messagesAfter,
        message: "[Compacted. History summarized.]",
      };
    },
  });
}
