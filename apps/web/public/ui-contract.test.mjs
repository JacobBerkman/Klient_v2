import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const appJs = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
const portalHtml = readFileSync(new URL('./portal.html', import.meta.url), 'utf8')

test('targeted forms expose inline feedback regions for validation and error rendering', () => {
  for (const formId of [
    'register-form',
    'login-form',
    'profile-form',
    'household-form',
    'form-template-form',
    'doc-template-form',
    'invite-form',
    'portal-form'
  ]) {
    const formRegex = new RegExp(`<form[^>]*id=["']${formId}["'][\\s\\S]*?data-form-feedback`, 'm')
    assert.match(html, formRegex, `${formId} should contain a data-form-feedback region`)
  }
  assert.match(html, /<section id="view" class="card" aria-live="polite"><\/section>/, 'main view region should be aria-live')
})

test('role-aware gating keeps invite admin-only while portal link remains advisor/admin', () => {
  assert.match(html, /<section class="actions grid two" data-requires-role="admin">[\s\S]*id="invite-form"/)
  assert.match(html, /<section class="actions grid two" data-requires-role="admin,advisor">[\s\S]*id="portal-form"/)
  assert.match(html, /data-view="operations"[\s\S]*data-policy-guard="canReadDiagnostics"/)
})

test('app wiring includes conflict normalization and form-level validation helpers', () => {
  assert.match(appJs, /function normalizeConflictMessage\(/)
  assert.match(appJs, /function normalizeApiError\(/)
  assert.match(appJs, /function validateRequiredFields\(/)
  assert.match(appJs, /function setFormFeedback\(/)
  assert.match(appJs, /function viewErrorBanner\(/)
  assert.match(appJs, /setWorkflowStatus\(/)
})

test('navigation and board controls include accessibility-critical semantics', () => {
  assert.match(html, /<a class="skip-link" href="#main-content-heading">Skip to main content<\/a>/)
  assert.match(html, /<main id="main-content" class="content" tabindex="-1" aria-labelledby="main-content-heading">/)
  assert.match(html, /<h2 id="main-content-heading" class="sr-only">Main content<\/h2>/)
  assert.match(html, /<nav aria-label="Primary">/)
  assert.match(html, /<button type="button" data-view="dashboard"[^>]*aria-controls="view"/)
  assert.match(html, /<pre id="auth-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/)
  assert.match(html, /<p id="mfa-hint"[^>]*role="status"[^>]*aria-live="polite"/)
  assert.match(appJs, /function updateViewNavState\(/)
  assert.match(appJs, /button\.setAttribute\('aria-current', selected \? 'page' : 'false'\)/)
  assert.match(appJs, /function focusLiveRegion\(/)
  assert.match(appJs, /function setAuthStatus\(/)
  assert.match(appJs, /feedbackEl\.setAttribute\('aria-atomic', 'true'\)/)
  assert.match(appJs, /missingField\.setAttribute\('aria-invalid', 'true'\)/)
  assert.match(appJs, /missingField\.focus\(\)/)
  assert.match(appJs, /data-open-profile-detail="\$\{card\.id\}" aria-expanded="false" aria-controls="profile-detail-\$\{card\.id\}"/)
  assert.match(appJs, /data-edit-profile="\$\{card\.id\}" aria-expanded="false" aria-controls="profile-edit-\$\{card\.id\}"/)
  assert.match(appJs, /button\.setAttribute\('aria-expanded', 'true'\)/)
  assert.match(appJs, /button\.setAttribute\('aria-expanded', 'false'\)/)
})

test('template change announcements are exposed for app and portal workflows', () => {
  assert.match(appJs, /setWorkflowStatus\(`Template selected: \$\{selectedTemplate\.name\} \(\$\{mappingCount\} mappings\)\.`\)/)
  assert.match(portalHtml, /id="portal-template-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(portalHtml, /function announceTemplateChange\(template, \{ silent = false \} = \{\}\)/)
  assert.match(portalHtml, /Template \$\{template\.name\} selected\. \$\{sectionCount\} sections, \$\{fieldCount\} fields\./)
  assert.match(portalHtml, /renderTemplateFields\(\{ silentAnnouncement: false \}\)/)
})

test('template builder auto-build + wizard flow keeps upload and publish-preflight controls stable', () => {
  assert.match(html, /id="doc-template-form"[\s\S]*name="useAutoBuild"/)
  assert.match(html, /id="doc-template-form"[\s\S]*name="templatePdf" type="file" accept="application\/pdf,.pdf"/)
  assert.match(appJs, /function templateIngestionRecoveryMessage\(extraction = \{\}\)/)
  assert.match(appJs, /reasonCode === 'malformed_pdf'/)
  assert.match(appJs, /reasonCode === 'no_acroform'/)
  assert.match(appJs, /reasonCode === 'no_fields'/)
  assert.match(appJs, /const wizardSteps = \['upload', 'extraction', 'mapping', 'preview', 'publish'\]/)
  assert.match(appJs, /data-template-wizard-step="\$\{step\}"/)
  assert.match(appJs, /document\.querySelectorAll\('\[data-template-wizard-step\]'\)/)
  assert.match(appJs, /id="run-publish-preflight"/)
  assert.match(appJs, /id="publish-template"/)
})

test('template versioning and publish preflight controls remain wired in builder workflow', () => {
  assert.match(appJs, /routes\.documentTemplateMappingsPreview\(template\.id\)/)
  assert.match(appJs, /state\.templatePublishPreflightByTemplateId\[template\.id\]/)
  assert.match(appJs, /id="auto-map-similar"/)
  assert.match(appJs, /id="clear-unresolved-rows"/)
  assert.match(appJs, /'required-only'/)
  assert.match(appJs, /data-preflight-rowid="\$\{escapeHtml\(rowId\)\}"/)
  assert.match(appJs, /const selectTemplateRowFromIssue = async \(/)
  assert.match(appJs, /routes\.documentTemplatePublish\(template\.id\)/)
  assert.match(appJs, /routes\.documentTemplateCompare\(template\.id, \{ baseVersion, targetVersion \}\)/)
  assert.match(appJs, /routes\.documentTemplateRevert\(template\.id\)/)
  assert.match(appJs, /id="compare-template-versions"/)
  assert.match(appJs, /id="revert-template-version"/)
})


test('e2e selectors stay stable for auth, advisor workflows, and portal submission controls', () => {
  assert.match(html, /id="register-form"[^>]*data-e2e="register-form"/)
  assert.match(html, /id="login-form"[^>]*data-e2e="login-form"/)
  assert.match(html, /data-e2e="login-submit"/)
  assert.match(html, /id="auth-status"[^>]*data-e2e="auth-status"/)
  assert.match(html, /id="profile-form"[^>]*data-e2e="profile-form"/)
  assert.match(html, /id="portal-form"[^>]*data-e2e="portal-link-form"/)
  assert.match(portalHtml, /id="template-picker"[^>]*data-e2e="template-picker"/)
  assert.match(portalHtml, /id="portal-form"[^>]*data-e2e="portal-form"/)
  assert.match(portalHtml, /data-e2e="portal-save-draft"/)
  assert.match(portalHtml, /data-e2e="portal-submit"/)
  assert.match(portalHtml, /id="portal-status"[^>]*data-e2e="portal-status-badge"/)
})

test('portal failure states preserve focus and live-region semantics for alerts and statuses', () => {
  assert.match(portalHtml, /function updateRegion\(region, message, \{ error = false, focus = false \} = \{\}\)/)
  assert.match(portalHtml, /if \(focus && message\) region\.focus\(\)/)
  assert.match(portalHtml, /setFormFeedback\('Please select a template\.', \{ error: true, focus: true \}\)/)
  assert.match(portalHtml, /Please complete \$\{field\.label \|\| field\.key\}\./)
  assert.match(portalHtml, /focusFirstInvalidField\(\)/)
  assert.match(portalHtml, /id="portal-form-status"[^>]*role="status"[^>]*data-e2e="portal-form-status"/)
  assert.match(portalHtml, /id="portal-form-error"[^>]*role="alert"[^>]*data-e2e="portal-form-error"/)
  assert.match(portalHtml, /id="portal-upload-status"[^>]*role="status"[^>]*data-e2e="portal-upload-status"/)
  assert.match(portalHtml, /id="portal-upload-error"[^>]*role="alert"[^>]*data-e2e="portal-upload-error"/)
})

test('exports workflow includes keyboard-friendly selection labels and live-region updates', () => {
  assert.match(appJs, /id="exports-live-region"[\s\S]*role="status"[\s\S]*aria-live="polite"/)
  assert.match(appJs, /<table aria-describedby="exports-live-region">/)
  assert.match(appJs, /id="select-all-exports" type="checkbox" aria-label="Select all eligible exports"/)
  assert.match(appJs, /data-select-export="\$\{job\.id\}" type="checkbox" aria-label="Select export \$\{escapeHtml\(job\.id\)\}"/)
  assert.match(appJs, /data-retry-export="\$\{job\.id\}" class="tiny secondary" aria-label="Retry export \$\{escapeHtml\(job\.id\)\}"/)
  assert.match(appJs, /data-download-export="\$\{job\.id\}" class="tiny" aria-label="Download export \$\{escapeHtml\(job\.id\)\}"/)
  assert.match(appJs, /setWorkflowStatus\('Exports filters applied\.'/)
  assert.match(appJs, /setWorkflowStatus\('Exports filters cleared\.'/)
})

test('styles provide visible focus indicators and empty-state affordances', () => {
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(styles, /\.skip-link \{/)
  assert.match(styles, /\.skip-link:focus-visible \{/)
  assert.match(styles, /button:focus-visible,/)
  assert.match(styles, /\.sidebar nav button\[aria-current='page'\]/)
  assert.match(styles, /\.empty-state \{/)
})

test('exports view contract exposes queue labels and operator guidance text', () => {
  assert.match(appJs, /Pending \(queued \+ retrying\)/)
  assert.match(appJs, /Retrying \(auto\)/)
  assert.match(appJs, /Failed \(manual triage\)/)
  assert.match(appJs, /Dead Letter \(needs root-cause\)/)
  assert.match(appJs, /Retryable failures/)
  assert.match(appJs, /Operator guidance: retrying jobs are automatic, failed jobs need manual retry, and dead-letter jobs require remediation before retrying\./)
  assert.match(appJs, /retry-failed-jobs/)
  assert.match(appJs, /Retry failed \+ dead-letter jobs/)
})

test('exports selection state and bulk action rules include retryability and role gating', () => {
  assert.match(appJs, /function exportSelectionState\(job, canMutate\)/)
  assert.match(appJs, /selectable: retryable \|\| downloadable/)
  assert.match(appJs, /const selectedRetryable = selectedJobs\.filter\(\(job\) => exportSelectionState\(job, canMutate\)\.retryable\)/)
  assert.match(appJs, /const selectedDownloadable = selectedJobs\.filter\(\(job\) => exportSelectionState\(job, canMutate\)\.downloadable\)/)
  assert.match(appJs, /Bulk retry: no selected exports are eligible for retry\./)
  assert.match(appJs, /Readonly role: retry actions hidden\./)
})

test('exports per-job table keeps header and row columns aligned', () => {
  assert.match(
    appJs,
    /<table aria-describedby="exports-live-region"><thead><tr><th><input id="select-all-exports"[\s\S]*<\/th><th>ID<\/th><th>Status<\/th><th>Failure Class<\/th><th>Attempts<\/th><th>Artifact Details<\/th><th>Actions<\/th><\/tr><\/thead><tbody>/
  )
  assert.match(appJs, /exportSelectionState\(job, canMutate\)\.failureClass/)
  assert.match(appJs, /<td>\$\{escapeHtml\(job\.statusLabel \|\| job\.status\)\}<\/td>\s*<td>\$\{escapeHtml\(exportSelectionState\(job, canMutate\)\.failureClass\)\}<\/td>\s*<td>\$\{job\.attempts \|\| 0\}\/\$\{job\.maxAttempts \|\| 0\}<\/td>/)
  assert.match(appJs, /<tr><td colspan="7">No export jobs yet\. Run an export to populate queue activity and artifact status\.<\/td><\/tr>/)
  assert.match(appJs, /No export jobs yet\. Run an export to populate queue activity and artifact status\./)
})

test('launch ops panel contract keeps admin gating, read-only copy, and diagnostics links stable', () => {
  assert.match(appJs, /function canReadDiagnostics\(/)
  assert.match(appJs, /function canViewLaunchOpsPanel\(\)/)
  assert.match(appJs, /return roleAllowed\('admin'\) && canReadDiagnostics\(\)/)
  assert.match(appJs, /data-launch-ops-panel data-requires-role="admin" data-policy-guard="canReadDiagnostics"/)
  assert.match(appJs, /Read-only operator checks for release GO\/NO-GO decisions\./)
  assert.match(appJs, /Evidence artifacts: store release proof under[\s\S]*artifacts\/release-evidence\/&lt;release-id&gt;/)
  assert.match(appJs, /Latest diagnostics timestamp:/)
  assert.match(appJs, /title: '\/health', href: '\/health'/)
  assert.match(appJs, /title: '\/ready', href: '\/ready'/)
  assert.match(appJs, /title: 'Exports queue',[\s\S]*href: routes\.exportsQueueHealth\(\)/)
  assert.match(appJs, /data-launch-ops-open/)
})

test('forms draft sharing contract exposes panel controls, live-region feedback, and role gating rules', () => {
  assert.match(appJs, /data-open-draft-share-panel="\$\{draft\.id\}" aria-expanded="\$\{panelVisible \? 'true' : 'false'\}" aria-controls="\$\{panelId\}"/)
  assert.match(appJs, /data-draft-share-panel="\$\{draft\.id\}"/)
  assert.match(appJs, /data-add-draft-collaborator="\$\{draft\.id\}"/)
  assert.match(appJs, /data-remove-draft-collaborator="\$\{draft\.id\}"/)
  assert.match(appJs, /data-draft-share-feedback="\$\{draft\.id\}" role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(appJs, /function canManageDraftCollaborators\(draft\)/)
  assert.match(appJs, /function draftCollaboratorDeniedMessage\(draft\)/)
  assert.match(appJs, /Readonly role: collaborator updates are disabled\./)
  assert.match(appJs, /Only the draft owner can manage collaborators\./)
  assert.match(appJs, /routes\.formDraftCollaborators\(draftId\)/)
  assert.match(appJs, /routes\.formDraftCollaborator\(draftId, userId\)/)
})
