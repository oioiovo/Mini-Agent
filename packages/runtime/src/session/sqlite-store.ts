import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import type { ChatMessage, SessionRecord } from "../types.js";
import { nowMs } from "../utils.js";
import type { SessionStore } from "./memory-store.js";

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        messages_json TEXT NOT NULL
      );
    `);
  }

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
    this.db
      .prepare(
        `INSERT INTO sessions (id, created_at_ms, updated_at_ms, metadata_json, system_prompt, messages_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.createdAtMs,
        session.updatedAtMs,
        JSON.stringify(session.metadata),
        session.systemPrompt,
        JSON.stringify(session.messages),
      );
    return session;
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT id, created_at_ms, updated_at_ms, metadata_json, system_prompt, messages_json
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          id: string;
          created_at_ms: number;
          updated_at_ms: number;
          metadata_json: string;
          system_prompt: string;
          messages_json: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      metadata: JSON.parse(row.metadata_json) as Record<string, string>,
      systemPrompt: row.system_prompt,
      messages: JSON.parse(row.messages_json) as ChatMessage[],
    };
  }

  async appendMessages(sessionId: string, messages: ChatMessage[]): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(...messages);
    session.updatedAtMs = nowMs();
    this.db
      .prepare(`UPDATE sessions SET updated_at_ms = ?, messages_json = ? WHERE id = ?`)
      .run(session.updatedAtMs, JSON.stringify(session.messages), sessionId);
    return session;
  }

  async replaceMessages(sessionId: string, messages: ChatMessage[]): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages = [...messages];
    session.updatedAtMs = nowMs();
    this.db
      .prepare(`UPDATE sessions SET updated_at_ms = ?, messages_json = ? WHERE id = ?`)
      .run(session.updatedAtMs, JSON.stringify(session.messages), sessionId);
    return session;
  }

  async touch(sessionId: string): Promise<void> {
    const result = this.db
      .prepare(`UPDATE sessions SET updated_at_ms = ? WHERE id = ?`)
      .run(nowMs(), sessionId);
    if (result.changes === 0) throw new Error(`Session not found: ${sessionId}`);
  }

  close(): void {
    this.db.close();
  }
}
