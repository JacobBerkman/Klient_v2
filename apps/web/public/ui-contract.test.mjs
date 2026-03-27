import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const appJs = readFileSync(new URL('./app.js', import.meta.url), 'utf8')

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

test('exports per-job table includes failure class and operator guidance column data', () => {
  assert.match(appJs, /<th>Failure Class<\/th>/)
  assert.match(appJs, /exportSelectionState\(job, canMutate\)\.failureClass/)
  assert.match(appJs, /<div class=\"muted\">\$\{escapeHtml\(selection\.guidance\)\}<\/div>/)
  assert.match(appJs, /No export jobs yet\. Run an export to populate queue activity and artifact status\./)
})
