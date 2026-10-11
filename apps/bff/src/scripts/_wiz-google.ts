import { connectForScript, short } from "./_cli.js";
type Step = { id: string; type: string; title?: string; message?: string; options?: { value: unknown; label: string }[]; sensitive?: boolean; initialValue?: unknown; placeholder?: string };
const { gateway, done } = await connectForScript();
let sessionId: string | undefined;
let finished = false;
try {
  let res = await gateway.request<{ sessionId: string; done: boolean; step?: Step; status?: string; error?: string }>("wizard.start", { mode: "local", flow: "setup" });
  sessionId = res.sessionId;
  for (let i = 0; i < 40 && !res.done && res.step; i++) {
    const s = res.step;
    const opts = s.options?.map((o) => `${o.label}=${JSON.stringify(o.value)}`).slice(0, 12).join(" | ");
    console.log(`#${i + 1} [${s.type}${s.sensitive ? ",sensitive" : ""}] ${s.title ?? ""} :: ${short(s.message ?? "", 160).replace(/\n/g, " ")}${opts ? `\n    opts: ${opts}` : ""}${s.initialValue !== undefined ? ` init=${JSON.stringify(s.initialValue)}` : ""}`);
    let value: unknown;
    const text = `${s.title ?? ""} ${s.message ?? ""}`;
    const pick = (re: RegExp) => s.options?.find((o) => re.test(`${o.label} ${String(o.value)}`))?.value;
    if (s.type === "note" || s.type === "progress" || s.type === "action") value = undefined;
    else if (s.type === "confirm" && /understand|risk/i.test(text)) value = true;
    else if (s.type === "confirm") value = false;
    else if (s.type === "select" && /better/i.test(text)) value = false;
    else if (s.type === "select" && /setup mode/i.test(text)) value = "quickstart";
    else if (s.type === "select" && /model\/auth provider/i.test(text)) value = "google";
    else if (s.type === "select" && /default model/i.test(text)) value = "__manual__";
    else if (s.type === "text" && s.sensitive) value = "AIzaClawdeskInvalidProbeKey000000000000000";
    else if (s.type === "text" && /model/i.test(text)) value = "google/gemini-2.5-flash";
    else if (s.type === "select" && pick(/skip|later|not now|no thanks|__skip__|__keep__/i) !== undefined) value = pick(/skip|later|not now|no thanks|__skip__|__keep__/i);
    else if (s.type === "multiselect") value = [];
    else { console.log("→ stop here (unknown)"); break; }
    res = await gateway.request("wizard.next", { sessionId, answer: { stepId: s.id, ...(value === undefined ? {} : { value }) } }, { timeoutMs: 120_000 });
    if (res.error) console.log("   error:", res.error);
  }
  finished = res.done;
  console.log("finished:", res.done, res.status ?? "", res.error ?? "");
} finally {
  if (sessionId && !finished) await gateway.request("wizard.cancel", { sessionId }).catch(() => undefined);
  await done();
}
