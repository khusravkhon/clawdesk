import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Requests up the company structure (stage 6). The tools only file what an agent asked for into a spool
// folder of the Gateway; the panel reads it, decides who the request goes to, checks who may answer and
// delivers every answer to the agents' chats. Nothing here grants access or trusts the agent's text:
// the agent's identity comes from the runtime context, never from the arguments.
// The same tool call is filed once (its file name comes from the agent, session and call ID).

const ID = "clawdesk-requests";
export const UP = "clawdesk_request_up";
export const REPLY = "clawdesk_request_reply";
export const REPORT = "clawdesk_task_report";
export const REVIEW = "clawdesk_task_review";
export const SHARE = "clawdesk_share_file";
const MAX_SPOOL = 500;
const AGENT = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const text = (min, max) => ({ type: "string", minLength: min, maxLength: max });
const upParameters = {
  type: "object", additionalProperties: false, required: ["kind", "subject", "details"],
  properties: {
    kind: { type: "string", enum: ["question", "decision", "access"] },
    subject: text(1, 200),
    details: text(1, 4000),
    taskRef: text(1, 200),
    resource: { type: "string", pattern: "^(folder|mcp|gdoc):.{1,300}$" },
    access: { type: "string", enum: ["read", "write"] },
  },
};
const replyParameters = {
  type: "object", additionalProperties: false, required: ["requestId", "action", "text"],
  properties: {
    requestId: { type: "string", pattern: "^REQ-[0-9]{1,6}$" },
    action: { type: "string", enum: ["answer", "deny", "clarify", "escalate", "reply"] },
    text: text(1, 4000),
  },
};
const reportParameters = {
  type: "object", additionalProperties: false, required: ["taskId", "status", "result"],
  properties: {
    taskId: { type: "string", pattern: "^WI-[0-9]{1,6}$" },
    status: { type: "string", enum: ["done", "failed"] },
    result: text(1, 4000),
  },
};
const reviewParameters = {
  type: "object", additionalProperties: false, required: ["taskId", "decision", "comment"],
  properties: {
    taskId: { type: "string", pattern: "^WI-[0-9]{1,6}$" },
    decision: { type: "string", enum: ["accept", "return"] },
    comment: text(1, 2000),
  },
};
const shareParameters = {
  type: "object", additionalProperties: false, required: ["to", "file", "instruction"],
  properties: {
    to: text(1, 80),
    // As the agent saw it: media://inbound/…, the staged path …/media/inbound/openclaw-staged-…/input-… OpenClaw
    // shows it, or a path in the shared folder. The panel resolves and checks it strictly; here one line only.
    file: { type: "string", pattern: "^[^\r\n]{1,400}$" },
    name: text(1, 120),
    instruction: text(1, 4000),
  },
};
const result = (status, code, extra = {}) => {
  const details = { status, ...(code ? { code } : {}), ...extra };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
};

function identity(ctx) {
  const agentId = ctx?.agentId, sessionKey = ctx?.sessionKey, getConfig = ctx?.getRuntimeConfig;
  if (typeof agentId !== "string" || !AGENT.test(agentId)) return null;
  if (typeof sessionKey !== "string" || sessionKey.length > 512 || !sessionKey.startsWith(`agent:${agentId}:`) || sessionKey === `agent:${agentId}:` || /[\x00-\x1f\x7f]/.test(sessionKey) || typeof getConfig !== "function") return null;
  return { agentId, sessionKey, getConfig };
}

function permitted(owner) {
  try {
    const config = owner.getConfig();
    const entry = config?.plugins?.entries?.[ID];
    return config?.plugins?.enabled !== false && entry?.enabled === true &&
      (config.plugins.allow === undefined || (Array.isArray(config.plugins.allow) && config.plugins.allow.includes(ID))) &&
      (!Array.isArray(config.plugins.deny) || !config.plugins.deny.includes(ID)) &&
      Array.isArray(entry.config?.allowedAgentIds) && entry.config.allowedAgentIds.includes(owner.agentId) &&
      (owner.agentId === "main" || Object.hasOwn(config?.agents?.entries ?? {}, owner.agentId));
  } catch { return false; }
}

/** Exactly the declared keys with the declared types; strings trimmed, no NUL. */
function validArgs(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return null;
  const keys = Reflect.ownKeys(args);
  if (keys.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key)) || schema.required.some((key) => !keys.includes(key))) return null;
  const out = {};
  for (const key of keys) {
    const rule = schema.properties[key], value = args[key];
    if (typeof value !== "string" || value.includes("\0")) return null;
    const trimmed = value.trim();
    if (rule.enum && !rule.enum.includes(trimmed)) return null;
    if (rule.pattern && !new RegExp(rule.pattern).test(trimmed)) return null;
    if (rule.minLength !== undefined && (trimmed.length < rule.minLength || trimmed.length > rule.maxLength)) return null;
    out[key] = trimmed;
  }
  return out;
}

export function registerRequests(api, { spoolDir = path.join(process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw", "clawdesk", "requests"), now = Date.now, waitMs = 20_000, pollMs = 500 } = {}) {
  /**
   * clawdesk_share_file waits for the panel's answer (it reads the spool every few seconds) so the agent tells the
   * owner what really happened in the same turn. The answer file is used by whoever removes it first; past the
   * wait the panel delivers it as a message, so it is never lost and never comes twice.
   */
  async function decided(id) {
    const target = path.join(spoolDir, "results", `${id}.json`);
    for (const until = Date.now() + waitMs; Date.now() < until;) {
      let text = null;
      try { text = JSON.parse(await fs.readFile(target, "utf8"))?.text; } catch { /* not there yet */ }
      if (typeof text === "string" && text) {
        try { await fs.unlink(target); } catch { break; }
        return result("decided", null, { panel: text, note: "This is the panel's answer. Tell the owner exactly this; nothing else has happened yet." });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return result("filed", null, { note: "The panel has not answered yet; its answer comes to your chat. Do not tell the owner the file was given or proposed until it does, and do not file it again." });
  }

  async function file(owner, toolCallId, type, args) {
    // An access request names its resource and level; other kinds do not.
    if (type === "up" && (args.kind === "access") !== (args.resource !== undefined && args.access !== undefined)) return result("error", "invalid_arguments");
    if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256) return result("error", "invalid_request_id");
    const id = createHash("sha256").update(JSON.stringify([owner.agentId, owner.sessionKey, toolCallId])).digest("hex").slice(0, 32);
    const target = path.join(spoolDir, `${id}.json`);
    try {
      await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 });
      const entries = await fs.readdir(spoolDir);
      if (entries.length >= MAX_SPOOL && !entries.includes(`${id}.json`)) return result("busy", "requests_queue_full");
      await fs.writeFile(target, JSON.stringify({ id, type, agentId: owner.agentId, sessionKey: owner.sessionKey, at: now(), ...args }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") return result("error", "requests_unavailable");
    }
    if (type === "share") return decided(id);
    return result("filed", null, { note: "The panel routes this and delivers the answer to your chat. Do not file it again; wait for the message." });
  }

  const tool = (name, label, description, parameters, type, only) => (ctx) => {
    const owner = identity(ctx);
    if (!owner || !permitted(owner) || (only && owner.agentId !== only)) return null;
    return {
      name, label, description, parameters,
      execute: async (toolCallId, args) => {
        if (!permitted(owner)) return result("forbidden", "requests_not_granted");
        const valid = validArgs(args, parameters);
        if (!valid) return result("error", "invalid_arguments");
        return file(owner, toolCallId, type, valid);
      },
    };
  };

  api.registerTool(tool(UP, "Ask up the company", "File a request to your supervisor in the company (department manager, then the main agent, then the owner). kind: question (you need information), decision (you need someone to decide) or access (you need a resource: set resource to folder:<shared folder name>, mcp:<server name> or gdoc:<Google Doc link or ID> (a Google Doc is given read-only, as a copy in google/ of your workspace), and access to read or write). The panel delivers the answer to your chat; until then the work it blocks waits. Only the owner grants access, and the panel checks it before telling you.", upParameters, "up"), { names: [UP], optional: true });
  api.registerTool(tool(REPLY, "Reply to a company request", "Reply to a request REQ-… addressed to you: answer (give the information or decision), deny (with the reason), clarify (ask the requester a question), escalate (pass it to the next level). The requester uses reply to answer a clarification. Only the current addressee can act; a text answer never grants access.", replyParameters, "reply"), { names: [REPLY], optional: true });

  api.registerTool(tool(REVIEW, "Accept or return a team member's task", "As the team lead, decide on a company task WI-… your team member reported as done: accept (the result meets the criteria; say what you checked) or return (with what to fix). Only the lead of the executor's team can decide; the owner can decide too.", reviewParameters, "task_review"), { names: [REVIEW], optional: true });
  api.registerTool(tool(REPORT, "Report a company task", "Report the result of a company task WI-… assigned to you: status done with what was done and where to see it (it goes to the owner's acceptance), or failed with the reason. Done without a result is not accepted. Only the task's executor can report.", reportParameters, "task_report"), { names: [REPORT], optional: true });

  // The owner's files: only the main agent proposes; the owner confirms with a button, the panel copies and checks.
  api.registerTool(tool(SHARE, "Give the owner's file to an agent", "When the owner sends you a file (it reaches you as media://inbound/…) or names one in the shared folder and asks to give it to a company agent, propose it with this tool: to (the agent's ID or name), file (exactly as you received it: media://inbound/… or the path of the attached file, e.g. …/media/inbound/openclaw-staged-…/input-ТЗ---….pdf; or the file's path in the shared folder, e.g. Входящие/ТЗ.pdf), name (optional, a clear file name) and instruction (what the owner wants the agent to do with it, in the owner's words). The panel saves the file to the owner's «Входящие» and asks the owner to confirm with a button; only then the agent gets a read-only copy and the instruction. You never give access yourself. The tool returns the panel's answer: pass it to the owner as is; if it lists several agents, ask the owner in a normal message which one and call the tool again with that ID.", shareParameters, "share", "main"), { names: [SHARE], optional: true });

  registerOwnerCommand(api, { spoolDir, now });

  // Stage 8: the owner's buttons on a request in Telegram ("cdreq:<token>"). OpenClaw hands the press to
  // this handler, never to a model, with the pressing user's numeric ID. The handler only files it; the
  // panel checks that the owner pressed it and that the token is unused, current and for an open request.
  if (typeof api.registerInteractiveHandler === "function") {
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: BUTTONS,
      handler: async (ctx) => {
        const token = typeof ctx?.callback?.payload === "string" ? ctx.callback.payload.trim() : "";
        const senderId = typeof ctx?.senderId === "string" ? ctx.senderId.trim() : "";
        if (!TOKEN.test(token) || !/^[0-9]{1,20}$/.test(senderId) || typeof ctx.callbackId !== "string" || !ctx.callbackId) return { handled: true };
        const id = createHash("sha256").update(JSON.stringify(["button", ctx.callbackId])).digest("hex").slice(0, 32);
        try {
          await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 });
          if ((await fs.readdir(spoolDir)).length < MAX_SPOOL) await fs.writeFile(path.join(spoolDir, `${id}.json`), JSON.stringify({ id, type: "owner_button", agentId: "telegram", token, senderId, accountId: String(ctx.accountId ?? ""), at: now() }), { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error?.code !== "EEXIST") return { handled: true };
        }
        // The buttons go away at once so a second press cannot repeat it; the panel answers with the result.
        await ctx.respond?.clearButtons?.().catch?.(() => undefined);
        return { handled: true };
      },
    });
  }
}

/**
 * Stage 8: the owner answers a request with text in Telegram — "/req REQ-003 ответ <текст>", "отказ <причина>"
 * or "уточни <вопрос>" (answer / deny / clarify also work). A plugin command bypasses the model; it files the
 * command with the sender's numeric ID, and the panel acts only if that is the owner.
 */
export function registerOwnerCommand(api, { spoolDir, now }) {
  if (typeof api.registerCommand !== "function") return;
  api.registerCommand({
    name: "req",
    description: "Answer a company request: /req REQ-003 ответ|отказ|уточни <текст>",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (ctx?.channel !== "telegram") return { text: "Команда работает только в Telegram." };
      const senderId = typeof ctx.senderId === "string" ? ctx.senderId.trim() : String(ctx.senderId ?? "");
      const match = /^\s*(REQ-\d{1,6})\s+(\S+)\s+([\s\S]{1,4000})$/iu.exec(typeof ctx.args === "string" ? ctx.args : "");
      const action = match ? OWNER_ACTIONS[match[2].toLocaleLowerCase()] : undefined;
      if (!/^[0-9]{1,20}$/.test(senderId) || !match || !action || !match[3].trim()) return { text: "Формат: /req REQ-003 ответ <текст> (или отказ <причина>, уточни <вопрос>)." };
      const requestId = match[1].toUpperCase(), text = match[3].trim();
      const id = createHash("sha256").update(JSON.stringify(["owner_text", senderId, requestId, action, text, Math.floor(now() / 60_000)])).digest("hex").slice(0, 32);
      try {
        await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 });
        if ((await fs.readdir(spoolDir)).length >= MAX_SPOOL) return { text: "Очередь панели переполнена, попробуйте позже." };
        await fs.writeFile(path.join(spoolDir, `${id}.json`), JSON.stringify({ id, type: "owner_text", agentId: "telegram", senderId, requestId, action, text, at: now() }), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error?.code !== "EEXIST") return { text: "Панель сейчас недоступна, ответ не принят." };
      }
      return { text: `Принято: ${requestId}. Панель проверит и пришлёт итог.` };
    },
  });
}
const OWNER_ACTIONS = { "ответ": "answer", answer: "answer", "отказ": "deny", deny: "deny", "уточни": "clarify", "уточнить": "clarify", clarify: "clarify" };

export const BUTTONS = "cdreq";
const TOKEN = /^[A-Za-z0-9_-]{16,40}$/;

export default { id: ID, name: "ClawDesk Requests", register: registerRequests };
