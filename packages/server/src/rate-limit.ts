export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

export class MemoryRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly hits = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 120;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts >= windowStart);
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
