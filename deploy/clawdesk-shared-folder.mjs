import path from "node:path";
import { resetGateway } from "./clawdesk-backup.mjs";

/** Resolve the mount from this installation, even when Docker's hostname is not its container name. */
export async function sharedFolderSource(command, identity) {
  const container = await resetGateway(command, identity);
  const stateDir = identity?.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? "/var/lib/clawdesk/openclaw";
  const mount = container.Mounts.find((item) => item.Destination === path.posix.join(stateDir, "workspace", "files"));
  if (!mount?.Source || mount.Source === "/" || mount.RW === false) return null;
  // Docker Desktop may report the Windows path ("C:/Users/…"); its daemon knows that folder as /run/desktop/mnt/host/c/….
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(mount.Source);
  return win ? `/run/desktop/mnt/host/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}` : mount.Source;
}
