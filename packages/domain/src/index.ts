export type Role = "admin" | "advisor" | "readonly" | "client";

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

export interface SourceAttribution {
  cityOrLocation: string;
  venue: string;
  occurredOn: string;
  displayValue: string;
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
