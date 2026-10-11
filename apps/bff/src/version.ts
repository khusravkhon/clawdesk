import fs from "node:fs";

// Resolves to apps/bff/package.json from both src/ (tsx) and dist/ (node).
// A UTF-8 BOM (Windows editors) is stripped: JSON.parse rejects it.
const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8").replace(/^﻿/, "");
const pkg = JSON.parse(raw) as { version: string };

export const PANEL_VERSION: string = pkg.version;
