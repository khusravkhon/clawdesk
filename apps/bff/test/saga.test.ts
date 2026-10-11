import { describe, expect, it } from "vitest";
import { runSaga, SagaError } from "../src/provision/saga.js";

describe("runSaga", () => {
  it("runs all steps in order", async () => {
    const log: string[] = [];
    await runSaga({}, [
      { name: "a", run: async () => void log.push("a") },
      { name: "b", run: async () => void log.push("b") },
    ]);
    expect(log).toEqual(["a", "b"]);
  });

  it("undoes completed steps in reverse order when a step fails", async () => {
    const log: string[] = [];
    const failure = new Error("boom");
    const result = runSaga({}, [
      { name: "create", run: async () => void log.push("create"), undo: async () => void log.push("undo create") },
      { name: "files", run: async () => void log.push("files") },
      { name: "cron", run: async () => void log.push("cron"), undo: async () => void log.push("undo cron") },
      { name: "chat", run: async () => Promise.reject(failure), undo: async () => void log.push("undo chat") },
    ]);
    await expect(result).rejects.toBeInstanceOf(SagaError);
    await result.catch((error: SagaError) => {
      expect(error.failedStep).toBe("chat");
      expect(error.cause).toBe(failure);
      expect(error.rollbackErrors).toEqual([]);
    });
    expect(log).toEqual(["create", "files", "cron", "undo cron", "undo create"]);
  });

  it("keeps rolling back after an undo fails and reports it", async () => {
    const log: string[] = [];
    const error = await runSaga({}, [
      { name: "a", run: async () => void log.push("a"), undo: async () => void log.push("undo a") },
      { name: "b", run: async () => void log.push("b"), undo: async () => Promise.reject(new Error("undo b failed")) },
      { name: "c", run: async () => Promise.reject(new Error("c failed")) },
    ]).catch((e: SagaError) => e);
    expect(log).toEqual(["a", "b", "undo a"]);
    expect((error as SagaError).rollbackErrors.map((r) => r.step)).toEqual(["b"]);
    expect((error as SagaError).message).toContain("rollback incomplete (b)");
  });
});
