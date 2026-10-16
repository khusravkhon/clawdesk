import crypto from "node:crypto";
import path from "node:path";
import type { AddClawHubSkillRequest, ClawHubSearchDto, OwnSkillContentDto, OwnSkillRequest, SkillDto, SkillsDto, UploadSkillRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { skills } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { liveAgentIds } from "../provision/agent-communication.js";
import { ownSkillMd, parseSkillMd, readSkillArchive, SkillArchiveError, slugify, zipSkillMd } from "./skill-archive.js";

// Skills the owner adds once ("Навыки и MCP") and hands out per agent. OpenClaw installs a skill
// into one agent's workspace (skills/<slug>) — from ClawHub, or from an uploaded zip for own
// skills — so giving a skill to an agent is an install there, and taking it away removes that
// folder (through the bridge: OpenClaw has no RPC for it). Which agents have a skill is read
// back from the Gateway every time, never kept here. Sandboxed juniors get workspace skills
// synced into their sandbox by OpenClaw.
//
// The Gateway caches each workspace's skill list until a skill watcher (started by an agent turn)
// or a change under skills.* in its config says otherwise; installs and removals over RPC do
// neither. So every change starts and ends with a small write to skills.entries.<slug>.config,
// which makes OpenClaw reload the list — for status and for the agents' next turn alike.

type SkillRow = typeof skills.$inferSelect;
type StatusSkill = { name?: string; baseDir?: string; source?: string };
type SkillsStatus = { workspaceDir?: string; skills?: StatusSkill[] };
type SearchResult = { installRef?: string; slug?: string; displayName?: string; summary?: string; trustState?: string };

const CHUNK_BYTES = 3 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 180_000;

export class SkillsError extends Error {
  constructor(
    readonly code: "not_found" | "exists" | "not_editable" | "install_failed" | "bridge_unavailable" | SkillArchiveError["code"] | "bad_file",
    message: string,
  ) {
    super(message);
    this.name = "SkillsError";
  }
}

export class SkillsService {
  /** Installs and removals change agents' workspaces; one at a time keeps them predictable. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: { gateway: GatewayService; db: Db; bridge: BridgeClient; logger: Logger }) {}

  async list(): Promise<SkillsDto> {
    const rows = this.deps.db.select().from(skills).all();
    const installed = await this.#installed();
    return { skills: rows.map((row) => this.#dto(row, installed)) };
  }

  async search(query: string): Promise<ClawHubSearchDto> {
    const res = await this.deps.gateway.request<{ results?: SearchResult[] }>("skills.search", { ...(query ? { query } : {}), limit: 20 }, { timeoutMs: 30_000 });
    return {
      results: (res.results ?? [])
        .filter((r) => r.installRef && r.slug)
        .map((r) => ({ installRef: r.installRef!, slug: r.slug!, name: r.displayName ?? r.slug!, summary: r.summary ?? null, notScanned: r.trustState === "not-scanned-by-clawhub" })),
    };
  }

  addClawHub(req: AddClawHubSkillRequest): Promise<SkillsDto> {
    return this.#serial(async () => {
      const slug = slugify(req.installRef.split("/").pop() ?? req.name);
      if (this.#bySlug(slug)) throw new SkillsError("exists", `a skill named "${slug}" is already added`);
      const row = { id: crypto.randomUUID(), kind: "clawhub" as const, slug, name: req.name, description: req.summary ?? null, installRef: req.installRef, archive: null, instructions: null };
      // ClawHub checks the skill on the first install; if that fails, nothing is kept.
      const [first, ...rest] = req.agentIds;
      if (first) await this.#install(row, first);
      this.deps.db.insert(skills).values(row).run();
      await this.#installAll(row, rest);
      await this.#refresh(slug);
      this.deps.logger.info({ slug, installRef: req.installRef, agents: req.agentIds }, "ClawHub skill added");
      return this.list();
    });
  }

  createOwn(req: OwnSkillRequest): Promise<SkillsDto> {
    return this.#serial(async () => {
      const slug = this.#freeSlug(slugify(req.name));
      const archive = zipSkillMd(ownSkillMd({ slug, ...req }));
      const row = { id: crypto.randomUUID(), kind: "own" as const, slug, name: req.name, description: req.description, installRef: null, archive, instructions: req.instructions };
      this.deps.db.insert(skills).values(row).run();
      await this.#installAll(row, req.agentIds);
      await this.#refresh(slug);
      this.deps.logger.info({ slug, agents: req.agentIds }, "own skill written");
      return this.list();
    });
  }

  upload(req: UploadSkillRequest): Promise<SkillsDto> {
    return this.#serial(async () => {
      const bytes = Buffer.from(req.contentBase64, "base64");
      const lower = req.fileName.toLowerCase();
      let row: Omit<SkillRow, "createdAt">;
      if (lower.endsWith(".md")) {
        const md = parseSkillMd(bytes.toString("utf8"));
        if (!md.body) throw new SkillsError("bad_file", "the file is empty");
        const name = md.name ?? req.fileName.replace(/\.md$/i, "");
        const slug = this.#freeSlug(slugify(name));
        const description = md.description ?? name;
        // Kept editable: the panel rewrites it with its own name line.
        row = { id: crypto.randomUUID(), kind: "own", slug, name, description, installRef: null, instructions: md.body, archive: zipSkillMd(ownSkillMd({ slug, name, description, instructions: md.body })) };
      } else if (lower.endsWith(".zip")) {
        let md;
        try {
          md = readSkillArchive(bytes);
        } catch (error) {
          if (error instanceof SkillArchiveError) throw new SkillsError(error.code, error.message);
          throw error;
        }
        const name = md.name ?? req.fileName.replace(/\.zip$/i, "");
        const slug = slugify(name);
        if (this.#bySlug(slug)) throw new SkillsError("exists", `a skill named "${slug}" is already added`);
        row = { id: crypto.randomUUID(), kind: "own", slug, name, description: md.description, installRef: null, instructions: null, archive: bytes };
      } else {
        throw new SkillsError("bad_file", "upload a SKILL.md file or a .zip of a skill folder");
      }
      const [first, ...rest] = req.agentIds;
      // OpenClaw scans an uploaded archive on install; a refused one is not kept.
      if (first) await this.#install(row, first);
      this.deps.db.insert(skills).values(row).run();
      await this.#installAll(row, rest);
      await this.#refresh(row.slug);
      this.deps.logger.info({ slug: row.slug, agents: req.agentIds }, "own skill uploaded");
      return this.list();
    });
  }

  content(id: string): OwnSkillContentDto {
    const row = this.#require(id);
    if (row.instructions === null) throw new SkillsError("not_editable", "only skills written in the panel can be edited");
    return { name: row.name, description: row.description ?? "", instructions: row.instructions };
  }

  updateOwn(id: string, req: OwnSkillRequest): Promise<SkillsDto> {
    return this.#serial(async () => {
      const row = this.#require(id);
      if (row.instructions === null) throw new SkillsError("not_editable", "only skills written in the panel can be edited");
      await this.#refresh(row.slug);
      const archive = zipSkillMd(ownSkillMd({ slug: row.slug, ...req }));
      const next = { ...row, name: req.name, description: req.description, instructions: req.instructions, archive };
      this.deps.db.update(skills).set({ name: req.name, description: req.description, instructions: req.instructions, archive }).where(eq(skills.id, id)).run();
      const installed = await this.#installed();
      const had = this.#agentsWith(row, installed);
      // Agents that keep it get the new text (install over the old folder).
      await this.#installAll(next, req.agentIds);
      await this.#removeAll(next, had.filter((agentId) => !req.agentIds.includes(agentId)));
      await this.#refresh(row.slug);
      return this.list();
    });
  }

  setAgents(id: string, agentIds: string[]): Promise<SkillsDto> {
    return this.#serial(async () => {
      const row = this.#require(id);
      await this.#refresh(row.slug);
      const live = await liveAgentIds(this.deps.gateway);
      const have = this.#agentsWith(row, await this.#installed());
      await this.#installAll(row, agentIds.filter((agentId) => live.has(agentId) && !have.includes(agentId)));
      await this.#removeAll(row, have.filter((agentId) => !agentIds.includes(agentId)));
      await this.#refresh(row.slug);
      return this.list();
    });
  }

  remove(id: string): Promise<SkillsDto> {
    return this.#serial(async () => {
      const row = this.#require(id);
      await this.#refresh(row.slug);
      await this.#removeAll(row, this.#agentsWith(row, await this.#installed()));
      this.deps.db.delete(skills).where(eq(skills.id, id)).run();
      await this.#refresh(row.slug, true);
      this.deps.logger.info({ slug: row.slug }, "skill removed");
      return this.list();
    });
  }

  // --- internals ---

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #dto(row: SkillRow, installed: Map<string, Map<string, string>>): SkillDto {
    return {
      id: row.id,
      kind: row.kind,
      slug: row.slug,
      name: row.name,
      description: row.description,
      installRef: row.installRef,
      editable: row.instructions !== null,
      agents: this.#agentsWith(row, installed),
      createdAt: row.createdAt.getTime(),
    };
  }

  #agentsWith(row: Pick<SkillRow, "slug">, installed: Map<string, Map<string, string>>): string[] {
    return [...installed].filter(([, slugs]) => slugs.has(row.slug)).map(([agentId]) => agentId);
  }

  /** agentId → (slug → skill folder) for every skill in each agent's own workspace. */
  async #installed(): Promise<Map<string, Map<string, string>>> {
    const agentIds = [...(await liveAgentIds(this.deps.gateway))];
    const entries = await Promise.all(
      agentIds.map(async (agentId) => {
        const status = await this.deps.gateway.request<SkillsStatus>("skills.status", { agentId }, { timeoutMs: 30_000 });
        const root = status.workspaceDir ? path.posix.join(status.workspaceDir, "skills") : null;
        const slugs = new Map<string, string>();
        for (const skill of status.skills ?? []) {
          if (root && skill.baseDir && path.posix.dirname(skill.baseDir) === root) slugs.set(path.posix.basename(skill.baseDir), skill.baseDir);
        }
        return [agentId, slugs] as const;
      }),
    );
    return new Map(entries);
  }

  async #installAll(row: Omit<SkillRow, "createdAt">, agentIds: string[]): Promise<void> {
    for (const agentId of agentIds) await this.#install(row, agentId);
  }

  async #install(row: Omit<SkillRow, "createdAt">, agentId: string): Promise<void> {
    try {
      if (row.kind === "clawhub") {
        await this.deps.gateway
          .request("skills.install", { agentId, source: "clawhub", slug: row.installRef, timeoutMs: INSTALL_TIMEOUT_MS }, { timeoutMs: INSTALL_TIMEOUT_MS + 15_000 })
          // Already in that workspace (a list read before OpenClaw noticed it): nothing to do.
          .catch((error: Error) => {
            if (!/already exists/i.test(error.message)) throw error;
          });
      } else {
        await this.#installArchive(row.slug, row.archive!, agentId);
      }
    } catch (error) {
      if (error instanceof SkillsError) throw error;
      this.deps.logger.warn({ slug: row.slug, agentId, err: error }, "skill install failed");
      throw new SkillsError("install_failed", (error as Error).message);
    }
  }

  /** skills.upload.begin → chunk(s) → commit, then skills.install from that upload (one per agent). */
  async #installArchive(slug: string, archive: Buffer, agentId: string): Promise<void> {
    await this.#allowUploads();
    const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
    const { uploadId } = await this.deps.gateway.request<{ uploadId: string }>("skills.upload.begin", { kind: "skill-archive", slug, sizeBytes: archive.length, sha256, force: true });
    for (let offset = 0; offset < archive.length; offset += CHUNK_BYTES) {
      await this.deps.gateway.request("skills.upload.chunk", { uploadId, offset, dataBase64: archive.subarray(offset, offset + CHUNK_BYTES).toString("base64") });
    }
    await this.deps.gateway.request("skills.upload.commit", { uploadId, sha256 });
    await this.deps.gateway.request("skills.install", { agentId, source: "upload", uploadId, slug, force: true, sha256, timeoutMs: INSTALL_TIMEOUT_MS }, { timeoutMs: INSTALL_TIMEOUT_MS + 15_000 });
  }

  #uploadsAllowed = false;

  /** Uploaded archives are off by default in OpenClaw; the owner's own skills need them. */
  async #allowUploads(): Promise<void> {
    if (this.#uploadsAllowed) return;
    await patchConfig(
      this.deps.gateway,
      (config) => ((config as { skills?: { install?: { allowUploadedArchives?: boolean } } }).skills?.install?.allowUploadedArchives === true ? null : { skills: { install: { allowUploadedArchives: true } } }),
      { note: "clawdesk: own skills" },
    );
    this.#uploadsAllowed = true;
  }

  async #removeAll(row: Pick<SkillRow, "slug">, agentIds: string[]): Promise<void> {
    if (!agentIds.length) return;
    const installed = await this.#installed();
    for (const agentId of agentIds) {
      const dir = installed.get(agentId)?.get(row.slug);
      if (!dir) continue;
      try {
        await this.deps.bridge.skillsRemove(dir);
      } catch (error) {
        throw new SkillsError("bridge_unavailable", `could not remove the skill from ${agentId}: ${(error as Error).message}`);
      }
    }
  }

  /** Makes OpenClaw reload its skill lists (see the note at the top); gone skills lose the entry. */
  async #refresh(slug: string, gone = false): Promise<void> {
    const entry = gone ? null : { config: { clawdeskRevision: Date.now() } };
    await patchConfig(this.deps.gateway, { skills: { entries: { [slug]: entry } } }, { note: "clawdesk: skills changed" }).catch((error: Error) =>
      this.deps.logger.warn({ err: error, slug }, "could not ask OpenClaw to reload its skill lists"),
    );
  }

  #bySlug(slug: string): SkillRow | undefined {
    return this.deps.db.select().from(skills).where(eq(skills.slug, slug)).get();
  }

  #freeSlug(base: string): string {
    if (!this.#bySlug(base)) return base;
    for (let i = 2; ; i++) if (!this.#bySlug(`${base}-${i}`)) return `${base}-${i}`;
  }

  #require(id: string): SkillRow {
    const row = this.deps.db.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) throw new SkillsError("not_found", "no such skill");
    return row;
  }
}
