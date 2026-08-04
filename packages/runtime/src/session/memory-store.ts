import { nanoid } from "nanoid";
import type { ChatMessage, SessionRecord } from "../types.js";
import { nowMs } from "../utils.js";

export interface SessionStore {
  create(input: {
    metadata?: Record<string, string>;
    systemPrompt?: string;
  }): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | undefined>;
  appendMessages(sessionId: string, messages: ChatMessage[]): Promise<SessionRecord>;
  replaceMessages(sessionId: string, messages: ChatMessage[]): Promise<SessionRecord>;
  touch(sessionId: string): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async create(input: {
    metadata?: Record<string, string>;
    systemPrompt?: string;
  }): Promise<SessionRecord> {
    const ts = nowMs();
    const session: SessionRecord = {
      id: nanoid(),
      createdAtMs: ts,
      updatedAtMs: ts,
      metadata: input.metadata ?? {},
      systemPrompt: input.systemPrompt ?? "",
      messages: [],
    };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async appendMessages(sessionId: string, messages: ChatMessage[]): Promise<SessionRecord> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(...messages);
    session.updatedAtMs = nowMs();
    return structuredClone(session);
  }

  async replaceMessages(sessionId: string, messages: ChatMessage[]): Promise<SessionRecord> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages = [...messages];
    session.updatedAtMs = nowMs();
    return structuredClone(session);
  }

  async touch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.updatedAtMs = nowMs();
  }
}
