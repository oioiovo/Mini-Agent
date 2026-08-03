import { nanoid } from "nanoid";
import type { ChatMessage, MemoryHit, MemoryStore } from "../types.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter(Boolean);
}

function scoreOverlap(query: string, content: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const c = new Set(tokenize(content));
  let hit = 0;
  for (const token of q) {
    if (c.has(token)) hit += 1;
  }
  return hit / q.size;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly history = new Map<string, ChatMessage[]>();
  private readonly longTerm: Array<{
    id: string;
    content: string;
    metadata: Record<string, string>;
  }> = [];

  async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const existing = this.history.get(sessionId) ?? [];
    existing.push(...messages);
    this.history.set(sessionId, existing);
  }

  async getHistory(sessionId: string): Promise<ChatMessage[]> {
    return [...(this.history.get(sessionId) ?? [])];
  }

  async search(sessionId: string, query: string, limit = 5): Promise<MemoryHit[]> {
    const sessionHits = (this.history.get(sessionId) ?? [])
      .map((message, index) => ({
        id: `${sessionId}:${index}`,
        content: message.content,
        score: scoreOverlap(query, message.content),
      }))
      .filter((hit) => hit.score > 0);

    const longTermHits = this.longTerm
      .map((item) => ({
        id: item.id,
        content: item.content,
        score: scoreOverlap(query, item.content),
        metadata: item.metadata,
      }))
      .filter((hit) => hit.score > 0);

    return [...sessionHits, ...longTermHits]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async summarizeIfNeeded(sessionId: string, maxMessages: number): Promise<void> {
    const messages = this.history.get(sessionId);
    if (!messages || messages.length <= maxMessages) return;
    const dropped = messages.splice(0, messages.length - maxMessages);
    const summary = dropped
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, 2000);
    messages.unshift({
      role: "system",
      content: `Conversation summary of earlier turns:\n${summary}`,
    });
  }

  async rememberLongTerm(
    content: string,
    metadata: Record<string, string> = {},
  ): Promise<string> {
    const id = nanoid();
    this.longTerm.push({ id, content, metadata });
    return id;
  }
}

export class CompositeMemoryStore implements MemoryStore {
  constructor(
    private readonly sessionHistory: {
      getMessages(sessionId: string): Promise<ChatMessage[]>;
      setMessages?(sessionId: string, messages: ChatMessage[]): Promise<void>;
    },
    private readonly longTerm: InMemoryMemoryStore = new InMemoryMemoryStore(),
  ) {}

  async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await this.longTerm.append(sessionId, messages);
  }

  async getHistory(sessionId: string): Promise<ChatMessage[]> {
    const fromSession = await this.sessionHistory.getMessages(sessionId);
    if (fromSession.length > 0) return fromSession;
    return this.longTerm.getHistory(sessionId);
  }

  async search(sessionId: string, query: string, limit?: number): Promise<MemoryHit[]> {
    return this.longTerm.search(sessionId, query, limit);
  }

  async summarizeIfNeeded(sessionId: string, maxMessages: number): Promise<void> {
    await this.longTerm.summarizeIfNeeded(sessionId, maxMessages);
  }

  async rememberLongTerm(
    content: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    return this.longTerm.rememberLongTerm(content, metadata);
  }
}
