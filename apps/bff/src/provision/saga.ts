import type { Logger } from "pino";

// "Create agent" and friends are chains of Gateway RPCs. If step N fails, the
// steps before it are undone in reverse order so OpenClaw is not left with a
// half-provisioned agent.

export type SagaStep<Ctx> = {
  name: string;
  run: (ctx: Ctx) => Promise<void>;
  undo?: (ctx: Ctx) => Promise<void>;
};

export class SagaError extends Error {
  constructor(
    readonly failedStep: string,
    override readonly cause: unknown,
    readonly rollbackErrors: { step: string; error: unknown }[],
  ) {
    const rollback = rollbackErrors.length === 0 ? "rolled back" : `rollback incomplete (${rollbackErrors.map((e) => e.step).join(", ")})`;
    super(`step "${failedStep}" failed: ${errorMessage(cause)}; ${rollback}`);
    this.name = "SagaError";
  }
}

export async function runSaga<Ctx>(ctx: Ctx, steps: SagaStep<Ctx>[], logger?: Logger): Promise<Ctx> {
  const done: SagaStep<Ctx>[] = [];
  for (const step of steps) {
    try {
      logger?.debug({ step: step.name }, "saga step");
      await step.run(ctx);
      done.push(step);
    } catch (cause) {
      logger?.warn({ step: step.name, err: cause }, "saga step failed; rolling back");
      const rollbackErrors: { step: string; error: unknown }[] = [];
      for (const prev of done.toReversed()) {
        if (!prev.undo) continue;
        try {
          await prev.undo(ctx);
        } catch (error) {
          rollbackErrors.push({ step: prev.name, error });
          logger?.error({ step: prev.name, err: error }, "saga rollback step failed");
        }
      }
      throw new SagaError(step.name, cause, rollbackErrors);
    }
  }
  return ctx;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
