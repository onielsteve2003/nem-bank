// Used by Jest only. Metro compiles this package with the app's own Babel config.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
};
