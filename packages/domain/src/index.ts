import { z } from "zod";

export type Role = "admin" | "advisor" | "readonly" | "client";
export type ProfileKind = "prospect" | "client";
export type HouseholdRole = "primary" | "spouse" | "dependent" | "other";

export const roleSchema = z.enum(["admin", "advisor", "readonly", "client"]);
export const profileKindSchema = z.enum(["prospect", "client"]);
export const prospectStages = [
  "discovery",
  "gather_oi",
  "analysis",
  "advisor_proposal_meeting",
  "intake",
  "on_boarding",
  "investment_strategy",
  "completed",
  "drop_dead_lead",
  "drop_nurture"
] as const;
export const prospectStageSchema = z.enum(prospectStages);

export type ProspectStage = (typeof prospectStages)[number];

export interface FirmScoped {
  firmId: string;
}

export interface AuthenticatedUser extends FirmScoped {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
}

export const RegistrationRequestSchema = z.object({
  firmName: z.string().min(2),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(10)
});

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10)
});

export interface SourceAttribution {
  cityOrLocation: string;
  venue: string;
  occurredOn: string;
  displayValue: string;
}

export interface PostalAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface SensitiveProfile {
  ssnCiphertext?: string;
  taxIdCiphertext?: string;
  birthDateCiphertext?: string;
  maskingPolicy: "full" | "partial" | "role_based";
}

export interface ClientProfile extends FirmScoped {
  id: string;
  advisorUserId?: string;
  kind: ProfileKind;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  source?: SourceAttribution;
  stage?: ProspectStage;
  stageOrderIndex?: number;
  householdId?: string;
  spouseClientId?: string;
  address: PostalAddress;
  pii: SensitiveProfile;
  customProfile: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Household extends FirmScoped {
  id: string;
  name: string;
  primaryClientId: string;
  createdAt: string;
}

export interface HouseholdMember extends FirmScoped {
  householdId: string;
  clientId: string;
  role: HouseholdRole;
  createdAt: string;
}

export interface StageChange extends FirmScoped {
  id: string;
  clientId: string;
  fromStage?: ProspectStage;
  toStage: ProspectStage;
  changedByUserId: string;
  changedAt: string;
}

export interface AuditEvent extends FirmScoped {
  id: string;
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface Firm {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export type RegistrationRequest = z.infer<typeof RegistrationRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export interface Session {
  token: string;
  user: AuthenticatedUser;
}

export type ResourceAction =
  | "profiles:read"
  | "profiles:write"
  | "pipeline:write"
  | "households:write"
  | "firms:admin";

const rolePermissions: Record<Role, ResourceAction[]> = {
  admin: ["profiles:read", "profiles:write", "pipeline:write", "households:write", "firms:admin"],
  advisor: ["profiles:read", "profiles:write", "pipeline:write", "households:write"],
  readonly: ["profiles:read"],
  client: []
};

export function can(role: Role, action: ResourceAction): boolean {
  return rolePermissions[role].includes(action);
}

export function formatSourceAttribution(source: Omit<SourceAttribution, "displayValue">): SourceAttribution {
  return {
    ...source,
    displayValue: `${source.cityOrLocation} X ${source.venue} X ${source.occurredOn}`
  };
}

export function initialStageOrderIndex(existingInStage: number): number {
  return existingInStage + 1;
}

export const defaultNavigation = [
  "dashboard",
  "prospects",
  "clients",
  "households",
  "forms",
  "templates",
  "exports",
  "audit"
] as const;

export * from "./unified-template-model";
