import type { FastifyInstance } from "fastify";

import { addHouseholdMemberSchema, createHouseholdSchema } from "../modules/households/household-service.js";
import { createProfileSchema, updateProfileStageSchema } from "../modules/profiles/profile-service.js";

function paramsOf(request: { params: unknown }): Record<string, string> {
  return request.params as Record<string, string>;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api/v1/auth/register", async (request, reply) => {
    const payload = app.registerSchema.parse(request.body);
    const session = app.authService.register(payload);
    reply.code(201).send(session);
  });

  app.post("/api/v1/auth/login", async (request) => {
    const payload = app.loginSchema.parse(request.body);
    return app.authService.login(payload);
  });

  app.get("/api/v1/me", { preHandler: [app.authenticate] }, async (request) => ({ user: request.user }));

  app.get("/api/v1/profiles", { preHandler: [app.authenticate] }, async (request) => {
    const kind = typeof request.query === "object" && request.query && "kind" in request.query ? String((request.query as Record<string, unknown>).kind) : undefined;
    return { data: app.profileService.listProfiles(request.user!, kind === "prospect" || kind === "client" ? kind : undefined) };
  });

  app.post(
    "/api/v1/profiles",
    { preHandler: [app.authenticate, app.requirePermission("profiles:write")] },
    async (request, reply) => {
      const payload = createProfileSchema.parse(request.body);
      const profile = app.profileService.createProfile(request.user!, payload);
      reply.code(201).send({ data: profile });
    }
  );

  app.patch(
    "/api/v1/profiles/:id/stage",
    { preHandler: [app.authenticate, app.requirePermission("pipeline:write")] },
    async (request) => {
      const payload = updateProfileStageSchema.parse(request.body);
      return { data: app.profileService.moveProspect(request.user!, paramsOf(request).id, payload) };
    }
  );

  app.get("/api/v1/profiles/:id/stage-history", { preHandler: [app.authenticate] }, async (request) => {
    return { data: app.profileService.listStageHistory(request.user!, paramsOf(request).id) };
  });

  app.get("/api/v1/audit-events", { preHandler: [app.authenticate, app.requirePermission("profiles:read")] }, async (request) => {
    return { data: app.profileService.getAudits(request.user!) };
  });

  app.post(
    "/api/v1/households",
    { preHandler: [app.authenticate, app.requirePermission("households:write")] },
    async (request, reply) => {
      const payload = createHouseholdSchema.parse(request.body);
      const household = app.householdService.createHousehold(request.user!, payload);
      reply.code(201).send({ data: household });
    }
  );

  app.post(
    "/api/v1/households/:id/members",
    { preHandler: [app.authenticate, app.requirePermission("households:write")] },
    async (request, reply) => {
      const payload = addHouseholdMemberSchema.parse(request.body);
      const member = app.householdService.addMember(request.user!, paramsOf(request).id, payload);
      reply.code(201).send({ data: member });
    }
  );

  app.get("/api/v1/households/:id/members", { preHandler: [app.authenticate] }, async (request) => {
    return { data: app.householdService.listMembers(request.user!, paramsOf(request).id) };
  });
}
