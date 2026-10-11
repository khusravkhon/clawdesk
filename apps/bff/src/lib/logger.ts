import { pino, type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    // Defence in depth: tokens must never reach logs even if an object slips through.
    redact: {
      paths: ["*.token", "*.deviceToken", "*.sharedToken", "*.password", "*.apiKey", "*.value", "req.headers.authorization", "req.headers.cookie"],
      censor: "[redacted]",
    },
  });
}
