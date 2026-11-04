import { resetGateway } from "./clawdesk-backup.mjs";

/** Find a sibling service only within the uniquely identified Gateway's Compose project. */
export async function composeServiceContainer(command, service, identity) {
  if (!/^[a-z][a-z0-9-]*$/.test(service)) throw new Error("Invalid Compose service");
  const gateway = await resetGateway(command, identity);
  const project = gateway.Config.Labels["com.docker.compose.project"];
  const ids = (await command(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`])).trim().split(/\s+/).filter(Boolean);
  return ids.length === 1 ? ids[0] : null;
}
