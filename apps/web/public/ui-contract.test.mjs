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
})

test('role-aware gating keeps invite admin-only while portal link remains advisor/admin', () => {
  assert.match(html, /<section class="actions grid two" data-requires-role="admin">[\s\S]*id="invite-form"/)
  assert.match(html, /<section class="actions grid two" data-requires-role="admin,advisor">[\s\S]*id="portal-form"/)
})

test('app wiring includes conflict normalization and form-level validation helpers', () => {
  assert.match(appJs, /function normalizeConflictMessage\(/)
  assert.match(appJs, /function validateRequiredFields\(/)
  assert.match(appJs, /function setFormFeedback\(/)
  assert.match(appJs, /isConflictError\(error\) \? normalizeConflictMessage\(error\) : error\.message/)
})

