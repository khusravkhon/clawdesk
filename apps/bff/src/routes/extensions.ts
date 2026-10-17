import {
  AddClawHubSkillRequest,
  AddMcpServerRequest,
  McpServerName,
  OwnSkillRequest,
  SetAgentsRequest,
  UploadSkillRequest,
  type ApiErrorDto,
  type ClawHubSearchDto,
  type McpServersDto,
  type OwnSkillContentDto,
  type SkillsDto,
  type StartMcpLoginResultDto,
} from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { BridgeError } from "../gateway/bridge-client.js";
import { MCP_CALLBACK_PATH, McpError, type McpService } from "../skills/mcp-service.js";
import { SkillsError, type SkillsService } from "../skills/skills-service.js";
import { panelOrigin } from "./sources.js";

// "Навыки и MCP": skills and MCP servers the owner hands out per agent.

const SkillParams = z.object({ id: z.string().uuid() });
const ServerParams = z.object({ name: McpServerName });
const SearchQuery = z.object({ q: z.string().trim().max(200).default("") });
const OAuthCallback = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() });
/** A 5 MB archive as base64 in JSON. */
const UPLOAD_BODY_LIMIT = 8 * 1024 * 1024;

export function registerExtensionRoutes(app: FastifyInstance, deps: { skills: SkillsService; mcp: McpService }): void {
  app.get("/api/skills", async (): Promise<SkillsDto> => deps.skills.list());

  app.get("/api/skills/clawhub", async (request, reply): Promise<ClawHubSearchDto | ApiErrorDto> => {
    const { q } = SearchQuery.parse(request.query);
    return withErrors(reply, () => deps.skills.search(q));
  });

  app.post("/api/skills/clawhub", async (request, reply): Promise<SkillsDto | ApiErrorDto> => {
    const body = AddClawHubSkillRequest.parse(request.body);
    return withErrors(reply, () => deps.skills.addClawHub(body));
  });

  app.post("/api/skills/own", async (request, reply): Promise<SkillsDto | ApiErrorDto> => {
    const body = OwnSkillRequest.parse(request.body);
    return withErrors(reply, () => deps.skills.createOwn(body));
  });

  app.post("/api/skills/upload", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply): Promise<SkillsDto | ApiErrorDto> => {
    const body = UploadSkillRequest.parse(request.body);
    return withErrors(reply, () => deps.skills.upload(body));
  });

  app.get("/api/skills/:id/content", async (request, reply): Promise<OwnSkillContentDto | ApiErrorDto> => {
    const { id } = SkillParams.parse(request.params);
    return withErrors(reply, async () => deps.skills.content(id));
  });

  app.put("/api/skills/:id", async (request, reply): Promise<SkillsDto | ApiErrorDto> => {
    const { id } = SkillParams.parse(request.params);
    const body = OwnSkillRequest.parse(request.body);
    return withErrors(reply, () => deps.skills.updateOwn(id, body));
  });

  app.put("/api/skills/:id/agents", async (request, reply): Promise<SkillsDto | ApiErrorDto> => {
    const { id } = SkillParams.parse(request.params);
    const { agentIds } = SetAgentsRequest.parse(request.body);
    return withErrors(reply, () => deps.skills.setAgents(id, agentIds));
  });

  app.delete("/api/skills/:id", async (request, reply): Promise<SkillsDto | ApiErrorDto> => {
    const { id } = SkillParams.parse(request.params);
    return withErrors(reply, () => deps.skills.remove(id));
  });

  // --- MCP servers ---

  app.get("/api/mcp", async (): Promise<McpServersDto> => deps.mcp.list());

  app.post("/api/mcp", async (request, reply): Promise<McpServersDto | ApiErrorDto> => {
    const body = AddMcpServerRequest.parse(request.body);
    return withErrors(reply, () => deps.mcp.add(body, panelOrigin(request)));
  });

  app.put("/api/mcp/:name/agents", async (request, reply): Promise<McpServersDto | ApiErrorDto> => {
    const { name } = ServerParams.parse(request.params);
    const { agentIds } = SetAgentsRequest.parse(request.body);
    return withErrors(reply, () => deps.mcp.setAgents(name, agentIds));
  });

  app.delete("/api/mcp/:name", async (request, reply): Promise<McpServersDto | ApiErrorDto> => {
    const { name } = ServerParams.parse(request.params);
    return withErrors(reply, () => deps.mcp.remove(name));
  });

  app.post("/api/mcp/:name/login", async (request, reply): Promise<StartMcpLoginResultDto | ApiErrorDto> => {
    const { name } = ServerParams.parse(request.params);
    return withErrors(reply, () => deps.mcp.loginStart(name, panelOrigin(request)));
  });

  // The provider sends the browser here after consent; the person lands back on the screen.
  app.get(MCP_CALLBACK_PATH, async (request, reply) => {
    const q = OAuthCallback.parse(request.query);
    if (q.error || !q.code || !q.state) return reply.redirect("/skills?mcp=denied");
    try {
      const server = await deps.mcp.loginComplete(q.code, q.state);
      return reply.redirect(`/skills?mcp=connected&server=${encodeURIComponent(server)}`);
    } catch (error) {
      request.log.warn({ err: error }, "MCP sign-in failed");
      const reason = error instanceof McpError || error instanceof BridgeError ? error.code : "failed";
      return reply.redirect(`/skills?mcp=error&reason=${encodeURIComponent(reason)}`);
    }
  });
}

const CLIENT_ERRORS = new Set(["exists", "not_editable", "not_managed", "token_required", "not_oauth", "oauth_state_mismatch", "bad_file", "no_skill_md", "archive_too_large", "bad_archive", "bad_skill_md", "install_failed"]);

async function withErrors<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SkillsError || error instanceof McpError) {
      reply.status(error.code === "not_found" ? 404 : CLIENT_ERRORS.has(error.code) ? 400 : 502);
      return { error: error.code, message: error.message };
    }
    if (error instanceof BridgeError) {
      reply.status(error.code === "login_failed" ? 400 : 502);
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
