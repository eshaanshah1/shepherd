import tseslint from 'typescript-eslint';
import { boundaries } from './tooling/eslint/boundaries.js';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/out-tsc/**',
      '**/dist/**',
      '**/*.tsbuildinfo',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
  },
  // The import boundaries. Everything else is deliberately unlinted for now:
  // this step exists to make an architecture violation fail, not to bikeshed.
  ...boundaries,
];
