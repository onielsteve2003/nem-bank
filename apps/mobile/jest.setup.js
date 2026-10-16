/* global jest */
// Reanimated 4 loads react-native-worklets, whose native module does not exist in
// Jest; its bundled mock runs worklets synchronously on the JS thread instead.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
// @gorhom/bottom-sheet needs a native gesture root; its bundled mock renders sheet content inline.
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
