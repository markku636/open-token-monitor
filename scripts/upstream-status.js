'use strict';

// Which upstream release upstream/ holds and the ones published after it:
//
//   npm run upstream:status            lines for people
//   npm run upstream:status -- --json  { url, current, latest, behind, pending, github } for scripts and CI
//
// The current release is the tag on the commit the latest subtree squash came
// from (git-subtree-split); upstream/package.json gives its version too.
//
// Tags come from GitHub. When UPSTREAM_URL points at a mirror, GitHub is asked
// too, to name the releases the mirror does not have yet.

const path = require('node:path');
const { latestSquash, upstreamVersion } = require('./check-upstream');
const { DEFAULT_UPSTREAM_URL, TAG_RE, compareVersions, githubTags, remoteTags, upstreamUrl } = require('./upstream-remote');

const ROOT = path.join(__dirname, '..');

// The release tag upstream/ was pulled from, else v<upstream/package.json>.
function currentTag(cwd, tags) {
  const split = latestSquash(cwd)?.split || null;
  const pinned = split ? tags.find((t) => t.commit.startsWith(split) || split.startsWith(t.commit)) : null;
  if (pinned) return pinned.tag;
  const version = upstreamVersion(cwd);
  return version ? `v${version}` : null;
}

// The release tags after `tag`, oldest first.
function tagsAfter(tag, tags) {
  return tag && TAG_RE.test(tag) ? tags.filter((t) => compareVersions(t.tag, tag) > 0) : [];
}

// `github`: GitHub's tags when `url` is a mirror, null when GitHub did not
// answer, false when it was not asked (`url` is GitHub itself).
function upstreamStatus({ cwd = ROOT, url = upstreamUrl(), tags = remoteTags(url), github = url === DEFAULT_UPSTREAM_URL ? false : githubTags() } = {}) {
  const current = currentTag(cwd, tags);
  const latest = tags.at(-1) || null;
  const pending = tagsAfter(current, tags).map((t) => t.tag);
  const onMirror = new Set(tags.map((t) => t.tag));
  return {
    url,
    current: { tag: current, version: upstreamVersion(cwd), commit: latestSquash(cwd)?.split || null },
    latest: latest ? { tag: latest.tag, commit: latest.commit } : null,
    behind: pending.length > 0,
    pending,
    github: githubSummary(github, current, onMirror)
  };
}

// null: not asked; { unreachable: true }: asked, no answer.
function githubSummary(github, current, onMirror) {
  if (github === false) return null;
  if (!github) return { unreachable: true };
  return {
    latest: github.at(-1)?.tag || null,
    missing: tagsAfter(current, github).map((t) => t.tag).filter((tag) => !onMirror.has(tag))
  };
}

function describe(status) {
  const lines = [
    `upstream/: ${status.current.tag || '(unknown)'} (commit ${String(status.current.commit).slice(0, 12)})`,
    `newest:    ${status.latest?.tag || '(none)'} at ${status.url}`
  ];
  // Only with a mirror (UPSTREAM_URL) is GitHub asked separately.
  const lacking = status.github?.missing?.length > 0;
  if (status.github?.unreachable) {
    lines.push('GitHub:    could not be reached; check by hand whether the mirror lacks a newer release.');
  } else if (lacking) {
    lines.push(`GitHub:    ${status.github.latest}; the mirror lacks ${status.github.missing.join(', ')}.`,
      'Update the mirror from GitHub first, or unset UPSTREAM_URL to pull from GitHub.');
  } else if (status.github) {
    lines.push(`GitHub:    ${status.github.latest} (the mirror has every newer release).`);
  }
  if (status.behind) {
    lines.push(`Behind by ${status.pending.length} release(s): ${status.pending.join(', ')}.`,
      `Next, one release at a time: npm run upstream:update -- next   (${status.pending[0]})`);
  } else {
    // "Up to date." only when GitHub agrees.
    lines.push(lacking || status.github?.unreachable ? 'Up to date with the mirror.' : 'Up to date.');
  }
  return lines.join('\n');
}

if (require.main === module) {
  try {
    const status = upstreamStatus();
    console.log(process.argv.includes('--json') ? JSON.stringify(status, null, 2) : describe(status));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { currentTag, describe, tagsAfter, upstreamStatus };
