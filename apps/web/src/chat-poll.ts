/** Manual and event-driven refreshes can bypass the fallback polling delay. */
export class PollBackoff {
  #failures = 0;
  #nextAt = 0;
  due(now = Date.now()): boolean { return now >= this.#nextAt; }
  success(): void { this.#failures = 0; this.#nextAt = 0; }
  failure(now = Date.now()): void {
    this.#failures = Math.min(4, this.#failures + 1);
    this.#nextAt = now + Math.min(60_000, 4_000 * 2 ** this.#failures);
  }
}
