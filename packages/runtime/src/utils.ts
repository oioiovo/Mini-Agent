import type { Logger } from "./types.js";

export const consoleLogger: Logger = {
  debug(message, meta) {
    console.debug(message, meta ?? "");
  },
  info(message, meta) {
    console.info(message, meta ?? "");
  },
  warn(message, meta) {
    console.warn(message, meta ?? "");
  },
  error(message, meta) {
    console.error(message, meta ?? "");
  },
};

export function nowMs(): number {
  return Date.now();
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
