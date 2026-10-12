import { DashboardRange, type DashboardDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DashboardService } from "../dashboard/dashboard-service.js";

/** IANA zone the browser is in, so days are the person's days (the server may run in UTC). */
const TimeZone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "unknown time zone");
const DashboardQuery = z.object({ range: DashboardRange.default("7d"), tz: TimeZone.optional() });

export function registerDashboardRoutes(app: FastifyInstance, deps: { dashboard: DashboardService }): void {
  app.get("/api/dashboard", async (request): Promise<DashboardDto> => {
    const { range, tz } = DashboardQuery.parse(request.query);
    return deps.dashboard.get(range, tz);
  });
}
