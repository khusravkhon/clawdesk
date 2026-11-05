import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CreateProjectRequest } from "@clawdesk/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { BridgeError } from "../src/gateway/bridge-client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import type { SpaceService } from "../src/space/space-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";

// P7 in the panel: the project is checked, the request validated and only then passed to the bridge.

describe("project GitHub routes", () => {
  let root: string, db: Db, close: () => void, calls: [string, unknown][];
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-pgh-")); ({ db, close } = openDb(path.join(root, "panel.sqlite"))); calls = []; });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("passes confirmed requests to the bridge, refuses unconfirmed ones and maps the bridge's refusals", async () => {
    const bridge = {
      projectWorkspace: async () => ({}), prepareProjectWorkspace: async () => ({}),
      projectGitHub: async (id: string) => { calls.push(["status", id]); return { tokenSaved: false, repo: null, step: null, pullRequests: [], git: false, local: null, mode: "new" }; },
      projectGitHubPlan: async () => ({ files: [], excluded: [], addGitignore: true, planHash: "a".repeat(64) }),
      projectGitHubChanges: async () => ({ changes: [], changesHash: "b".repeat(64) }),
      createProjectRepo: async (id: string, body: unknown) => { calls.push(["create", body]); throw new BridgeError("github_repo_exists", "github_repo_exists"); },
      projectPullRequest: async (id: string, body: unknown) => { calls.push(["pr", body]); return { requestId: "x", url: "u", number: 1, branch: "b", at: 1 }; },
      disconnectProjectGitHub: async () => ({ ok: true as const }),
      connectProjectRepo: async (id: string, body: unknown) => { calls.push(["connect", body]); return { step: "pushed" }; },
      importProjectRepo: async (id: string, body: unknown) => { calls.push(["import", body]); return { step: "pushed" }; },
    };
    const company = new CompanyService({ db, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService, bridge: bridge as never });
    const id = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Shop" })).id;
    const app = Fastify(); registerCompanyRoutes(app, company);
    expect((await app.inject({ url: `/api/company/projects/${id}/github` })).json()).toMatchObject({ tokenSaved: false, mode: "new" });
    const create = { requestId: randomUUID(), token: "github_pat_" + "a".repeat(40), owner: "owner1", name: "shop", planHash: "a".repeat(64) };
    expect((await app.inject({ method: "POST", url: `/api/company/projects/${id}/github/create`, payload: create })).statusCode).toBe(400);
    const refused = await app.inject({ method: "POST", url: `/api/company/projects/${id}/github/create`, payload: { ...create, confirm: true } });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "github_repo_exists"]);
    expect(calls.find(([kind]) => kind === "create")![1]).toEqual({ token: create.token, owner: "owner1", name: "shop", visibility: "private", planHash: create.planHash, requestId: create.requestId });
    expect((await app.inject({ method: "POST", url: `/api/company/projects/${id}/github/create`, payload: { ...create, confirm: true, token: "password" } })).statusCode).toBe(400);
    const pr = await app.inject({ method: "POST", url: `/api/company/projects/${id}/github/pull-request`, payload: { requestId: randomUUID(), title: "BR-002", changesHash: "b".repeat(64), confirm: true } });
    expect(pr.json()).toMatchObject({ number: 1 });
    expect((await app.inject({ url: `/api/company/projects/unknown-project/github` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/company/projects/${id}/github/connect`, payload: { requestId: randomUUID() } })).json()).toEqual({ step: "pushed" });
    const imported = { requestId: randomUUID(), url: "https://github.com/owner1/site", folder: "Сайт", token: create.token };
    expect((await app.inject({ method: "POST", url: `/api/company/projects/${id}/github/import`, payload: imported })).json()).toEqual({ step: "pushed" });
    expect(calls.find(([kind]) => kind === "import")![1]).toEqual({ token: create.token, url: imported.url, folder: "Сайт", requestId: imported.requestId });
    for (const bad of [{ ...imported, url: "https://gitlab.com/a/b" }, { ...imported, folder: "../etc" }]) expect((await app.inject({ method: "POST", url: `/api/company/projects/${id}/github/import`, payload: bad })).statusCode).toBe(400);
    await app.close();
  });
});
