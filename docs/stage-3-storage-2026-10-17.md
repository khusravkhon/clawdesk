# Stage 3: personal storage controls

## Implemented

- Personal System screen: logical sizes and counts of saved video originals and previous versions in registered agents' shared **and** managed folders. Unknown or partial inventory displays em dashes for both size and count. Filesystem free space is a separate measurement.
- Video quota is disabled by default. Owner can set a MiB limit; existing files are never automatically deleted. Bridge reserves `min(requestedMaximum, remainingQuota)` under a serial gate before starting a download, considers existing files and concurrent reservations, and releases its reservation in `finally`. Partial files belonging to running downloads can be counted conservatively in addition to reservations.
- A configured quota fails closed on inventory errors, invalid persisted settings, unavailable Docker, or unknown panel mode. Explicit company mode keeps its existing download behavior. A worker surviving bridge restart without a known reservation blocks new quota-controlled downloads until it ends; no download is replayed to reconstruct a reservation.
- Cleanup is explicit category selection -> preview -> confirmation of a short-lived token. Tokens expire after 5 minutes, are single use, and contain at most 500 exact file snapshots. Client paths are never accepted. There are at most 10 outstanding previews per bridge process.
- Video eligibility is restricted to generated UUID job directories and `video.<extension>`. Running worker files, unrelated files, working files and retained quarantine entries are excluded. History roots come from the validated agent folder registry; managed workspace identity must match the registered directory identity.
- Linux directory handles, `O_NOFOLLOW`, bounded traversal (20,000 entries, 16 levels), ancestor identity and file metadata checks prevent path redirection through symlinks or replaced ancestors. Cleanup takes the selected entry into a random quarantine name in its held parent directory, rechecks its identity, then unlinks only a matching regular file. Unexpected replacements are restored with exclusive hard-link creation where possible; conflicting or unsupported entries are retained and reported without overwriting another file. Errors after moving a file into quarantine also report the retained entry. Cleanup never recursively deletes a directory.
- The result reports deleted logical bytes, skipped entries, retained count, and at most 20 retained relative paths. Retained entries are excluded from subsequent cleanup and surfaced in category counts with a sample of at most 20 actual relative paths, including after a bridge/UI restart. Original names are not reconstructed after restart. Operator review is required for retained entries. Logical file bytes are **not** a promise of physically reclaimed space: working or external hard links can retain the data.
- Transcripts, notes, job records and other working files are retained. Download of a removed original returns the existing safe `not_found` response.
- Previously queued videos resume after Gateway readiness. Previously running videos are marked `panel_restarted` and are not automatically replayed. Shutdown stops queue advancement and prevents delayed readiness/worker completion from touching a closed database.
- Folder metadata caching is enabled via a mode getter only when the read-only panel database confirms personal mode; absent/unreadable mode disables it. Registry, originals and existing comments are preserved.

## API

- `GET /api/system/storage`
- `POST /api/system/storage/quota` `{videoQuotaBytes: number|null}`
- `POST /api/system/storage/preview` `{category: "videos"|"history"}`
- `POST /api/system/storage/cleanup` `{token: UUID, confirm: true}`

All four BFF routes require the existing owner session and reject company mode. Bridge equivalents remain loopback/token protected and additionally check personal mode. Bridge diagnostics are restricted to safe codes; raw Docker output and absolute private paths are not returned.

## Verification

Tests mutate only isolated temporary files/databases. The Linux test runner uses a read-only repository bind and a temporary filesystem, never the personal Docker volumes:

```powershell
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=768m --mount 'type=bind,source=E:\my_project\clawdesk\deploy,target=/work,readonly' --workdir /work node:22-alpine node --test clawdesk-storage.test.mjs
```

The initial nine storage tests passed. A tenth test covers unlink failure after quarantine. BFF route regressions cover mode restriction, quota/confirmation validation, safe diagnostics and ignored client paths. Video regressions cover restored queued work waiting for readiness, no replay of running work, and queue shutdown with a closed database. Final suite/build/UI results are collected in the overall stage-3 verification; the local final rerun was interrupted by approval-review usage exhaustion. A BFF typecheck completed successfully before that interruption.

## Limits

This is bounded logical inventory and manually confirmed cleanup, not automatic retention or a transactional filesystem. Observed ancestor/replacement changes fail closed; there is no absolute atomic compare-and-unlink guarantee against a process deliberately modifying the same inode in the last metadata-check window while restoring its size/mtime. The held parent cannot redirect deletion outside the approved tree; removing one hard link never removes another working link. Do not describe these checks as eliminating all filesystem races.

Quota reservations govern simultaneous bridge downloads, not bytes written by arbitrary external processes. Lowering the quota does not cancel work already in progress. Docker-worker enumeration is intentionally conservative after a restart. Preview tokens are invalidated by bridge restart; re-open the preview instead of retrying a destructive request with an old token.

No changes were deployed to the personal stack, and no commit or push was performed as part of this stage.
