import fp from "fastify-plugin";

import { can, type AuthenticatedUser, type ResourceAction } from "@klient/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requirePermission(action: ResourceAction): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export const authPlugin = fp(async (app) => {
  app.decorate("authenticate", async (request, reply) => {
    const token = request.headers.authorization?.replace("Bearer ", "");
    const user = app.authService.getUserForToken(token);

    if (!user) {
      reply.code(401).send({ message: "Authentication required." });
      return;
    }

    request.user = user;
  });

  app.decorate("requirePermission", (action) => async (request, reply) => {
    const user = request.user;
    if (!user) {
      reply.code(401).send({ message: "Authentication required." });
      return;
    }

    if (!can(user.role, action)) {
      reply.code(403).send({ message: `Missing permission: ${action}` });
    }
  });
});
