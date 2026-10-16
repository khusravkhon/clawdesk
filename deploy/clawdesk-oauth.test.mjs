import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizationCode, mcpLoginArgs } from "./clawdesk-oauth.mjs";

test("accepts opaque codes with provider punctuation and lengths over the old limit", () => {
  for (const code of ["a+/b=c:%value", "a".repeat(4096), "abc._~-123", "--option-shaped-code"]) {
    assert.equal(isAuthorizationCode(code), true);
    assert.deepEqual(mcpLoginArgs("notion", code), ["mcp", "login", "notion", `--code=${code}`]);
  }
});

test("preserves spaces, percent sequences and shell punctuation in one option value", () => {
  const code = " opaque%2B+/='value';$(command) ";
  assert.equal(isAuthorizationCode(code), true);
  assert.equal(mcpLoginArgs("notion", code)[3].slice("--code=".length), code);
  assert.equal(mcpLoginArgs("notion", code).length, 4);
});

test("rejects missing codes, control characters and excessive byte lengths", () => {
  for (const code of [null, undefined, 123, {}, "", "   ", "a\0b", "a\nb", "a\rb", "a\tb", "a\x7fb", "a\x85b", "a".repeat(16_385), "\u00e9".repeat(8193)]) {
    assert.equal(isAuthorizationCode(code), false);
  }
  assert.equal(isAuthorizationCode("a".repeat(16_384)), true);
  assert.equal(isAuthorizationCode("\u00e9".repeat(8192)), true);
});
