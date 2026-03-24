import { createPolicy } from './shared/policy.mjs';
import { createAuthService } from './auth/service.mjs';
import { createFirmsUsersService } from './firms-users/service.mjs';
import { createProfilesService } from './profiles/service.mjs';
import { createPipelineService } from './pipeline/service.mjs';
import { createHouseholdsService } from './households/service.mjs';
import { createFormsService } from './forms/service.mjs';
import { createTemplatesService } from './templates/service.mjs';
import { createExportsService } from './exports/service.mjs';
import { createAuditService } from './audit/service.mjs';
import { createAnalyticsService } from './analytics/service.mjs';
import {
  StoreAnalyticsRepository,
  StoreAuditRepository,
  StoreExportsRepository,
  StoreFormsRepository,
  StoreHouseholdsRepository,
  StorePipelineRepository,
  StoreProfileRepository,
  StoreTemplateRepository
} from '../repositories/store-adapters.mjs';

export function createModules({ store, reads }) {
  const policy = createPolicy({ store });

  return {
    policy,
    auth: createAuthService({ store }),
    firmsUsers: createFirmsUsersService({ store }),
    profiles: createProfilesService({ profileRepository: new StoreProfileRepository(store, reads) }),
    pipeline: createPipelineService({ pipelineRepository: new StorePipelineRepository(store) }),
    households: createHouseholdsService({ householdsRepository: new StoreHouseholdsRepository(store) }),
    forms: createFormsService({ formsRepository: new StoreFormsRepository(store) }),
    templates: createTemplatesService({ templateRepository: new StoreTemplateRepository(store) }),
    exports: createExportsService({ exportsRepository: new StoreExportsRepository(store) }),
    audit: createAuditService({ auditRepository: new StoreAuditRepository(store) }),
    analytics: createAnalyticsService({ analyticsRepository: new StoreAnalyticsRepository(store, reads) })
  };
}
