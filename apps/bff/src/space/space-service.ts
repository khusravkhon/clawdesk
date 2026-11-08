import type { CreateSpaceRequest, SpaceDto, SpaceMode, UpdateSpaceRequest } from "@clawdesk/shared";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { spaces } from "../db/schema.js";

// Screen 2: one install is one Space — a person (personal) or one trusting team (company).
// Chosen once; a factory reset wipes the panel database and with it this choice.

const ID = "default";

export class SpaceExistsError extends Error {}

export class SpaceService {
  constructor(private readonly deps: { db: Db; logger: Logger }) {}

  get(): SpaceDto | null {
    const row = this.deps.db.select().from(spaces).where(eq(spaces.id, ID)).get();
    return row ? { mode: row.mode, name: row.name, locale: row.locale, timezone: row.timezone } : null;
  }

  /** Personal until chosen: installs from before this screen keep working as they did. */
  mode(): SpaceMode {
    return this.get()?.mode ?? "personal";
  }

  create(req: CreateSpaceRequest): SpaceDto {
    if (this.get()) throw new SpaceExistsError("the mode is already chosen; a factory reset starts over");
    this.deps.db.insert(spaces).values({ id: ID, ...req }).run();
    this.deps.logger.info({ mode: req.mode }, "space created");
    return this.get()!;
  }

  update(req: UpdateSpaceRequest): SpaceDto | null {
    const row = this.deps.db.update(spaces).set(req).where(and(eq(spaces.id, ID), eq(spaces.mode, "personal"))).returning().get();
    return row ? { mode: row.mode, name: row.name, locale: row.locale, timezone: row.timezone } : null;
  }
}
