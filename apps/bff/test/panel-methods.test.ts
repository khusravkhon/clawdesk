import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PANEL_METHODS } from "../src/contract/panel-methods.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** `.request("method"` calls in the panel's code; probes (scripts/) and the contract test itself are not the panel. */
function calledMethods(dir: string, found = new Set<string>()): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "scripts" && entry.name !== "contract") calledMethods(file, found);
    } else if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(/\.request(?:<[^()]*?>)?\(\s*"([a-z][\w.]*)"/g)) found.add(match[1]!);
    }
  }
  return found;
}

it("the contract test's method list covers every Gateway RPC the panel calls", () => {
  const called = calledMethods(SRC);
  expect(called.size).toBeGreaterThan(40);
  expect([...called].filter((method) => !(PANEL_METHODS as readonly string[]).includes(method))).toEqual([]);
});
