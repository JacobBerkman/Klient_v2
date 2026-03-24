import { handleSystemRoute } from './system-routes.mjs';
import { handleAuthUsersFirmsRoute } from './auth-users-firms-routes.mjs';
import { handleProfilesRoute } from './profiles-routes.mjs';
import { handleHouseholdsRoute } from './households-routes.mjs';
import { handleFormsRoute } from './forms-routes.mjs';
import { handleTemplatesMappingsRoute } from './templates-mappings-routes.mjs';
import { handleExportsRoute } from './exports-routes.mjs';
import { handleAuditAnalyticsRoute } from './audit-analytics-routes.mjs';
import { handlePortalRoute } from './portal-routes.mjs';

const asyncHandlers = [
  handleAuthUsersFirmsRoute,
  handleProfilesRoute,
  handleHouseholdsRoute,
  handleFormsRoute,
  handleTemplatesMappingsRoute,
  handleExportsRoute,
  handleAuditAnalyticsRoute,
  handlePortalRoute
];

export async function routeRequest(ctx) {
  if (handleSystemRoute(ctx)) return true;

  for (const handler of asyncHandlers) {
    if (await handler(ctx)) {
      return true;
    }
  }

  return false;
}
