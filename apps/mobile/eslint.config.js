// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier/flat');

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    ignores: ['dist/*', 'web-build/*', '.expo/*', 'expo-env.d.ts'],
  },
  {
    // The lucide barrel pulls every icon into the bundle; src/components/icons.ts imports one file each.
    ignores: ['src/components/icons.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lucide-react-native',
              message: "Import icons from '@/components/icons' (add the icon there if it is new).",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
]);
