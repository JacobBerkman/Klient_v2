const rolePermissions = {
    admin: ["profiles:read", "profiles:write", "pipeline:write", "households:write", "firms:admin"],
    advisor: ["profiles:read", "profiles:write", "pipeline:write", "households:write"],
    readonly: ["profiles:read"],
    client: []
};
export const defaultNavigation = [
    "dashboard",
    "prospects",
    "clients",
    "households",
    "forms",
    "templates",
    "exports",
    "audit"
];
export function can(role, action) {
    return rolePermissions[role].includes(action);
}
export function formatSourceAttribution(source) {
    return {
        ...source,
        displayValue: `${source.cityOrLocation} X ${source.venue} X ${source.occurredOn}`
    };
}
export function initialStageOrderIndex(existingInStage) {
    return existingInStage + 1;
}
