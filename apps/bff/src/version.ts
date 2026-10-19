import fs from "node:fs";

// Resolves to apps/bff/package.json from both src/ (tsx) and dist/ (node).
// A UTF-8 BOM (Windows editors) is stripped: JSON.parse rejects it.
const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8").replace(/^﻿/, "");
const pkg = JSON.parse(raw) as { version: string };

/** The release (0.1.N) baked into the panel image by the release workflow; the package version in development. */
export const PANEL_VERSION: string = process.env.CLAWDESK_VERSION?.trim() || pkg.version;
