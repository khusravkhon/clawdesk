import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateSpaceRequest, UpdateSpaceRequest } from "@clawdesk/shared";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { SpaceExistsError, SpaceService } from "../src/space/space-service.js";

describe("space (screen 2)", () => {
  let dir: string;
  let close: () => void;
  let space: SpaceService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-space-"));
    const opened = openDb(path.join(dir, "panel.sqlite"));
    close = opened.close;
    space = new SpaceService({ db: opened.db, logger: pino({ level: "silent" }) });
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is personal until chosen, then chosen once", () => {
    expect(space.get()).toBeNull();
    expect(space.mode()).toBe("personal");
    space.create(CreateSpaceRequest.parse({ mode: "company", name: "Acme", locale: "ru", timezone: "Asia/Dushanbe" }));
    expect(space.mode()).toBe("company");
    expect(() => space.create(CreateSpaceRequest.parse({ mode: "personal", name: "x", locale: "en", timezone: "UTC" }))).toThrow(SpaceExistsError);
  });

  it("accepts real time zones only", () => {
    expect(CreateSpaceRequest.safeParse({ mode: "personal", name: "Me", locale: "tg", timezone: "Mars/Olympus" }).success).toBe(false);
  });

  it("persists personal settings without allowing a mode change", () => {
    space.create(CreateSpaceRequest.parse({ mode: "personal", name: "Old", locale: "tg", timezone: "UTC" }));
    expect(UpdateSpaceRequest.safeParse({ name: "New", timezone: "Asia/Dushanbe", mode: "company" }).success).toBe(false);
    expect(space.update(UpdateSpaceRequest.parse({ name: "New", timezone: "Asia/Dushanbe" }))).toEqual({
      mode: "personal", name: "New", timezone: "Asia/Dushanbe", locale: "tg",
    });
    const reopened = openDb(path.join(dir, "panel.sqlite"));
    try {
      expect(new SpaceService({ db: reopened.db, logger: pino({ level: "silent" }) }).get()).toEqual(space.get());
    } finally { reopened.close(); }
  });
});
