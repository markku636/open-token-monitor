'use strict';

// Upstream's rules, applied to this repository. The config comes from
// upstream/ (through upstream.js) and resolves its plugins from this
// repository's node_modules, where they are devDependencies pinned to the
// versions upstream's lockfile resolves, so both codebases lint alike.
// upstream/ itself is upstream's to lint, never ours to change.

const { upstream } = require('./upstream');

module.exports = [
  { ignores: ['upstream/**', 'tauri/**', 'node_modules/**', 'data/**', 'dist/**', 'tmp/**'] },
  ...require(upstream('eslint.config.js'))
];
