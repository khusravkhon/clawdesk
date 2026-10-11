import { ConnectTelegramRequest } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { telegramDelivery } from "../src/telegram/telegram-service.js";

describe("telegram", () => {
  it("accepts BotFather-shaped tokens only", () => {
    expect(ConnectTelegramRequest.safeParse({ token: " 123456789:AAFakeFakeFakeFakeFakeFakeFakeFake_x " }).success).toBe(true);
    for (const token of ["", "123:short", "abc:AAFakeFakeFakeFakeFakeFakeFakeFake", "123456789:has spaces in it and more chars"]) {
      expect(ConnectTelegramRequest.safeParse({ token }).success, token).toBe(false);
    }
  });

  it("announces schedule results to the owner's chat without failing the job on delivery errors", () => {
    expect(telegramDelivery("42")).toEqual({ mode: "announce", channel: "telegram", to: "42", bestEffort: true });
  });
});
