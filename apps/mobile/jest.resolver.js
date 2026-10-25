// Reanimated 4.7+ needs its own resolver in Jest (it picks the web build of a few
// modules); everything else still goes through the preset's React Native resolver.
const preset = require(require('jest-expo/jest-preset').resolver);
const reanimated = require('react-native-reanimated/jest/resolver');

module.exports = (request, options) =>
  reanimated(request, {
    ...options,
    defaultResolver: (req, opts) =>
      preset(req, { ...opts, defaultResolver: options.defaultResolver }),
  });
