import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openDb } from "../db/client.js";
import { LibraryService } from "../library/library-service.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "library-benchmark-"));
const opened = openDb(path.join(dir, "panel.sqlite"));
try {
  const library = new LibraryService(opened.db);
  const body = "Материал о расписании. ".repeat(900);
  const unique = process.argv.includes("--unique");
  for (let i = 0; i < 1200; i++) library.add({ agentId: "main", kind: "document", title: `${i}`, source: `${i}.txt`, text: `${body} ${i % 100 === 0 ? "маркерпамяти" : "обычный текст"} ${unique ? i : i % 100}` });
  library.search("маркерпамяти", "main");
  const times: number[] = [];
  let result;
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    result = library.search("маркерпамяти", "main");
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ unique, hits: result!.hits.length, searched: result!.searched, partial: result!.partial, medianMs: times[15], p95Ms: times[28] }));
  console.log(JSON.stringify({ bytes: fs.statSync(path.join(dir, "panel.sqlite")).size, walBytes: fs.statSync(path.join(dir, "panel.sqlite-wal")).size }));
} finally {
  opened.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
