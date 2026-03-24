export type Role = "admin" | "advisor" | "readonly" | "client";
export type ResourceAction = "profiles:read" | "profiles:write" | "pipeline:write" | "households:write" | "firms:admin";
export interface SourceAttribution {
    cityOrLocation: string;
    venue: string;
    occurredOn: string;
    displayValue: string;
}
export declare const defaultNavigation: readonly ["dashboard", "prospects", "clients", "households", "forms", "templates", "exports", "audit"];
export declare function can(role: Role, action: ResourceAction): boolean;
export declare function formatSourceAttribution(source: Omit<SourceAttribution, "displayValue">): SourceAttribution;
export declare function initialStageOrderIndex(existingInStage: number): number;
