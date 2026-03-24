export function createPolicy({ store }) {
  return {
    requirePermission(user, permission) {
      store.assertPermission(user, permission);
      return true;
    }
  };
}
