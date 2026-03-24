const defaultNavigation = [
  'dashboard',
  'prospects',
  'clients',
  'households',
  'forms',
  'templates',
  'exports',
  'audit'
] as const;

export const phaseADeliveryPlan = {
  productName: 'Kinetic Klient',
  navigation: defaultNavigation,
  modules: [
    {
      key: 'auth',
      screens: ['sign in', 'register firm admin', 'current user']
    },
    {
      key: 'crm',
      screens: ['dashboard', 'prospects', 'clients', 'create profile', 'profile detail']
    },
    {
      key: 'pipeline',
      screens: ['prospect board', 'stage history']
    },
    {
      key: 'households',
      screens: ['household detail', 'add household member']
    }
  ]
} as const;
