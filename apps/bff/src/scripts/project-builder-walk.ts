// Isolated UI smoke fixture: actual CompanyService/SQLite/routes and template HTTP server.
// The bridge/container lifecycle is simulated; this never loads the production configuration.
// node --conditions=source --import tsx src/scripts/project-builder-walk.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { CreateProjectRequest, type ProjectBuilderRuntimeDto, type ProjectWorkspaceDto } from "@clawdesk/shared";
import { openDb } from "../db/client.js";
import { CompanyService } from "../company/company-service.js";
import { registerCompanyRoutes } from "../routes/company.js";
import type { SpaceService } from "../space/space-service.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { BridgeError } from "../gateway/bridge-client.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-builder-walk-"));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const { db, close } = openDb(path.join(root, "panel.sqlite"));
const app = Fastify();
let child: ChildProcess | undefined;
let workspace: ProjectWorkspaceDto["workspace"] = null;
let runtime: ProjectBuilderRuntimeDto = { state: "empty", planId: null, files: [], previewUrl: null, error: null };
const workspaceDto = (): ProjectWorkspaceDto => ({ rootPath: root, workspace, available: [], truncated: false });
const space = { mode: "company", name: "Изолированная проверка", locale: "ru", timezone: "Asia/Dushanbe" };
const bridge = {
  projectWorkspace: async () => workspaceDto(),
  prepareProjectWorkspace: async (_id: string, request: { name: string; mode: "new" | "existing" }) => {
    if (workspace) throw new BridgeError("workspace_already_linked", "workspace_already_linked");
    if (!/^[\p{L}\p{N}_ -]{1,80}$/u.test(request.name) || request.mode !== "new") throw new BridgeError("invalid_workspace", "invalid_workspace");
    const target = path.join(root, request.name);
    fs.mkdirSync(target);
    workspace = { name: request.name, mode: "new", path: target, state: "ready" };
    return workspaceDto();
  },
  builderStatus: async () => runtime,
  prepareProjectApp: async (_id: string, request: { planId: string }) => {
    if (!workspace) throw new BridgeError("workspace_required", "workspace_required");
    if (runtime.planId && runtime.planId !== request.planId) throw new BridgeError("builder_plan_changed", "builder_plan_changed");
    const target = path.join(workspace.path, "app");
    fs.mkdirSync(target, { recursive: true });
    const templatePath = path.join(repository, "deploy/project-templates/task-board-v1");
    for (const file of ["server.mjs", "index.html"]) {
      fs.writeFileSync(path.join(target, file), fs.readFileSync(path.join(templatePath, file)));
    }
    runtime = { ...runtime, state: "prepared", planId: request.planId, files: fs.readdirSync(target).map(name => `app/${name}`) };
    return runtime;
  },
  startProjectPreview: async () => {
    if (!workspace || !runtime.planId) throw new BridgeError("preview_not_running", "preview_not_running");
    if (!child) {
      child = spawn(process.execPath, [path.join(workspace.path, "app/server.mjs")], { env: { ...process.env, PORT: "8789", DATA_FILE: path.join(root, "preview.sqlite") }, windowsHide: true, stdio: "ignore" });
      child.once("exit", () => { child = undefined; });
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await fetch("http://127.0.0.1:8789/api/tasks").then(response => response.ok).catch(() => false)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!ready) throw new BridgeError("preview_unavailable", "preview_unavailable");
    }
    runtime = { ...runtime, state: "running" };
    return runtime;
  },
  stopProjectPreview: async () => { await stopChild(); runtime = { ...runtime, state: "stopped" }; return runtime; },
  projectPreviewRequest: async (_id: string, request: { method: string; path: string; body?: unknown }) => {
    if (runtime.state !== "running") throw new BridgeError("preview_not_running", "preview_not_running");
    const response = await fetch(`http://127.0.0.1:8789${request.path}`, { method: request.method, headers: { "content-type": "application/json" }, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: AbortSignal.timeout(3000) });
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() };
  },
  analyzeProjectWorkspace: async () => ({ files: [], dependencies: [], hasGit: false, truncated: false }),
};
const company = new CompanyService({ db, bridge, space: { mode: () => "company", get: () => space } as unknown as SpaceService, gateway: { request: async () => ({ agents: [] }) } as unknown as GatewayService });
const project = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Проверка мастера" }));
registerCompanyRoutes(app, company);
app.get("/api/auth/state", () => ({ state: "ok", telegramReset: false }));
app.get("/api/space", () => ({ space }));
app.get("/api/approvals", () => ({ pending: [], history: [] }));
app.get("/api/approvals/events", (_request, reply) => reply.type("text/event-stream").send(": fixture\n\n"));
await app.register(staticPlugin, { root: path.join(repository, "apps/web/dist") });
app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.status(404).send({ error: "fixture_route_missing" }) : reply.sendFile("index.html"));
async function stopChild() {
  const current = child;
  if (current && current.exitCode === null) await new Promise<void>(resolve => { current.once("exit", () => resolve()); current.kill(); });
  child = undefined;
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(root, `preview.sqlite${suffix}`), { force: true });
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopChild(); await app.close(); close(); fs.rmSync(root, { recursive: true, force: true });
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ host: "127.0.0.1", port: 8788 });
console.log(`Isolated UI fixture (simulated bridge): http://127.0.0.1:8788/company/projects/${project.id}`);
