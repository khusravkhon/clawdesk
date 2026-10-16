# Managed Personal-Agent Folders

Personal agents do not bind the user's Windows/macOS/Linux shared folder into
their sandboxes. The bridge copies only the selected subfolder into
`<agent-workspace>/folders/<name>`. OpenClaw's normal workspace mount exposes it
as `/workspace/folders/<name>` with sandbox isolation still enabled.

The bridge exchanges changed regular files every 15 seconds. It never follows
symlinks, traverses other agents' directories, or propagates deletions. A missing
copy is restored from the remaining copy. Simultaneous edits preserve the agent
version in a `.conflict-<hash>` file; the owner's version keeps the original name.
Prior overwritten files are retained in hidden `.clawdesk-history` directories.

Limits per folder scan: 10,000 files, 30 directory levels, 32 MiB per file and
256 MiB total. An unsupported file or exceeded limit stops that folder's exchange
without deleting either side; the bridge logs the failure. History is retained
until the owner removes it and is not synchronized back and forth.

The registration and last common hashes live at
`<OPENCLAW_STATE_DIR>/clawdesk/folder-sync.json`, outside junior workspaces.
Registrations include the workspace inode identity, so a reused agent ID does
not silently inherit the previous agent's data. Deleted agents are not recreated.
All exchange runs inside Linux containers on each supported host OS; no Docker
Desktop-specific `/run/desktop/...` path is passed to a personal sandbox.

On panel startup, existing personal folder grants are registered and imported
before their matching legacy bind is removed. Other custom binds are preserved.
Company-team repository/document mounts are not changed by this migration.

Before rolling back, stop the panel, save any new managed files, restore the
protected pre-migration config backup and use the previous panel/Gateway images.
Rolling back only the config while the new panel is running re-applies migration.

Validation: BFF creation/migration tests and
`node --test deploy/clawdesk-agent-folders.test.mjs` inside a Linux container.
Host-native Node on Windows/macOS is not the runtime for this bridge module.
