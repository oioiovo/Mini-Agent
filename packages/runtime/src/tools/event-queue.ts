/**
 * Simple async event queue for merging concurrent tool execution events.
 */
export class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    const waiter = this.waiters.shift();
    waiter?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}
