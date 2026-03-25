import { createPolicy } from './shared/policy.mjs'
import { createAuthService } from './auth/service.mjs'
import { createFirmsUsersService } from './firms-users/service.mjs'
import { createProfilesService } from './profiles/service.mjs'
import { createPipelineService } from './pipeline/service.mjs'
import { createHouseholdsService } from './households/service.mjs'
import { createFormsService } from './forms/service.mjs'
import { createTemplatesService } from './templates/service.mjs'
import { createExportsService } from './exports/service.mjs'
import { createAuditService } from './audit/service.mjs'
import { createAnalyticsService } from './analytics/service.mjs'
import { StoreProfileRepository, StoreTemplateRepository } from '../repositories/store-adapters.mjs'

export function createModules({ store, reads }) {
  const policy = createPolicy({ store })
  const profileRepository = new StoreProfileRepository(store, reads)
  const templateRepository = new StoreTemplateRepository(store)

  return {
    policy,
    auth: createAuthService({ store }),
    firmsUsers: createFirmsUsersService({ store, policy }),
    profiles: createProfilesService({ profileRepository, policy }),
    pipeline: createPipelineService({ store, policy }),
    households: createHouseholdsService({ store, policy }),
    forms: createFormsService({ store, policy }),
    templates: createTemplatesService({ templateRepository, policy, store }),
    exports: createExportsService({ store, policy }),
    audit: createAuditService({ store, policy }),
    analytics: createAnalyticsService({ store, reads, policy })
  }
}
