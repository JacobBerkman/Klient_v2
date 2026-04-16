import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import security from 'eslint-plugin-security';

const weakHashCallPatterns = [
  {
    selector: "CallExpression[callee.property.name='createHash'] Literal[value=/^(md4|md5|sha1)$/i]",
    message: 'Avoid weak hashing algorithms (MD4/MD5/SHA1). Use SHA-256+ or stronger.',
  },
  {
    selector: "CallExpression[callee.property.name='createHmac'] Literal[value=/^(md4|md5|sha1)$/i]",
    message: 'Avoid weak HMAC algorithms (MD4/MD5/SHA1). Use SHA-256+ or stronger.',
  },
];

const baseRules = {
  'no-console': 'warn',
  'no-debugger': 'error',
  'sonarjs/no-identical-functions': 'warn',
  'sonarjs/no-duplicated-branches': 'warn',
};

export default [
  {
    ignores: ['**/node_modules/**', '**/coverage/**'],
  },
  {
    plugins: {
      sonarjs,
      security,
    },
  },
  {
    files: ['apps/api/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...baseRules,
      'security/detect-possible-timing-attacks': 'warn',
      'no-restricted-syntax': [
        'warn',
        ...weakHashCallPatterns,
        {
          selector: "CallExpression[callee.property.name='createCipher']",
          message:
            'crypto.createCipher is deprecated and unsafe. Use createCipheriv with a modern AEAD cipher instead.',
        },
        {
          selector: "CallExpression[callee.property.name='createDecipher']",
          message:
            'crypto.createDecipher is deprecated and unsafe. Use createDecipheriv with authenticated encryption.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...baseRules,
      'security/detect-possible-timing-attacks': 'warn',
      'no-restricted-syntax': ['warn', ...weakHashCallPatterns],
    },
  },
];
