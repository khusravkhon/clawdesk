import { describe, expect, it } from "vitest";
import { PollBackoff } from "../src/chat-poll";

describe("PollBackoff", () => {
  it("waits longer after each failure, at most a minute, and resets on success", () => {
    const poll = new PollBackoff();
    expect(poll.due(0)).toBe(true);
    poll.failure(0);
    expect(poll.due(7_999)).toBe(false);
    expect(poll.due(8_000)).toBe(true);
    for (let i = 0; i < 10; i++) poll.failure(0);
    expect(poll.due(59_999)).toBe(false);
    expect(poll.due(60_000)).toBe(true);
    poll.success();
    expect(poll.due(0)).toBe(true);
  });
});
