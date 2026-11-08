import { DashboardRange, type UsageDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { UsageService } from "../dashboard/usage-service.js";

const Query = z.object({
  range: DashboardRange.default("30d"),
  tz: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
});

export function registerUsageRoutes(app: FastifyInstance, deps: { usage: UsageService; timeZone?: () => string | undefined }): void {
  app.get("/api/usage", async (request): Promise<UsageDto> => {
    const { range, tz } = Query.parse(request.query);
    return deps.usage.get(range, deps.timeZone?.() ?? tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
}
