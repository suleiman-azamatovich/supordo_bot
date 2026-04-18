// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Неиспользуемые переменные — warn, игнорируем _prefix
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],

      // Разрешаем non-null assertion — ctx.dbUser! гарантируется authMiddleware
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Разрешаем пустые catch — .catch(() => {})
      '@typescript-eslint/no-empty-function': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Floating promises с void ok
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],

      // Запрещаем any — warn (слишком много мест в middleware)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Unsafe any — warn (chatCleanup middleware uses any для API interception)
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',

      // Разрешаем unnecessary type assertions — легко чинятся, но шум
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

      // Разрешаем misused promises в signal handlers
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { arguments: false },
      }],

      // console.log → warn (используем console.error с тегом модуля)
      'no-console': ['warn', { allow: ['error', 'warn'] }],

      // Безопасность
      'no-eval': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',

      // prefer-const
      'prefer-const': 'error',
    },
  },
  {
    // Seed и index — разрешаем console.log
    files: ['src/db/seed.ts', 'src/index.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'prisma/', 'scripts/', '*.config.*'],
  },
);
