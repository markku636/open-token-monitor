'use strict';

// The one place that knows where upstream token-monitor is: upstream/ in this
// repository, a squashed git subtree of Javis603/token-monitor pinned to one of
// its release tags (AGENTS.md, "升級上游"). Every module reaches upstream code
// through upstream('src/…') instead of a relative path, so the location lives
// here only. The hub image keeps the same layout (docker/Dockerfile), so a file
// runs unchanged in a checkout and in the image.

const path = require('node:path');

const ROOT = __dirname;
const UPSTREAM_ROOT = path.join(ROOT, 'upstream');

function upstream(relativePath) {
  return path.join(UPSTREAM_ROOT, relativePath);
}

module.exports = { ROOT, UPSTREAM_ROOT, upstream };
