export function assertAuthProvider(provider) {
  const requiredMethods = ['authenticate', 'register', 'requestReset', 'resetPassword'];
  for (const method of requiredMethods) {
    if (typeof provider?.[method] !== 'function') {
      throw new Error(`Invalid auth provider: missing ${method}().`);
    }
  }
  return provider;
}
