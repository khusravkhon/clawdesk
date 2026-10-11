import { DashboardRange, type DashboardDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DashboardService } from "../dashboard/dashboard-service.js";

const DashboardQuery = z.object({ range: DashboardRange.default("7d") });

export function registerDashboardRoutes(app: FastifyInstance, deps: { dashboard: DashboardService }): void {
  app.get("/api/dashboard", async (request): Promise<DashboardDto> => {
    const { range } = DashboardQuery.parse(request.query);
    return deps.dashboard.get(range);
  });
}
