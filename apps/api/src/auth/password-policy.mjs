export const MIN_PASSWORD_LENGTH = 12;

export function assertStrongPassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include uppercase, lowercase, and numeric characters.');
  }
}
