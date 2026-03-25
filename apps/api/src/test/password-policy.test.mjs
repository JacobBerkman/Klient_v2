import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStrongPassword, MIN_PASSWORD_LENGTH } from '../auth/password-policy.mjs';

test('password policy rejects too-short passwords', () => {
  assert.throws(() => assertStrongPassword('Aa1short'), new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`));
  assert.throws(() => assertStrongPassword(null), new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`));
});

test('password policy enforces mixed character classes', () => {
  assert.throws(() => assertStrongPassword('lowercaseonly123'), /uppercase, lowercase, and numeric/);
  assert.throws(() => assertStrongPassword('UPPERCASEONLY123'), /uppercase, lowercase, and numeric/);
  assert.throws(() => assertStrongPassword('NoNumbersHere!'), /uppercase, lowercase, and numeric/);
});

test('password policy accepts valid edge-case passwords', () => {
  assert.doesNotThrow(() => assertStrongPassword('Abcdefghij1!'));
  assert.doesNotThrow(() => assertStrongPassword('  AvalidPass123  '));
  assert.doesNotThrow(() => assertStrongPassword('LongerPassw0rdWithSymbols#%'));
});
