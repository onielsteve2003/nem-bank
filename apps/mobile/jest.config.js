const preset = require('jest-expo/jest-preset');

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  resolver: '<rootDir>/jest.resolver.js',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // jest-expo resolves the "react-native" export condition, which points lucide at
    // an .mjs build Jest can't load; Node's "require" condition gives its CJS build.
    '^lucide-react-native$': require.resolve('lucide-react-native'),
  },
  // @noble/* and @shopify/flash-list ship ESM only, so Jest must transform them like the RN packages. Extends
  // the preset's own list so packages it adds later are not dropped.
  transformIgnorePatterns: preset.transformIgnorePatterns.map((pattern) =>
    pattern.startsWith('/node_modules/(?!(')
      ? pattern.replace('(?!(', '(?!(@noble|@shopify/flash-list|')
      : pattern,
  ),
  testPathIgnorePatterns: ['/node_modules/', '/.expo/'],
};
