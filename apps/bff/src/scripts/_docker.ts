import { execFileSync } from "node:child_process";

type Command = (args: string[]) => string;

/** Diagnostic scripts must target the same Gateway as their BFF configuration. */
export function gatewayContainerId(token: string | undefined, command: Command = (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 20_000 })): string {
  if (!token) throw new Error("Gateway token is required to identify the installation");
  const ids = command(["ps", "-q", "--filter", "label=com.docker.compose.service=gateway"]).trim().split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error("No running Gateway found");
  const containers = JSON.parse(command(["inspect", ...ids])) as { Id: string; Config?: { Env?: string[]; Labels?: Record<string, string> } }[];
  const matches = containers.filter((item) => item.Config?.Labels?.["com.docker.compose.service"] === "gateway" && item.Config.Env?.includes(`OPENCLAW_GATEWAY_TOKEN=${token}`));
  if (matches.length !== 1) throw new Error("Cannot uniquely identify the configured Gateway");
  return matches[0]!.Id;
}
