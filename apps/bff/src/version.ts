import fs from "node:fs";

// Resolves to apps/bff/package.json from both src/ (tsx) and dist/ (node).
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const PANEL_VERSION: string = pkg.version;
