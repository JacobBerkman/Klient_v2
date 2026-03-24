import { randomUUID } from "node:crypto";

import {
  formatSourceAttribution,
  initialStageOrderIndex,
  prospectStages,
  type AuditEvent,
  type AuthenticatedUser,
  type ClientProfile,
  type ProfileKind,
  type ProspectStage,
  type StageChange
} from "@klient/domain";
import { z } from "zod";

export const createProfileSchema = z.object({
  kind: z.enum(["prospect", "client"]),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  advisorUserId: z.string().optional(),
  stage: z.enum(prospectStages).optional(),
  source: z
    .object({
      cityOrLocation: z.string().min(1),
      venue: z.string().min(1),
      occurredOn: z.string().min(1)
    })
    .optional()
});

export const updateProfileStageSchema = z.object({
  stage: z.enum(prospectStages),
  beforeClientId: z.string().optional()
});

export type CreateProfileInput = z.infer<typeof createProfileSchema>;
export type UpdateProfileStageInput = z.infer<typeof updateProfileStageSchema>;

export class ProfileService {
  private readonly profiles = new Map<string, ClientProfile>();
  private readonly stageChanges: StageChange[] = [];
  private readonly audits: AuditEvent[] = [];

  listProfiles(user: AuthenticatedUser, kind?: ProfileKind): ClientProfile[] {
    return [...this.profiles.values()]
      .filter((profile) => profile.firmId === user.firmId)
      .filter((profile) => (kind ? profile.kind === kind : true))
      .sort((left, right) => {
        if (left.stage === right.stage) {
          return (left.stageOrderIndex ?? 0) - (right.stageOrderIndex ?? 0);
        }

        return left.createdAt.localeCompare(right.createdAt);
      });
  }

  createProfile(user: AuthenticatedUser, input: CreateProfileInput): ClientProfile {
    const now = new Date().toISOString();
    const sameStageCount = input.kind === "prospect" && input.stage ? this.listProfiles(user, "prospect").filter((item) => item.stage === input.stage).length : 0;

    const profile: ClientProfile = {
      id: randomUUID(),
      firmId: user.firmId,
      advisorUserId: input.advisorUserId,
      kind: input.kind,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      source: input.source ? formatSourceAttribution(input.source) : undefined,
      stage: input.kind === "prospect" ? input.stage ?? "discovery" : undefined,
      stageOrderIndex: input.kind === "prospect" ? initialStageOrderIndex(sameStageCount) : undefined,
      address: {},
      pii: { maskingPolicy: "role_based" },
      customProfile: {},
      createdAt: now,
      updatedAt: now
    };

    this.profiles.set(profile.id, profile);
    this.audits.push(this.buildAudit(user, "client_profile", profile.id, "profile.created", { kind: profile.kind }));

    if (profile.kind === "prospect" && profile.stage) {
      this.stageChanges.push({
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        toStage: profile.stage,
        changedByUserId: user.id,
        changedAt: now
      });
    }

    return profile;
  }

  moveProspect(user: AuthenticatedUser, clientId: string, input: UpdateProfileStageInput): ClientProfile {
    const profile = this.requireFirmProfile(user, clientId);
    if (profile.kind !== "prospect") {
      throw new Error("Only prospects can move through the pipeline.");
    }

    const currentStageProfiles = this.listProfiles(user, "prospect").filter((item) => item.stage === input.stage && item.id !== clientId);
    let nextIndex = currentStageProfiles.length + 1;

    if (input.beforeClientId) {
      const targetIndex = currentStageProfiles.find((item) => item.id === input.beforeClientId)?.stageOrderIndex;
      if (targetIndex) {
        currentStageProfiles
          .filter((item) => (item.stageOrderIndex ?? 0) >= targetIndex)
          .forEach((item) => {
            this.profiles.set(item.id, {
              ...item,
              stageOrderIndex: (item.stageOrderIndex ?? 0) + 1,
              updatedAt: new Date().toISOString()
            });
          });
        nextIndex = targetIndex;
      }
    }

    const updated: ClientProfile = {
      ...profile,
      stage: input.stage,
      stageOrderIndex: nextIndex,
      updatedAt: new Date().toISOString()
    };

    this.profiles.set(clientId, updated);
    this.stageChanges.push({
      id: randomUUID(),
      firmId: user.firmId,
      clientId,
      fromStage: profile.stage,
      toStage: input.stage,
      changedByUserId: user.id,
      changedAt: updated.updatedAt
    });
    this.audits.push(this.buildAudit(user, "client_profile", clientId, "pipeline.stage_changed", { fromStage: profile.stage, toStage: input.stage }));

    return updated;
  }

  listStageHistory(user: AuthenticatedUser, clientId: string): StageChange[] {
    this.requireFirmProfile(user, clientId);
    return this.stageChanges.filter((change) => change.firmId === user.firmId && change.clientId === clientId);
  }

  getAudits(user: AuthenticatedUser): AuditEvent[] {
    return this.audits.filter((audit) => audit.firmId === user.firmId);
  }

  private requireFirmProfile(user: AuthenticatedUser, clientId: string): ClientProfile {
    const profile = this.profiles.get(clientId);
    if (!profile || profile.firmId !== user.firmId) {
      throw new Error("Profile not found.");
    }

    return profile;
  }

  private buildAudit(user: AuthenticatedUser, entityType: string, entityId: string, action: string, metadata: Record<string, unknown>): AuditEvent {
    return {
      id: randomUUID(),
      firmId: user.firmId,
      actorUserId: user.id,
      entityType,
      entityId,
      action,
      occurredAt: new Date().toISOString(),
      metadata
    };
  }
}
