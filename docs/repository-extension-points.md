# Repository extension points

This document records repository interfaces that previously threw generic `not implemented` errors and clarifies what is runtime-reachable vs scaffold-only.

## Runtime wiring

All runtime repository usage is wired in `createModules` and instantiated with store adapters.

- `StoreProfileRepository`
- `StoreTemplateRepository`
- `StoreTemplatesV2Repository`
- `StorePipelineStagesRepository`

See: `apps/api/src/modules/index.mjs`.

## Reachability map

### Reachable repository interfaces (runtime)

These are called by API routes through services and must be implemented by adapters.

- `ProfileRepository`
  - `listProfiles`, `getProfileDetail`, `createProfile`, `updateProfile`, `listNotes`, `addNote`, `getMaskedSensitiveData`, `getCustomFieldSchema`, `createCustomField`, `updateCustomField`, `deleteCustomField`.
  - Route call sites: `modules.profiles.*` in `apps/api/src/server.mjs`.
- `PipelineStagesRepository`
  - `listStages`, `createStage`, `updateStageMetadata`, `deactivateStage`, `reorderStages`.
  - Route call sites: `modules.pipelineStages.*` in `apps/api/src/server.mjs`.
- `TemplateRepository`
  - `listDocumentTemplates`, `createDocumentTemplate`, `updateTemplateMappings`, `publishTemplate`, `previewTemplateMappings`, `compareTemplateVersions`, `revertTemplateVersion`, `listTemplateVersions`, `listPublishTransitions`, `autoBuildTemplate`.
  - Route call sites: `modules.templates.*` in `apps/api/src/server.mjs`.
- `TemplatesV2Repository`
  - `listCanonicalTemplates`, `createCanonicalTemplate`, `updateCanonicalTemplate`, `transitionLifecycle`.
  - Runtime call sites: `templates-v2` compatibility service used by `templates` and `forms` services in `apps/api/src/modules/index.mjs`.

### Unreachable shells (non-runtime scaffolding)

The base repository classes in module folders are not directly instantiated in runtime module wiring. They are interface scaffolds only:

- `apps/api/src/modules/profiles/repository.mjs`
- `apps/api/src/modules/pipeline-stages/repository.mjs`
- `apps/api/src/modules/templates/repository.mjs`
- `apps/api/src/modules/templates-v2/repository.mjs`

These classes now throw `REPOSITORY_SCAFFOLD_ONLY` to make accidental runtime use explicit and testable.

## Guardrails

- Adapter contract and scaffold guard tests: `apps/api/src/test/repository-scaffold-and-adapter-contracts.test.mjs`.
- Existing tenancy safety checks remain in `StoreProfileRepository`: `apps/api/src/test/store-profile-repository-tenancy.test.mjs`.
