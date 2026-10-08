# AGENTS.md

Open Token Monitor 的 monorepo，給所有 coding agent 的入口。這裡放指令、會被無關改動弄壞的規則、升級上游的步驟與慣例。功能說明在 [docs/hub.zh-TW.md](docs/hub.zh-TW.md)，Rust 用戶端另有 [tauri/AGENTS.md](tauri/AGENTS.md)。

## 佈局

| 路徑 | 內容 |
|---|---|
| `upstream/` | 上游 [Javis603/token-monitor](https://github.com/Javis603/token-monitor)（MIT），git subtree `--squash`，鎖在一個 release tag。**唯讀。** |
| `hub/`、`docker/`、`deploy/` | hub overlay：PostgreSQL、組織資料、dashboard、報表，疊在上游的 hub 前面 |
| `client/`、`packaging/` | 公司版 Electron 用戶端：上游的 app 加上首次啟動設定，見 [client/README.md](client/README.md) |
| `tauri/` | Rust/Tauri 用戶端，上傳格式與上游逐欄相容；有自己的 `package.json` 與規則 |
| `scripts/` | 發行、上游檢查與升級工具 |
| `upstream-touchpoints.json` | 本 repo 複製、修補或移植上游程式的接縫，`npm run upstream:impact` 用 |

## 指令

```bash
npm ci                      # 根目錄的相依；upstream/ 裡不安裝
npm run hub                 # 啟動 hub（node hub/server.js），讀根目錄的 .env
npm test                    # node --test "tests/**/*.test.js"
npm run lint
npm run check:upstream      # upstream/ 必須和最近一次 subtree pull 完全相同
npm run verify              # check:upstream + lint + test，commit 前一定要過
npm run upstream:status             # 目前的上游版本與 GitHub 上更新的版本
npm run upstream:update -- <next|latest|vX.Y.Z>   # 把 upstream/ 換成上游的 release（next 一版一版升），跑 verify，寫 tmp/upstream-impact.md
npm run upstream:impact             # 上游升級碰到的接縫、路由與設定（docs/upstream-upgrade.zh-TW.md）
npm run smoke:hub                   # 升級驗證用的丟棄式 hub（PGlite、測試金鑰、假資料），金鑰在 tmp/smoke-hub.env
npm run build:image -- --dry-run     # hub 映像的發行（docs/packaging.zh-TW.md）；--no-tag 試跑
npm run build:client -- --platform win --dry-run   # 公司版用戶端（docs/client-build.zh-TW.md），讀 .env.client

cd tauri && npm ci && npm run verify   # Rust 用戶端：前端 build + vitest + cargo test + clippy
npm --prefix tauri run test:compat     # Rust 用戶端與 upstream/、根目錄 overlay 的相容測試（會編 tm-agent）
```

## Tripwires

- **`upstream/` 不改。** 它只能經由 `npm run upstream:update`（`git subtree pull --squash`）改變，`check:upstream` 會擋下其他任何改動。上游一改就壞掉的地方，修改本 repo，絕不修改 `upstream/`。上游的 squash 與 merge commit 不 amend、不 rebase。
- 讀上游程式一律 `require(upstream('src/…'))`，不要寫 `../upstream/src/…`：上游的位置只寫在 `upstream.js`。`/api/custom/…` 是 hub 的路由名稱，跟目錄無關，不能改。
- `hub/server.js` 的 CLI bootstrap 必須保留上游每一行，新步驟只能插在行與行之間（`hubOverlayBootstrap.test.js`）。新功能以 `attachX(hub, …)` 掛上，不要在 `createDashboardHub(...)` 那一行加參數。
- `hub/core.js` 逐行對照上游 `createHub()` 的內部函式。`core.test.js` 的指紋失敗時，先讀上游的新版本、同步修改 `core.js`，再更新指紋；不要只改指紋。
- 上傳一律先經過 `ingestGuard.js`。client 金鑰發給每一位使用者，等於公開，任何新的上傳路徑都不能繞過它。
- 資料庫只有 PostgreSQL。schema 只能新增 migration（`hub/persistence/sql/NNNN_*.sql`），不改已經有的檔案；命名與型別照 [postgres.zh-TW.md](docs/postgres.zh-TW.md)「命名慣例」，`persistenceStore.test.js` 會檢查。SQL 參數一律用 `$1…$n`，清單用 `= ANY($n)`。
- `hub/dashboard.html` 任何連得到 hub 的人都拿得到，絕不能寫入 secret；`hubDashboard.test.js` 會檢查。頁面上每個由資料來的名稱（單位、人、主機、email）都用 `textContent` 或 `esc()` 放進去，不能直接拼進 HTML。
- `.env`、`.env.client` 與 `docs/dept/`（人事公告，真實個資）絕不能進版控或複製到別處。測試只用合成的資料與 `example.com`／`.example`／`.test` 網域。
- 公司版用戶端的安裝檔帶著 client 金鑰：`TM_CLIENT_SECRET` 只能是 client 金鑰，絕不能是 admin 的 `TOKEN_MONITOR_SECRET`；CI 裡不要 `set -x`，也不要印出 `TM_CLIENT_*`。
- 本 repo 不附任何組織的 logo。自己的 logo 放在 `client/assets/` 等位置（[client/README.md](client/README.md)），不要提交到這個公開 repo。
- 發行只用 `npm run build:image`。CHANGELOG 的 `corp/v…` 段落與 `docs/releases/` 都由它產生，不要手寫；`corp/v*` tag 也只由它打。
- `tauri/` 的規則（wire 相容、核心不依賴 Tauri、只用 rustls……）見 [tauri/AGENTS.md](tauri/AGENTS.md)；改動 `tauri/src-tauri/src/wire/`、`usage/`、`hub/payload.rs`、`limits/` 之後一定要跑 `npm --prefix tauri run test:compat`。

## 升級上游

上游每出一版，照下面的步驟把 `upstream/` 換成新版，並把本 repo 跟上。完整的 SOP、接縫對照與客製功能回歸清單在 [docs/upstream-upgrade.zh-TW.md](docs/upstream-upgrade.zh-TW.md)。Claude Code 可以直接用 `/upstream-update [next|vX.Y.Z|latest]`（[.claude/skills/upstream-update/SKILL.md](.claude/skills/upstream-update/SKILL.md)）；GitHub Actions 每週一檢查上游，有新版會自動開 PR（`.github/workflows/upstream-watch.yml`），在 PR 留言 `@claude` 就能讓 Claude 接手。

1. **看版本。** `npm run upstream:status`。一版一版升（`next`）；跳過中間的版本時 `upstream:update` 會拒絕，除非加 `--allow-skip`。
2. **開分支、拉新版。** working tree 必須乾淨。每一版在自己的 worktree 與 `upstream/<tag>` 分支（`git worktree add ../open-token-monitor-upstream-<tag> -b upstream/<tag>`），再 `npm run upstream:update -- next`。它會 commit 一個 squash 與一個 merge，接著跑 `npm run verify`，並把影響清單寫到 `tmp/upstream-impact.md`。結束碼 0 是 verify 通過，3 是已經拉進來但 verify 失敗。
3. **讀影響清單。** `tmp/upstream-impact.md`（或 `npm run upstream:impact`）列出：
   - **接縫**（`upstream-touchpoints.json`）：每一項都有原因與對應的測試。
   - **overlay 載入的上游檔案**：這些檔案的 `upstream('…')` 指到的上游程式變了。
   - **`tauri/` 移植的上游檔案**：Rust/TS 註解裡點名的上游檔案變了。
   - 這次包含的上游 commit，以及沒有對應檔案的其他變動。
   看上游的實際差異：`git diff <舊 squash> <新 squash> -- <上游路徑>`。兩個 squash commit 列在清單最後；路徑不加 `upstream/` 前綴。
4. **修 overlay。** 讓 `npm run verify` 通過。常見的修法：
   - `core.test.js` 指紋：讀上游新版的函式，同步 `hub/core.js`，再更新指紋。
   - `UPSTREAM_PATCHES`（`packaging/build-client.js`）找不到原文：讀上游新版的那一段，重寫 patch。
   - `hubOverlayBootstrap.test.js`：把上游 bootstrap 的新行照順序抄進 `hub/server.js`。
   - 上游新增的寫入路由：決定 client 金鑰能不能用（`hub/access.js`），上傳路徑要經過 `ingestGuard.js`。
   - 上游的 eslint 設定或 plugin 版本變了：根目錄 `package.json` 的 devDependencies 對齊上游 lockfile 的版本。
5. **跟上 Rust 用戶端。** 清單裡的 `tauri/` 項目，逐一讀上游的差異，把行為的改變移植過去（註解標出對應的上游檔案與函式）。上游的 `scripts/vendor/tokscale.json` 變了，就原樣複製到 `tauri/scripts/vendor/tokscale.json`。然後：
   - `cd tauri && npm ci && npm run verify`
   - `npm --prefix tauri run test:compat`：wire 格式、limits 的 accountKey、session detail 都要和上游的 JavaScript 一致。
6. **記錄。** 在 `CHANGELOG.md` 的「未發行」加一行：「上游升到 vX.Y.Z」，加上這次為了跟上而改的行為；`tauri/` 有改就寫進 `tauri/CHANGELOG.md`。有改設定、路由或部署方式的，同時更新對應的文件。
7. **commit 與 PR。** 修正放在拉上游那兩個 commit 之上，例如 `fix(hub): follow upstream v0.64.0 createHub changes`，不要改寫它們。PR 說明貼上影響清單，並勾掉已經處理的項目。

做不到的（例如上游重寫了 overlay 依賴的整個區塊）就停下來，把卡住的地方寫在 PR 裡，不要為了讓測試通過而刪測試、放寬檢查或修改 `upstream/`。

- 一版一版升，每一版在自己的 worktree 與 `upstream/vX.Y.Z` 分支，修到 `npm run verify` 全綠、做完 SOP 的「客製功能回歸清單」才合進 main。
- 升級分支不用一般的 `git rebase`，它會攤平上游的 merge commit；main 動過時照 SOP 重拉。
- 上游新增的寫入路由、上傳欄位與設定先關閉，怎麼處理要問使用者。
- 碰到 SOP 沒寫到的接縫，補進 `upstream-touchpoints.json` 與 SOP 的回歸清單。改了 SOP，skill 要一起改。

## 發行與 tag

推 tag 就是發行，會跑 GitLab 的 pipeline，只在使用者要求時做。兩種 tag，版本號都是 `<上游版本>-corp.<N>`，N 各算各的（[docs/hub.zh-TW.md](docs/hub.zh-TW.md)「發行：兩種 tag」）：

- **`corp/v<版本>`：hub。** 只用 `npm run build:image` 打：
  - 它會檢查 working tree 乾淨、`check:upstream` 與 `verify`，從 origin 的 tag 算出 N。
  - 它會把 CHANGELOG 的「未發行」改成這一版、寫 `docs/releases/<版本>.md`、commit `docs(release): corp/v<版本>`，再打 annotated tag，只推 tag。
  - 之後要 `git push origin HEAD`，把發行 commit 也推上去。
  - 先 `npm run build:image -- --dry-run` 看版本與文件。「未發行」是空的時候它會拒絕發行。
  - tag 的 pipeline：`verify` → `build:hub` → 手動 `deploy:hub`。
- **`client-v<版本>`：用戶端。** 手動 `git tag client-v<版本>` 並推到 origin。tag 的 pipeline 不跑 verify，所以先確認那個 commit 通過 `npm run verify`。N 是同一個上游版本最大的 `client-v*` 加 1。
  - 推到 GitHub：`.github/workflows/client-release.yml` 先跑 verify，再建立公開的 GitHub Release。安裝檔一律不帶 hub 與金鑰（`TM_CLIENT_NO_HUB=1`），這個 workflow 絕不能用 `TM_CLIENT_SECRET`、`TM_CLIENT_HUB_URL` 或任何 secret（`clientBuild.test.js`）。
- 推出去的 tag 不刪、不移、不重用。那一版有問題就修好發下一號。
- 只有 `client-v*` 建立 Release；`corp/v*` 的 job 不能有 `release:`（`deployHub.test.js`）。

## 慣例

- **功能異動一定要記進文件，而且跟程式放在同一個 commit。** 功能異動包括新功能、行為改變，以及設定、路由、部署或發行方式的改變。
  - 在 [CHANGELOG.md](CHANGELOG.md) 的「未發行」加一行（`tauri/` 的改動記在 [tauri/CHANGELOG.md](tauri/CHANGELOG.md)）。
  - 同時更新對應的 `docs/` 段落。
  - 純重構、測試與錯字不用記。
- 文件用繁體中文；程式註解、識別字與 commit 訊息用英文（`tauri/` 的註解與 UI 字串用繁體中文，見 [tauri/AGENTS.md](tauri/AGENTS.md)）。
- commit 格式：`<type>(<scope>): <subject>`，採 conventional commits，例如 `feat(hub): …`、`fix(tauri): …`、`chore(upstream): …`。
  - subject 不超過約 72 字元。
  - diff 看不出原因時才寫 body，段落不硬換行。
  - 不加 AI 的 `Co-Authored-By`。
- 一個 session 一個 worktree，不要多個 session 共用同一個 working tree。
  - 開法：`git worktree add ../open-token-monitor-<名稱> -b <分支>`。
- 新增相依或工具之前，先在 PR 說明理由。
