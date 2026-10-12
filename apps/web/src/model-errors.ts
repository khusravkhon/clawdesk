// Plain words for the usual model failures. Anything else is shown as the Gateway said it.

type Translate = (key: string) => string;

export function modelErrorHint(t: Translate, error: string | null | undefined): string {
  if (!error) return "";
  if (/401|403|unauthori[sz]ed|no api key|invalid api key|authentication/i.test(error)) return t("dash.err.auth");
  if (/429|rate.?limit|quota|exceeded/i.test(error)) return t("dash.err.rateLimit");
  if (/503|overloaded|high demand|unavailable/i.test(error)) return t("dash.err.overloaded");
  if (/timed? ?out|timeout|deadline/i.test(error)) return t("dash.err.timeout");
  return error;
}
