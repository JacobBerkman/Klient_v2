import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const appJs = readFileSync(new URL('./app.js', import.meta.url), 'utf8')

test('targeted forms expose inline feedback regions for validation and error rendering', () => {
  for (const formId of ['profile-form', 'form-template-form', 'doc-template-form', 'invite-form', 'portal-form']) {
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
  assert.match(appJs, /function validateRequiredFields\(/)
  assert.match(appJs, /function setFormFeedback\(/)
  assert.match(appJs, /function viewErrorBanner\(/)
  assert.match(appJs, /isConflictError\(error\) \? normalizeConflictMessage\(error\) : error\.message/)
})

test('navigation and board controls include accessibility-critical semantics', () => {
  assert.match(html, /<nav aria-label="Primary">/)
  assert.match(html, /<button type="button" data-view="dashboard"[^>]*aria-controls="view"/)
  assert.match(appJs, /function updateViewNavState\(/)
  assert.match(appJs, /button\.setAttribute\('aria-current', selected \? 'page' : 'false'\)/)
  assert.match(appJs, /data-open-profile-detail="\$\{card\.id\}" aria-expanded="false" aria-controls="profile-detail-\$\{card\.id\}"/)
  assert.match(appJs, /button\.setAttribute\('aria-expanded', 'true'\)/)
  assert.match(appJs, /button\.setAttribute\('aria-expanded', 'false'\)/)
})

test('styles provide visible focus indicators and empty-state affordances', () => {
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(styles, /button:focus-visible,/)
  assert.match(styles, /\.sidebar nav button\[aria-current='page'\]/)
  assert.match(styles, /\.empty-state \{/)
})
