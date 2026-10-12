// Issues a new owner code and prints the link to set the panel password with it.
// First run, or a forgotten password when the Telegram bot cannot help. Works while the panel runs;
// the previous code stops working.
//
//   dev:        pnpm --filter @clawdesk/bff owner-code [panel address]
//   container:  docker compose -f deploy/docker-compose.yml exec panel node dist/cli/owner-code.js [panel address]
//
// --first-run (init.sh): print the existing first-run code, and nothing once the owner has a password.
import fs from "node:fs";
import { OwnerCodeFile } from "../auth/owner-code.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { panelUsers } from "../db/schema.js";

if (process.env.NODE_ENV !== "production" && fs.existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const args = process.argv.slice(2);
const firstRun = args.includes("--first-run");
const base = args.find((a) => !a.startsWith("--"))?.replace(/\/$/, "") ?? "<panel address>";
const codes = new OwnerCodeFile(config.dataDir);

if (firstRun) {
  const hasOwner = fs.existsSync(config.dbPath) && withDb((db) => !!db.select().from(panelUsers).all().some((u) => u.passwordHash));
  if (hasOwner) process.exit(0);
  const code = codes.existingOrNew();
  console.log(`Open ${base}/setup?code=${code} to create the panel password.`);
} else {
  const code = codes.issue();
  console.log(`Owner code: ${code}`);
  console.log(`Open ${base}/setup?code=${code} and set a new password.`);
  console.log("The code works once. Every browser signed in before is signed out.");
}

function withDb<T>(use: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const { db, close } = openDb(config.dbPath);
  try {
    return use(db);
  } finally {
    close();
  }
}
