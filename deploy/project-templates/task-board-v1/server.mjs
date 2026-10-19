import http from "node:http";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
const db = new DatabaseSync(process.env.DATA_FILE || new URL("./tasks.sqlite", import.meta.url));
db.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,title TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0)");
const html = await fs.readFile(new URL("./index.html", import.meta.url), "utf8");
const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
};
http.createServer(async (req, res) => {
    try {
        const pathname = new URL(req.url, "http://localhost").pathname;
        if (req.method === "GET" && pathname === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
            return res.end(html);
        }
        const match = /^\/api\/tasks(?:\/([0-9a-f-]{36}))?$/.exec(pathname);
        if (!match)
            return send(res, 404, { error: "not_found" });
        if (req.method === "GET" && !match[1])
            return send(res, 200, db.prepare("SELECT * FROM tasks ORDER BY rowid DESC LIMIT 100").all());
        if (req.method === "DELETE" && match[1]) {
            const result = db.prepare("DELETE FROM tasks WHERE id=?").run(match[1]);
            return send(res, result.changes ? 200 : 404, { ok: !!result.changes });
        }
        if (!["POST", "PATCH"].includes(req.method))
            return send(res, 405, { error: "method_not_allowed" });
        let raw = "";
        for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 8192)
                return send(res, 413, { error: "body_too_large" });
        }
        let body;
        try {
            body = JSON.parse(raw);
        }
        catch {
            return send(res, 400, { error: "invalid_json" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
            return send(res, 400, { error: "invalid_task" });
        if (req.method === "POST" && !match[1]) {
            if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 200)
                return send(res, 400, { error: "invalid_title" });
            if (db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count >= 100)
                return send(res, 409, { error: "task_limit" });
            const id = randomUUID();
            db.prepare("INSERT INTO tasks(id,title) VALUES(?,?)").run(id, body.title.trim());
            return send(res, 201, db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
        }
        if (req.method === "PATCH" && match[1]) {
            if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 200))
                return send(res, 400, { error: "invalid_title" });
            if (body.done !== undefined && typeof body.done !== "boolean")
                return send(res, 400, { error: "invalid_task" });
            if (body.title === undefined && body.done === undefined)
                return send(res, 400, { error: "invalid_task" });
            const result = db.prepare("UPDATE tasks SET title=COALESCE(?,title),done=COALESCE(?,done) WHERE id=?").run(body.title?.trim() ?? null, body.done === undefined ? null : body.done ? 1 : 0, match[1]);
            return send(res, result.changes ? 200 : 404, result.changes ? db.prepare("SELECT * FROM tasks WHERE id=?").get(match[1]) : { error: "not_found" });
        }
        return send(res, 400, { error: "invalid_task" });
    }
    catch {
        if (!res.headersSent)
            send(res, 500, { error: "request_failed" });
        else
            res.end();
    }
}).listen(port, "127.0.0.1");
