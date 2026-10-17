import fs from "node:fs/promises";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Exercise the component's polling lifecycle without mounting its charts or making network calls.
async function polling(hidden = false) {
  const source = await fs.readFile(new URL("../../web/src/views/DashboardView.vue", import.meta.url), "utf8");
  const script = source.slice(source.indexOf("const range ="), source.indexOf("const loc ="));
  const javascript = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let mount = () => {}, unmount = () => {}, changed = () => {}, tick = () => {};
  const listeners = new Map<string, () => void>();
  const document = { hidden, addEventListener: (event: string, handler: () => void) => listeners.set(event, handler), removeEventListener: (event: string) => listeners.delete(event) };
  const pending: Array<(value: unknown) => void> = [];
  const api = { dashboard: vi.fn(() => new Promise((resolve) => pending.push(resolve))) };
  const clear = vi.fn();
  const create = new Function("ref", "onMounted", "onUnmounted", "watch", "api", "ApiError", "document", "setInterval", "clearInterval", `${javascript}; return { range, data, loading, load };`);
  const component = create((value: unknown) => ({ value }), (handler: () => void) => { mount = handler; }, (handler: () => void) => { unmount = handler; }, (_ref: unknown, handler: () => void) => { changed = handler; }, api, Error, document, (handler: () => void) => { tick = handler; return 1; }, clear);
  return { component, api, pending, document, listeners, clear, mount: () => mount(), unmount: () => unmount(), changed: () => changed(), tick: () => tick() };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

it("keeps dashboard polling single-flight and ignores stale range responses", async () => {
  const state = await polling();
  state.mount();
  state.tick(); state.tick();
  expect(state.api.dashboard).toHaveBeenCalledTimes(1);
  state.component.range.value = "90d";
  state.changed();
  state.pending.shift()!({ range: "7d" });
  await settle();
  expect(state.component.data.value).toBeNull();
  expect(state.api.dashboard).toHaveBeenCalledTimes(2);
  expect(state.api.dashboard).toHaveBeenLastCalledWith("90d");
  state.pending.shift()!({ range: "90d" });
  await settle();
  expect(state.component.data.value.range).toBe("90d");
  state.unmount();
});

it("skips hidden tabs, refreshes on visibility, and cleans listeners and late responses on unmount", async () => {
  const state = await polling(true);
  state.mount(); state.tick();
  expect(state.api.dashboard).not.toHaveBeenCalled();
  state.document.hidden = false;
  state.listeners.get("visibilitychange")!();
  expect(state.api.dashboard).toHaveBeenCalledTimes(1);
  state.unmount();
  expect(state.clear).toHaveBeenCalledWith(1);
  expect(state.listeners.size).toBe(0);
  state.pending.shift()!({ range: "7d" });
  await settle();
  expect(state.component.data.value).toBeNull();
  await state.component.load();
  expect(state.api.dashboard).toHaveBeenCalledTimes(1);
});
