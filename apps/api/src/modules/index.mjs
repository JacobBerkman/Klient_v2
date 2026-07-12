import { createPolicy } from './shared/policy.mjs'
import { createAuthService } from './auth/service.mjs'
import { createFirmsUsersService } from './firms-users/service.mjs'
import { createProfilesService } from './profiles/service.mjs'
import { createPipelineService } from './pipeline/service.mjs'
import { createPipelineStagesService } from './pipeline-stages/service.mjs'
import { createHouseholdsService } from './households/service.mjs'
import { createFormsService } from './forms/service.mjs'
import { createTemplatesService } from './templates/service.mjs'
import { createTemplatesV2Service } from './templates-v2/service.mjs'
import { createExportsService } from './exports/service.mjs'
import { createAuditService } from './audit/service.mjs'
import { createActivityService } from './activity/service.mjs'
import { createAnalyticsService } from './analytics/service.mjs'
import { createNotificationsService } from './notifications/service.mjs'
import {
  StoreProfileRepository,
  StoreTemplateRepository,
  StoreTemplatesV2Repository,
  StoreExportsRepository,
  StorePipelineStagesRepository
} from '../repositories/store-adapters.mjs'

export function createModules({ store, reads }) {
  const policy = createPolicy({ store })
  const profileRepository = new StoreProfileRepository(store, reads)
  const templateRepository = new StoreTemplateRepository(store)
  const templatesV2Repository = new StoreTemplatesV2Repository(store)
  const exportsRepository = new StoreExportsRepository(store)
  const pipelineStagesRepository = new StorePipelineStagesRepository(store)
  const templatesCompatibility = createTemplatesV2Service({ templatesV2Repository, policy })

  return {
    policy,
    auth: createAuthService({ store }),
    googleOidc: store.googleOidc,
    firmsUsers: createFirmsUsersService({ store, policy }),
    profiles: createProfilesService({ profileRepository, policy }),
    pipeline: createPipelineService({ store, policy }),
    pipelineStages: createPipelineStagesService({ pipelineStagesRepository, policy }),
    households: createHouseholdsService({ store, policy }),
    forms: createFormsService({ store, policy, templatesCompatibility }),
    templates: createTemplatesService({ templateRepository, policy, store, templatesCompatibility }),
    exports: createExportsService({ exportsRepository, policy, store }),
    audit: createAuditService({ store, policy }),
    activity: createActivityService({ store, policy }),
    analytics: createAnalyticsService({ store, reads, policy }),
    notifications: createNotificationsService({ policy })
  }
}
