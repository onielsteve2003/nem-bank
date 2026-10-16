/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // jest-expo resolves the "react-native" export condition, which points lucide at
    // an .mjs build Jest can't load; Node's "require" condition gives its CJS build.
    '^lucide-react-native$': require.resolve('lucide-react-native'),
  },
  testPathIgnorePatterns: ['/node_modules/', '/.expo/'],
};
