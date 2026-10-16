/** Declaration keys also deduplicate user reminders; only reserved housekeeping keys are internal. */
export function isSystemJob(job: { declarationKey?: string; payload?: { kind?: string } }): boolean {
  return /^(heartbeat|skill-collection-review|memory-core):/.test(job.declarationKey ?? "")
    || ["heartbeat", "skillCollectionReview"].includes(job.payload?.kind ?? "");
}
