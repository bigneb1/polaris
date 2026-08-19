import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },
  {
    // `react-refresh/only-export-components` protects hot-module reloading, not
    // correctness: it fires whenever a file exports anything besides a component.
    // Three groups here export exactly one non-component on purpose, and splitting
    // them would be worse code:
    //   - the context providers export their own `useX` hook, which is the whole
    //     point of the file and how every consumer reaches the context;
    //   - the shadcn primitives export their `cva` variant map, which is upstream's
    //     own layout and what lets other components reuse the variants;
    //   - VerifiedBadge exports the tier table its own badge renders from.
    // Editing one of these costs a full reload in dev, which is the correct trade.
    files: [
      'src/context/*Provider.tsx',
      'src/components/ui/badge.tsx',
      'src/components/ui/button.tsx',
      'src/components/VerifiedBadge.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
