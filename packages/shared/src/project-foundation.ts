import type { BusinessRuleFields, ProjectBriefFields } from "./company.js";

// P4: choosing the project's foundation. There is one checked web profile; the panel reads the brief and the
// rules, names the needs it finds (with the sentence it found them in) and says plainly which the profile
// covers. Needs it does not cover are left out of the first version only with the owner's word; other stacks
// are shown as directions for separate development, never as something the panel generates.

export type FoundationNeed = "roles" | "integrations" | "realtime" | "mobile" | "files" | "offline" | "payments" | "messages" | "load";
export type FoundationProfileDto = {
  id: "node-web-v1";
  templateId: "task-board-v1";
  version: string;
  /** Technical details, for those who want them. */
  runtime: string;
  storage: string;
  ui: string;
  tests: string;
  dependencies: string;
  license: string;
  origin: string;
  platforms: string;
  /** Needs this profile covers in the first version. */
  covers: FoundationNeed[];
};
export type FoundationNeedDto = { need: FoundationNeed; covered: boolean; field: keyof ProjectBriefFields | "rule"; evidence: string };
export type FoundationAlternativeDto = { id: "vue-node" | "aspnet" | "mobile" | "realtime"; needs: FoundationNeed[]; generated: false };
export type FoundationDto = {
  profile: FoundationProfileDto;
  /** fits — nothing found that the profile lacks; partial — the first version leaves the listed needs out. */
  fit: "fits" | "partial";
  needs: FoundationNeedDto[];
  alternatives: FoundationAlternativeDto[];
};

export const NODE_WEB_PROFILE: FoundationProfileDto = {
  id: "node-web-v1", templateId: "task-board-v1", version: "1",
  runtime: "Node.js ≥ 22.13, встроенный модуль http, один процесс",
  storage: "SQLite через встроенный node:sqlite, один файл базы",
  ui: "одна страница HTML без сборки и внешних библиотек",
  tests: "node:test, проверки поведения через HTTP; панель запускает их отдельно от кода приложения",
  dependencies: "внешних пакетов нет (lockfile не нужен)",
  license: "MIT", origin: "шаблон ClawDesk, написан и проверен в этом проекте",
  platforms: "любая ОС с Node.js 22.13+; в панели — изолированный контейнер",
  covers: [],
};

/** Where the profile stops; each a direction for separate development, not a generated option. */
export const FOUNDATION_ALTERNATIVES: FoundationAlternativeDto[] = [
  { id: "vue-node", needs: ["roles", "files", "messages"], generated: false },
  { id: "aspnet", needs: ["roles", "integrations", "payments", "load"], generated: false },
  { id: "mobile", needs: ["mobile", "offline"], generated: false },
  { id: "realtime", needs: ["realtime", "load"], generated: false },
];

const SIGNALS: [FoundationNeed, RegExp][] = [
  ["roles", /(рол[ьиейя]|админ|авториз|логин|парол|вход[а-я]* в (систем|прилож)|учётн[а-я]* запис|учетн[а-я]* запис|личн[а-я]+ кабинет|прав[а-я]* доступ|разграничен|role|admin|login|password|sign[ -]?in|permission)/u],
  ["realtime", /(в реальном времени|real[ -]?time|чат|мгновенн|websocket|онлайн-обновл|live[ -]update)/u],
  ["mobile", /(мобильн[а-я]* прилож|android|\bios\b|iphone|айфон|смартфон|app store|google play|mobile app)/u],
  ["files", /(фото|изображени|картинк|вложени|загруз[а-я]* файл|прикреп[а-я]* файл|файл[а-я]* (загруж|прикреп)|upload|attachment|image)/u],
  ["offline", /(без интернета|офлайн|оффлайн|offline|нет сети|без сети)/u],
  ["payments", /(оплат|оплач|платеж|платёж|эквайринг|касс[аы]|stripe|payment|checkout)/u],
  ["messages", /(e-?mail|электронн[а-я]* почт|письм|рассылк|\bsms\b|смс|push-уведомл|уведомлени[яей] на почт)/u],
  ["integrations", /(\bapi\b|интеграц|telegram|телеграм|1с|\b1c\b|\bcrm\b|google|битрикс|webhook|выгрузк[а-я]* в|синхрониз)/u],
];
const NEGATION = /(не нужн|не требу|не будет|не планир|без (этого|него|неё|них)|^нет\b|\bнет\b[.,!]?$|пока не|not needed|no need|\bnone\b)/u;
const EMPTY = /^(нет|не нужно|не требуется|no|none|-|—|n\/a)\.?$/iu;
/** Fields that say what the app is; out-of-scope and open questions are not needs of the first version. */
const SCANNED: (keyof ProjectBriefFields)[] = ["goal", "audience", "scenarios", "inScope", "rules", "data", "integrations", "constraints"];
const LOAD = /(\d[\d\s]{1,9})\s*(?:\+\s*)?(пользовател|человек|клиент|сотрудник|запрос|заказ[а-я]* в (день|час|минуту)|users|requests)/u;

/** "без чата", "не нужен вход", "no login": the word just before the match denies it. */
const denied = (text: string, index: number) => /(?:^|[\s,(])(без|не|нет|no|without)\s+(?:\S+\s+)?$/u.test(text.slice(Math.max(0, index - 30), index));
/**
 * The interview writes "question? — answer" lines into the brief (project-interview-service); only the answer
 * is the owner's word. A question alone ("…какие роли им нужны?") is no need.
 */
const ownerWords = (text: string) => text.split("\n").map((line) => line.replace(/^.*?\?\s+—\s+/u, "")).join("\n");
const sentences = (text: string) => ownerWords(text).split(/(?<=[.!?\n;])\s+|\n+/u).map((part) => part.trim()).filter(Boolean);
const quote = (text: string) => text.length > 160 ? `${text.slice(0, 157)}…` : text;

/** The needs found in the brief and the rules, each once, with the first sentence that shows it. */
export function assessFoundation(brief: ProjectBriefFields, rules: Pick<BusinessRuleFields, "title" | "statement" | "role" | "exceptions">[] = []): FoundationDto {
  const found = new Map<FoundationNeed, FoundationNeedDto>();
  const sources: [FoundationNeedDto["field"], string][] = [
    ...SCANNED.map((field): [FoundationNeedDto["field"], string] => [field, brief[field] ?? ""]),
    ...rules.map((rule): [FoundationNeedDto["field"], string] => ["rule", [rule.title, rule.statement, rule.role, rule.exceptions].filter(Boolean).join(". ")]),
  ];
  for (const [field, text] of sources) {
    if (!text.trim() || (field === "integrations" && EMPTY.test(text.trim()))) continue;
    for (const sentence of sentences(text)) {
      const lower = sentence.toLowerCase().replace(/ё/g, "е");
      if (NEGATION.test(lower)) continue;
      for (const [need, pattern] of SIGNALS) {
        const match = pattern.exec(lower);
        if (match && !found.has(need) && !denied(lower, match.index)) found.set(need, { need, covered: NODE_WEB_PROFILE.covers.includes(need), field, evidence: quote(sentence) });
      }
      const load = LOAD.exec(lower);
      // More than a small team at once is beyond one process with one SQLite file, until a check shows otherwise.
      if (load && !found.has("load") && Number(load[1]!.replace(/\s/g, "")) > 50) found.set("load", { need: "load", covered: false, field, evidence: quote(sentence) });
    }
    // A filled integrations answer is a need even in words the patterns do not know.
    if (field === "integrations" && !found.has("integrations") && !NEGATION.test(text.toLowerCase())) found.set("integrations", { need: "integrations", covered: false, field, evidence: quote(text.trim()) });
  }
  const needs = [...found.values()];
  return { profile: NODE_WEB_PROFILE, fit: needs.some((item) => !item.covered) ? "partial" : "fits", needs, alternatives: FOUNDATION_ALTERNATIVES };
}
