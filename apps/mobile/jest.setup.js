/* global jest */
// Reanimated 4 loads react-native-worklets, whose native module does not exist in
// Jest; its bundled mock runs worklets synchronously on the JS thread instead.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
