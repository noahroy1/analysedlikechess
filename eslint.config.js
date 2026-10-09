import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'projects/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/server/**', 'packages/schema/**', 'scripts/**', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/composition/**/*.{ts,tsx}', 'packages/theme/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // The composition renders identically in the Player and the Renderer only
    // if everything comes in through props: no app code, network, clocks or editor state.
    files: ['packages/composition/src/**'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/apps/**', '@als/web', '@als/server'], message: 'composition must not import app code' },
            { group: ['zustand', 'zustand/*'], message: 'composition must not read editor state' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
          name,
          message: 'composition must not use the network',
        })),
        ...['Date', 'performance', 'setTimeout', 'setInterval', 'requestAnimationFrame'].map((name) => ({
          name,
          message: 'composition must not read clocks; derive time from the frame',
        })),
        ...['localStorage', 'sessionStorage'].map((name) => ({
          name,
          message: 'composition must take everything through props',
        })),
      ],
    },
  },
);
