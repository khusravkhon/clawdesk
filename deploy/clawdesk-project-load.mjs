// P9 (acceptance 15): a load check of a generated app. The app runs alone in its container with the same
// limits as in checks; the load client runs in another container that shares only its loopback network
// (see ProjectBuilder.load). The client keeps `concurrency` workers busy for `durationMs`, each alternating
// a list and a create request, and prints one result line prefixed by a per-run nonce. The numbers hold for
// these conditions only; the panel shows them next to the result.

export const LOAD_LIMITS = { maxConcurrency: 50, maxDurationMs: 20_000, minDurationMs: 2_000 };

/** The load client: CLAWDESK_APP_URL from the environment, [nonce, concurrency, durationMs] from argv. */
export const LOAD_BOOTSTRAP = `const [nonce, concurrencyText, durationText] = process.argv.slice(1);
const base = process.env.CLAWDESK_APP_URL ?? "http://127.0.0.1:3000";
const concurrency = Number(concurrencyText), duration = Number(durationText);
const out = (value) => console.log(nonce + JSON.stringify(value));
try {
  // Wait for the app (up to 10 s), like the tests do.
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await fetch(base + "/api/tasks", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) { out({ error: "app_not_ready" }); process.exit(0); }
  const latencies = [], statuses = {};
  let errors = 0, sequence = 0;
  const stop = Date.now() + duration;
  const one = async (create) => {
    const started = performance.now();
    try {
      const response = await fetch(base + "/api/tasks", create ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Нагрузка " + (++sequence) }), signal: AbortSignal.timeout(5000) } : { signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      if (response.status >= 500) errors++;
    } catch { errors++; statuses.network = (statuses.network ?? 0) + 1; }
    latencies.push(performance.now() - started);
  };
  const began = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    for (let index = 0; Date.now() < stop; index++) await one((index + worker) % 2 === 1);
  }));
  const elapsed = Date.now() - began;
  latencies.sort((a, b) => a - b);
  const at = (share) => latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(share * latencies.length))]) : null;
  out({ requests: latencies.length, errors, statuses, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: latencies.length ? Math.round(latencies.at(-1)) : null, rps: Math.round(latencies.length / (elapsed / 1000) * 10) / 10, elapsedMs: elapsed });
} catch (error) { out({ error: String(error?.message ?? error).slice(0, 200) }); }
`;

/** The client's result line, or null when there is none (the run then reads as blocked). */
export function parseLoadOutput(stdout, nonce) {
  const line = String(stdout).split("\n").find((item) => item.startsWith(nonce));
  if (!line) return null;
  try { return JSON.parse(line.slice(nonce.length)); } catch { return null; }
}
