import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedUser, Firm, LoginRequest, RegistrationRequest, Role, Session } from "@klient/domain";

interface StoredUser extends AuthenticatedUser {
  passwordHash: string;
}

export class AuthService {
  private readonly firms = new Map<string, Firm>();
  private readonly users = new Map<string, StoredUser>();
  private readonly emailIndex = new Map<string, string>();
  private readonly sessions = new Map<string, string>();

  register(input: RegistrationRequest): Session {
    const email = input.email.toLowerCase();
    if (this.emailIndex.has(email)) {
      throw new Error("An account with this email already exists.");
    }

    const firmId = randomUUID();
    const userId = randomUUID();
    const now = new Date().toISOString();
    const role: Role = "admin";

    this.firms.set(firmId, {
      id: firmId,
      name: input.firmName,
      slug: input.firmName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      createdAt: now
    });

    const user: StoredUser = {
      id: userId,
      firmId,
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      role,
      passwordHash: this.hashPassword(input.password)
    };

    this.users.set(userId, user);
    this.emailIndex.set(email, userId);

    return this.createSession(user);
  }

  login(input: LoginRequest): Session {
    const email = input.email.toLowerCase();
    const userId = this.emailIndex.get(email);
    if (!userId) {
      throw new Error("Invalid email or password.");
    }

    const user = this.users.get(userId);
    if (!user || user.passwordHash !== this.hashPassword(input.password)) {
      throw new Error("Invalid email or password.");
    }

    return this.createSession(user);
  }

  getUserForToken(token: string | undefined): AuthenticatedUser | undefined {
    if (!token) {
      return undefined;
    }

    const userId = this.sessions.get(token);
    if (!userId) {
      return undefined;
    }

    const user = this.users.get(userId);
    if (!user) {
      return undefined;
    }

    return this.toPublicUser(user);
  }

  seedAdmin(): Session {
    return this.register({
      firmName: "Demo Advisory Group",
      firstName: "Demo",
      lastName: "Admin",
      email: "admin@demo.test",
      password: "ChangeMe123!"
    });
  }

  private createSession(user: StoredUser): Session {
    const token = randomUUID();
    this.sessions.set(token, user.id);
    return {
      token,
      user: this.toPublicUser(user)
    };
  }

  private toPublicUser(user: StoredUser): AuthenticatedUser {
    return {
      id: user.id,
      firmId: user.firmId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role
    };
  }

  private hashPassword(password: string): string {
    return createHash("sha256").update(password).digest("hex");
  }
}
