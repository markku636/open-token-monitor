---
name: upstream-update
description: Move upstream/ (Javis603/token-monitor) to a newer release one release at a time and bring the hub overlay, the Electron client packaging and the Rust/Tauri client in line with it — read the impact report, fix the seams, run the custom-feature regression checklist, then merge into main. Use when asked to update, upgrade or sync the upstream core (「升級上游」「更新上游」「同步上游」「上游出新版」「升到 v0.xx」), or on an upstream/<tag> pull request opened by the upstream-watch workflow.
argument-hint: "[next|vX.Y.Z|latest|status]"
---

# Upstream update

Follow [docs/upstream-upgrade.zh-TW.md](../../../docs/upstream-upgrade.zh-TW.md) (the SOP below; AGENTS.md, section 升級上游, summarises it). This skill is that procedure, step by step; the rules and their reasons are in the SOP. If the two disagree, follow the SOP and tell the user this skill needs updating. Talk to the user in the language they use; write code comments and commit messages in English, docs in Traditional Chinese.

Target: `$ARGUMENTS`

| Argument | What to do |
|---|---|
| `status` | Only section 0; change nothing. |
| `next` or empty | Pull the next release. When another one follows, ask the user whether to go on. |
| `vX.Y.Z` or `latest` | Go there one release at a time: sections 1–9 for each release in between. |

## Ground rules

- **`upstream/` is never edited**, reverted or re-pulled on the same branch. Never amend or rebase the squash and merge commits `npm run upstream:update` makes, and never run a plain `git rebase` on an upgrade branch: it flattens upstream's merge commit. If main moved meanwhile, re-pull on a fresh branch (SOP, section 7).
- **One release at a time.** Never pass `--allow-skip` unless the user explicitly asks to skip releases.
- **No green-washing.** Do not delete tests, loosen assertions, skip tests, or update a fingerprint or patch count without changing the code it guards.
- **Stop and ask about decisions** (AskUserQuestion when available; on a PR, a comment that names the question, then stop): what to do with a route, upload field or setting upstream added (SOP, section 5). A new write route is admin-only by default; a new GET route is readable with the client key as soon as the upgrade lands, so ask about every one.
- **Confirm outward actions first**: pushing to origin (main or any branch), tagging, merging a PR.
- **One worktree per session**; run git as `git -C <dir>`. If the main checkout has someone else's uncommitted changes, stop: do not commit, stash, revert or delete them.
- `.env`, `.env.client` and `.env.ubuntu` are never shown or copied into a worktree.
- Installing on test machines and pressing buttons in CI are the user's to do: prepare them, say exactly what to do, then check the result.
- No AI `Co-Authored-By` line in commits (AGENTS.md).

## 0. Where things stand

In the directory that has main checked out:

```bash
git -C <main checkout> status --short
git -C <main checkout> fetch origin && git -C <main checkout> status -sb
npm run upstream:status
```

- `Up to date.`: tell the user and stop.
- `Behind by N release(s)`: list them and say they will go one at a time.
- Only with `UPSTREAM_URL` set (a mirror): `the mirror lacks …` means the mirror is behind GitHub — tell the user; without updating the mirror (or unsetting `UPSTREAM_URL`) only the releases it has can be pulled. `GitHub: could not be reached` with `Up to date with the mirror.` only says the mirror has nothing newer: ask the user to look at GitHub's releases, never call it up to date.
- main dirty or behind origin: follow the ground rules; if only behind, `git pull --ff-only`.
- If the current branch already holds the pull (an `upstream/<tag>` branch or PR opened by the upstream-watch workflow, whose latest `chore(upstream): update upstream to <tag>` commit is in `git log`), skip sections 1 and 2 and run `npm run upstream:impact -- --out tmp/upstream-impact.md` instead.
- Argument `status`: stop here.

## 1. Worktree

```bash
git -C <main checkout> worktree add ../open-token-monitor-upstream-<tag> -b upstream/<tag> main
cd ../open-token-monitor-upstream-<tag> && npm ci
```

`<tag>` is the release this round pulls (the `Next` line of `upstream:status`). In a GitHub Actions run on a PR, work on the checked-out branch instead.

## 2. Pull

```bash
npm run upstream:update -- next
```

It runs the whole `npm run verify`, which takes minutes: give it a 10-minute timeout or run it in the background.

- Exit 0: verify passed. Exit 3: the pull is committed but verify failed — expected work, not an error to stop on. Go on to section 3 either way.
- Exit 1: an error — a refused skip, a dirty working tree, the network. If `git subtree pull` failed halfway, follow the SOP's 工具 section (`git status`, `git merge --abort`).
- If the impact report could not be written after the pull, fix the cause, then `npm run upstream:impact -- --out tmp/upstream-impact.md`.

## 3. Read the impact

Read `tmp/upstream-impact.md` in full. For every item, look at the actual upstream change before touching our code:

```bash
git diff <from-squash> <to-squash> -- <upstream path>   # both squash commits are named at the end of the report; no upstream/ prefix
```

Mark each item as no impact, a seam to fix, behaviour to port, or a decision (SOP, section 2), in a short table used again in sections 7 and 11. Every item under "Hub routes" and "TOKEN_MONITOR_* settings" is a decision unless it plainly has nothing to do with the hub (say, a provider token only the client reads — then check whether `tauri/` reads it too).

## 4. Fix the overlay until `npm run verify` passes

Work through the SOP's table in section 3. Typical fixes (AGENTS.md, Tripwires):

- `tests/core.test.js` fingerprint mismatch: read the new upstream function, change `hub/core.js` to match, then update `UPSTREAM_FINGERPRINTS`. Never only the fingerprint.
- `UPSTREAM_PATCHES` in `packaging/build-client.js` cannot find its text, or a watched string's count changed (for example a language upstream added): read the new upstream lines, rewrite or add the patch so it does the same thing.
- `tests/hubOverlayBootstrap.test.js`: copy upstream's new bootstrap lines into `hub/server.js` in order; overlay steps stay between them.
- `tests/ownDeviceView.test.js`: sort a new `/api/stats` field into `AGGREGATE_STATS_KEYS` or `PASS_THROUGH_STATS_KEYS`.
- A new upstream route: decide with the user whether client keys may use it (`hub/access.js`); any new upload path goes through `hub/ingestGuard.js`.
- Lint: align root `package.json` devDependencies with upstream's lockfile versions, then `npm install` to refresh `package-lock.json`.

After each seam: run only the tests its report item names under verify, then commit it on its own as `fix(<scope>): …`, saying what upstream changed. For a decision, ask with what upstream changed, what it means for the hub and a recommendation (usually: block it for now), with at least "as recommended" and "not now, note it as a to-do" as options; implement the answer and record it in the CHANGELOG. Finish with a full `npm run verify`.

If a fix is out of reach (upstream rewrote a whole block the overlay depends on), stop and write down where it is stuck.

## 5. Port to the Rust client

For each `tauri/` item in the report, and each seam whose check points into `tauri/`, read the upstream diff and port behaviour changes (keep the comments that name the upstream file and function). If upstream's `scripts/vendor/tokscale.json` changed, copy it verbatim to `tauri/scripts/vendor/tokscale.json`. Then:

```bash
cd tauri && npm ci && npm run verify
npm --prefix tauri run test:compat     # builds tm-agent; compares with upstream's own JavaScript
```

tauri/AGENTS.md has the rules (wire compatibility, no Tauri in the core, rustls only, …). Commit as `fix(tauri): …` with a `tauri/CHANGELOG.md` line.

## 6. Regression checklist

SOP, section 6:

1. **Automatic**: `npm run verify`, `npm --prefix tauri run verify` and `npm --prefix tauri run test:compat` all pass. If the user has a test PostgreSQL, also run `npm test` with `TOKEN_MONITOR_TEST_DATABASE_URL`; compare the known `org.test.js` failure with main before calling it a regression.
2. **Hub smoke**: for every release that touched a hub seam, and always for the last one.
   - Start `node scripts/smoke-hub.js --host 127.0.0.1` in the background. Run node directly, not through npm: stopping the background task may stop only npm and leave the hub running. `--host 127.0.0.1` avoids a firewall prompt; leave it out when a test machine must reach it.
   - The keys are in `tmp/smoke-hub.env`. They are test keys and fine to use, but keep them out of the report.
   - Check with `curl`: `/api/health`, `/api/custom/health` (admin and client key), the pages, an API token created and used on a reports API route, and GET and write calls with the client key on every route upstream added.
   - A headless browser screenshot can confirm the dashboard renders with data; list the interactive checks (filters, `/admin` login, the org roster editor and Excel download, import preview) for the user to tick.
   - When done, stop it and make sure nothing listens on port 17399 any more (`netstat -ano | grep :17399` on Windows, `lsof -i :17399` elsewhere). If something does, stop only that PID; never kill processes by name, they may belong to another session.
3. **Client smoke**: for the last release, whenever a client release follows.
   - `npm run smoke:hub` stays up without `--host`, so the test machine can reach it.
   - Give the user the SOP's command that builds a `<version>-corp.0` test client with `-HubEnvFile tmp\smoke-hub.env`. Never the production `.env.ubuntu`.
   - The user installs it on a test machine, never on the computer they use every day; list the checks for them to tick.

Say plainly which items were not done and why; never report them as verified.

## 7. Record and commit

- `CHANGELOG.md`, 未發行: one line「上游升到 vX.Y.Z」plus what users will notice and the decisions from section 4; `tauri/CHANGELOG.md` when tauri/ changed. Update `docs/` for changed settings, routes or deployment.
- Docs and CHANGELOG lines for a behaviour change (blocking an upstream route, say) go in the same commit as the code (AGENTS.md, 慣例). Only the「上游升到 vX.Y.Z」line may be committed alone (`docs(changelog): …`), because the tool made the merge commit.
- Commit with conventional commits (`fix(hub): …`, `fix(client): …`, `fix(tauri): …`, `docs: …`).
- If a seam turned up that `upstream-touchpoints.json` and the SOP's regression list do not cover, add it (and keep this skill in step with the SOP).

## 8. Merge into main

Ask first: "Merge `upstream/<tag>` (N commits: …) into main?". Then:

```bash
git -C <main checkout> merge --ff-only upstream/<tag>
```

- If it fails, main moved: per the SOP, section 7, start a fresh branch from the new main, pull the same release again, `git cherry-pick` the fixes, and verify again. Never rebase.
- On a PR: put the impact report in the description and tick the handled items. It must be merged with a merge commit or fast-forward, never squash or rebase merging.
- Pushing to origin is a separate question.
- Remove the worktree: stop the smoke hub and move every shell out of the folder, then `git -C <main checkout> worktree remove ../open-token-monitor-upstream-<tag>` (the branch is in main, so `git branch -d` works). On Permission denied, see the SOP's 卡住或要放棄.

## 9. Next release

If another release follows and the user wants to go on, back to section 1 with a new worktree from the new main.

## 10. Hand over to a release

When the user wants to release, point them to the SOP, section 8, and AGENTS.md, 發行與 tag — only on their request:

- Release both the hub and the client, from the same upstream version; N starts at 1 again.
- Hub first (`npm run build:image`, then the pipeline's `deploy:hub`), the client after it.
- The client cannot be downgraded: the client smoke must be complete before the `client-v*` tag.

## 11. Report

Summarise for the user (or as a PR comment):

- From which release to which, and the commits of each.
- Each impact item and what was done about it, including the decisions.
- The regression checklist: what passed and what the user still has to do.
- Merged into main or not, pushed or not, release pending or not.
- Seams this upgrade found that the SOP and `upstream-touchpoints.json` did not cover; propose adding them so the next upgrade is easier.
