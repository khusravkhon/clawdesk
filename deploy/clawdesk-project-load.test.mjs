import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoadOutput } from "./clawdesk-project-load.mjs";

test("only the line with the run's nonce counts", () => {
  assert.deepEqual(parseLoadOutput("noise\nabc{\"requests\":3}\n", "abc"), { requests: 3 });
  assert.equal(parseLoadOutput('xyz{"requests":3}', "abc"), null);
  assert.equal(parseLoadOutput("abc{broken", "abc"), null);
});
