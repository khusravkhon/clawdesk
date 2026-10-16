// OAuth codes are opaque provider values, passed unchanged to the CLI without a shell.
const MAX_CODE_BYTES = 16_384;

export function isAuthorizationCode(code) {
  return typeof code === "string" && code.trim().length > 0
    && Buffer.byteLength(code, "utf8") <= MAX_CODE_BYTES && !/[\x00-\x1f\x7f-\x9f]/u.test(code);
}

export function mcpLoginArgs(server, code) {
  return ["mcp", "login", server, `--code=${code}`];
}
