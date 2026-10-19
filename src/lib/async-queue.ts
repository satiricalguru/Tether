/** Minimal unbounded async queue: push/end/fail on one side, iterate on the other. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: {
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }[] = [];
  private finished = false;
  private failure: unknown = undefined;
  private failed = false;

  push(item: T): void {
    if (this.finished) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(err: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.failed = true;
    this.failure = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.failed)
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rethrows whatever the producer failed with
          return Promise.reject(this.failure);
        if (this.finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
