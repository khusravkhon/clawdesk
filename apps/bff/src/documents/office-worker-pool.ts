import { Worker } from "node:worker_threads";
import type { OfficeInput, OfficeResult } from "./office-worker.js";

type Job = { input: OfficeInput; resolve: (value: OfficeResult) => void; reject: (error: unknown) => void };
type Slot = {
  worker: Worker;
  active?: { job: Job; timer: ReturnType<typeof setTimeout> };
  retiring?: Promise<void>;
};

export class DocumentWorkerError extends Error {
  constructor(readonly code: "document_queue_full" | "document_timeout" | "document_worker_unavailable") { super(code); }
}

/** Workers handle one document at a time and are reused until they fail or the pool stops. */
export class OfficeWorkerPool {
  readonly #waiting: Job[] = [];
  readonly #slots = new Set<Slot>();
  #closing = false;

  constructor(private readonly concurrency = 1, private readonly queueLimit = 4, private readonly timeoutMs = 15_000) {}

  run(input: OfficeInput): Promise<OfficeResult> {
    if (this.#closing) return Promise.reject(new DocumentWorkerError("document_worker_unavailable"));
    if (this.#slots.size >= this.concurrency && !this.#idle() && this.#waiting.length >= this.queueLimit) {
      return Promise.reject(new DocumentWorkerError("document_queue_full"));
    }
    return new Promise((resolve, reject) => {
      this.#waiting.push({ input, resolve, reject });
      this.#pump();
    });
  }

  #idle(): Slot | undefined {
    return [...this.#slots].find((slot) => !slot.active && !slot.retiring);
  }

  #pump(): void {
    while (!this.#closing && this.#waiting.length) {
      let slot = this.#idle();
      if (!slot && this.#slots.size >= this.concurrency) return;
      const job = this.#waiting.shift()!;
      try {
        const runningSlot = slot ??= this.#createWorker();
        const timer = setTimeout(() => { void this.#retire(runningSlot, "document_timeout"); }, this.timeoutMs);
        runningSlot.active = { job, timer };
        runningSlot.worker.ref();
        runningSlot.worker.postMessage(job.input);
      } catch {
        if (slot?.active) void this.#retire(slot);
        else job.reject(new DocumentWorkerError("document_worker_unavailable"));
      }
    }
  }

  #createWorker(): Slot {
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(new URL(source ? "./office-worker.ts" : "./office-worker.js", import.meta.url), {
      execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
      resourceLimits: { maxOldGenerationSizeMb: 160, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    const slot: Slot = { worker };
    worker.on("message", (result: OfficeResult) => {
      if (slot.retiring || !slot.active) return;
      const { job, timer } = slot.active;
      clearTimeout(timer);
      slot.active = undefined;
      worker.unref();
      job.resolve(result);
      this.#pump();
    });
    worker.once("messageerror", () => { void this.#retire(slot); });
    worker.once("error", () => { void this.#retire(slot); });
    worker.once("exit", () => { void this.#retire(slot); });
    this.#slots.add(slot);
    return slot;
  }

  #retire(slot: Slot, code: "document_timeout" | "document_worker_unavailable" = "document_worker_unavailable"): Promise<void> {
    return slot.retiring ??= (async () => {
      const active = slot.active;
      clearTimeout(active?.timer);
      // Keep the slot occupied until termination so a timeout cannot exceed the worker limit.
      slot.worker.ref();
      await slot.worker.terminate().catch(() => {});
      this.#slots.delete(slot);
      active?.job.reject(new DocumentWorkerError(code));
      this.#pump();
    })();
  }

  async stop(): Promise<void> {
    this.#closing = true;
    for (const job of this.#waiting.splice(0)) job.reject(new DocumentWorkerError("document_worker_unavailable"));
    await Promise.all([...this.#slots].map((slot) => this.#retire(slot)));
  }
}

export const officeWorkers = new OfficeWorkerPool();
