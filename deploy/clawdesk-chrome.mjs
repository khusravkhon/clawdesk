// The person's own signed-in Chrome, driven through the OpenClaw extension (browser profile "chrome").
// OpenClaw has no RPC for pairing, so the panel asks through the CLI.

export class ChromeError extends Error {}

// The extension connects to the panel's own address: ws/wss, a host and an optional port, nothing else.
const GATEWAY_URL = /^wss?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

function json(result) {
  if (result.code !== 0) throw new ChromeError("chrome_unavailable");
  try {
    return JSON.parse(result.out.slice(result.out.indexOf("{")));
  } catch {
    throw new ChromeError("chrome_unavailable");
  }
}

/** connected: the extension is paired and its relay is up right now. */
export async function chromeStatus(runCli) {
  const status = json(await runCli(["browser", "--browser-profile", "chrome", "status", "--json"], { timeoutMs: 20_000 }));
  return { enabled: status.enabled === true, connected: status.running === true };
}

/** The pairing string is a password to the person's browser: it is returned once and never logged. */
export async function chromePair(runCli, gatewayUrl) {
  if (typeof gatewayUrl !== "string" || !GATEWAY_URL.test(gatewayUrl)) throw new ChromeError("invalid_address");
  const { pairingString } = json(await runCli(["browser", "extension", "pair", "--gateway-url", gatewayUrl, "--json"], { timeoutMs: 20_000 }));
  if (typeof pairingString !== "string" || !pairingString) throw new ChromeError("chrome_unavailable");
  return { pairingString };
}
