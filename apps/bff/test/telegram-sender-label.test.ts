import { expect, it } from "vitest";
import { senderLabel } from "../src/telegram/telegram-service.js";

// OpenClaw 2026.8.35 reports senderLabel "telegramUserId" (the id's kind), so the panel showed "Owner: telegramUserId".
it("names the Telegram owner by @username, else by name, else by numeric id", () => {
  expect(senderLabel("42", { username: "khusrav", firstName: "K" })).toBe("@khusrav");
  expect(senderLabel("42", { firstName: "Khusrav", lastName: "N" })).toBe("Khusrav N");
  expect(senderLabel("42", {})).toBe("42");
  expect(senderLabel("42")).toBe("42");
});
