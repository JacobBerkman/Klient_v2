import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { z } from "zod";

import { LoginRequestSchema, RegistrationRequestSchema } from "@klient/domain";

import { loadEnv } from "./config/env.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { HouseholdService } from "./modules/households/household-service.js";
import { ProfileService } from "./modules/profiles/profile-service.js";
import { authPlugin } from "./plugins/auth.js";
import { registerRoutes } from "./routes/index.js";

declare module "fastify" {
  interface FastifyInstance {
    authService: AuthService;
    profileService: ProfileService;
    householdService: HouseholdService;
    registerSchema: typeof RegistrationRequestSchema;
    loginSchema: typeof LoginRequestSchema;
  }
}

export async function buildApp() {
  const env = loadEnv();
  const app = Fastify({ logger: env.NODE_ENV !== "test" });

  await app.register(cors, { origin: env.APP_URL, credentials: true });
  await app.register(sensible);

  app.decorate("authService", new AuthService());
  app.decorate("profileService", new ProfileService());
  app.decorate("householdService", new HouseholdService());
  app.decorate("registerSchema", RegistrationRequestSchema);
  app.decorate("loginSchema", LoginRequestSchema);

  app.authService.seedAdmin();

  await app.register(authPlugin);
  await registerRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({ message: "Validation error", issues: error.issues });
      return;
    }

    const statusCode = error.message.includes("not found") ? 404 : 400;
    reply.code(statusCode).send({ message: error.message });
  });

  return app;
}
