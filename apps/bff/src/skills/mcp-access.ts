// Which agent may use which MCP server. OpenClaw's MCP servers (mcp.servers) are shared by every
// agent; their tools are named "<server>__<tool>". An agent without access gets "<server>__*" in
// its own tool deny list (agents.entries.<id>.tools.deny), which OpenClaw enforces for every
// runtime. Sandboxed agents additionally need OpenClaw's sandbox gate opened for MCP tools
// ("bundle-mcp"), otherwise even granted servers stay invisible inside the sandbox.
// Pure functions, unit-tested.

type ToolPolicy = { allow?: string[]; alsoAllow?: string[]; deny?: string[] };
export type McpAccessConfig = {
  mcp?: { servers?: Record<string, unknown> };
  tools?: { sandbox?: { tools?: ToolPolicy } };
  agents?: { entries?: Record<string, { tools?: ToolPolicy }> };
};

/** Deny entries this panel writes; nothing else in a deny list looks like this. */
const SERVER_GLOB = /^[a-z][a-z0-9-]{0,39}__\*$/;
export const MCP_SANDBOX_GATE = "bundle-mcp";

export const serverGlob = (server: string): string => `${server}__*`;

export function mcpAccessPatch(config: McpAccessConfig, agentIds: Iterable<string>, grants: ReadonlyMap<string, ReadonlySet<string>>): Record<string, unknown> | null {
  const servers = Object.keys(config.mcp?.servers ?? {});
  const entries: Record<string, { tools: { deny: string[] } }> = {};
  for (const agentId of agentIds) {
    const current = config.agents?.entries?.[agentId]?.tools?.deny ?? [];
    const denied = servers.filter((server) => !grants.get(server)?.has(agentId)).map(serverGlob);
    const next = [...current.filter((entry) => !SERVER_GLOB.test(entry)), ...denied];
    if (JSON.stringify(next) !== JSON.stringify(current)) entries[agentId] = { tools: { deny: next } };
  }
  const patch: Record<string, unknown> = {};
  if (Object.keys(entries).length) patch.agents = { entries };
  const gate = sandboxGatePatch(config.tools?.sandbox?.tools, servers.length > 0);
  if (gate) patch.tools = { sandbox: { tools: gate } };
  return Object.keys(patch).length ? patch : null;
}

/** Adds "bundle-mcp" to the sandbox tool gate once any MCP server exists; never removes a deny. */
function sandboxGatePatch(policy: ToolPolicy = {}, needed: boolean): ToolPolicy | null {
  if (!needed || policy.deny?.includes(MCP_SANDBOX_GATE)) return null;
  const key = policy.allow?.length ? "allow" : "alsoAllow";
  const current = policy[key] ?? [];
  return current.includes(MCP_SANDBOX_GATE) ? null : { [key]: [...current, MCP_SANDBOX_GATE] };
}

/** Array paths a patch from mcpAccessPatch replaces (so removed globs really go away). */
export function mcpAccessReplacePaths(_config: unknown, patch: Record<string, unknown>): string[] {
  const entries = (patch.agents as { entries?: Record<string, unknown> } | undefined)?.entries ?? {};
  const paths = Object.keys(entries).map((agentId) => `agents.entries.${agentId}.tools.deny`);
  const gate = (patch.tools as { sandbox?: { tools?: ToolPolicy } } | undefined)?.sandbox?.tools;
  if (gate) paths.push(...Object.keys(gate).map((key) => `tools.sandbox.tools.${key}`));
  return paths;
}
