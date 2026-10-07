# 上游升級 SOP

把 `upstream/` 從上游的一個 release 升到下一個，而且**不弄壞任何客製功能**，Rust 用戶端（`tauri/`）也跟著上游走。人照這份做，Claude Code 的 `/upstream-update` skill（[.claude/skills/upstream-update/](../.claude/skills/upstream-update/SKILL.md)）也照這份做；兩者不一致時以這份為準，並更新 skill。[AGENTS.md](../AGENTS.md)「升級上游」是這份的摘要。

## 原則

- **`upstream/` 不改。** 它只由 `npm run upstream:update` 改變；上游一改就壞的地方，改 overlay（`hub/`、`client/`、`packaging/`…）或 `tauri/`，`check:upstream` 會擋下任何對 `upstream/` 的修改。
- **一版一版升。** 落後好幾版時，每個上游 release 各升一輪，每一輪都修到全綠才拉下一版；壞掉時才知道是哪一版改的。`upstream:update` 預設拒絕跳版。
- **升級在自己的 worktree 和分支做，main 永遠可以發行。** 回歸清單（第 6 節「客製功能回歸清單」）全部通過之前不合進 main。
- **上游新功能先關閉。** 上游新增的寫入路由只有 admin 金鑰能用（`hub/access.js`），上傳欄位、設定在有人決定之前不開放。例外是**讀取**：client 金鑰可以 GET 任何上游路由，所以上游新增的 GET 路由一升級就是每個用戶端都讀得到，回傳的內容要先確認可以公開（第 5 節）。
- **每次升完回頭改這份 SOP。** 碰到這份沒寫到的接縫，就加進 [upstream-touchpoints.json](../upstream-touchpoints.json) 與回歸清單，下次會自動列出來。改了這份，skill 要一起改。

## 工具

上游直接從 GitHub 的 [Javis603/token-monitor](https://github.com/Javis603/token-monitor) 拉，不需要鏡像。連不到 GitHub、要改從鏡像拉時，設環境變數 `UPSTREAM_URL`（[hub.zh-TW.md](hub.zh-TW.md#同步上游)「同步上游」）。

| 指令 | 做什麼 |
|---|---|
| `npm run upstream:status` | 目前的上游版本，以及 GitHub 上更新的版本；設了 `UPSTREAM_URL` 時，也列出 GitHub 有而鏡像還沒有的版本 |
| `npm run upstream:update -- next` | 拉下一個 release 進 `upstream/`（squash commit 加 merge），跑 `npm run verify`，寫出影響報告 `tmp/upstream-impact.md` |
| `npm run upstream:update -- vX.Y.Z` | 拉指定的 release（`latest` 是最新的那一版）；跳過中間的版本時要加 `--allow-skip` |
| `npm run upstream:impact` | 把影響報告（最近一次拉取對前一次）印在畫面上；`-- --out tmp/upstream-impact.md` 寫回檔案；`--from`、`--to` 比較任兩個 squash commit |
| `npm run check:upstream` | `upstream/` 必須和最近一次拉取完全相同（包含在 `verify` 裡） |
| `npm run smoke:hub` | 給 hub 冒煙用的丟棄式 hub：這個 worktree 的程式、PGlite（在 Node 裡跑的 PostgreSQL，停掉就消失）、測試金鑰與假資料，不需要 Docker（第 6 節） |
| `cd tauri && npm ci && npm run verify` | Rust 用戶端：前端 build、vitest、cargo test、clippy |
| `npm --prefix tauri run test:compat` | Rust 用戶端與 `upstream/`、根目錄 overlay 的相容測試（會編 tm-agent） |

`upstream:update` 的結束代碼：

| 代碼 | 意思 | 下一步 |
|---|---|---|
| 0 | 拉進來了，verify 通過（或已經是那一版） | 讀影響報告，做回歸清單 |
| 3 | 拉進來而且 commit 了，但 verify 沒過 | 正常狀況：讀影響報告，修 overlay |
| 1 | 出錯：參數錯、working tree 不乾淨、跳版被拒、網路，或 `git subtree pull` 中途失敗 | 看錯誤訊息；`git status` 顯示 merge 進行中時先 `git merge --abort`，再用 `git log --oneline -3` 確認沒有半套的拉取 |

拉取已經 commit 之後，影響報告寫不出來只會警告，結束代碼仍是 0 或 3；修好原因後用 `npm run upstream:impact -- --out tmp/upstream-impact.md` 補寫。

影響報告的內容：

- 被碰到的接縫：來自 `upstream-touchpoints.json`，附要跑的測試。`watch` 的字串次數變了也會列出來，例如上游多了一個語系。上游的 tokscale pin 和 `tauri/scripts/vendor/tokscale.json` 不同時，也會多一項。
- 載入了上游改動檔案的 overlay 檔案：自動掃描 `upstream('…')`、用戶端的 `require('../src/…')` 和 Dockerfile 的 `COPY upstream/…`。
- 移植了上游改動檔案的 `tauri/` 檔案：Rust/TS 註解裡點名的上游檔案（[tauri/AGENTS.md](../tauri/AGENTS.md)）。
- 上游新增或移除的 hub 路由，以及 `TOKEN_MONITOR_*` 設定。
- 這次包含的上游 commit，以及其他改動的 `src/`、`docs/` 檔案。

## 什麼時候升

- 每個月跑一次 `npm run upstream:status`。repo 在 GitHub 上時，`.github/workflows/upstream-watch.yml` 每週一檢查上游，有新版會自動開 PR（第 1 節）。
- 落後兩版以上就排升級。累積越多，一次要修的接縫越多。
- 上游修了你們用得到的 bug，或使用者要上游的新功能時，提早升。

## 0. 事前準備

1. **連得到上游。** `upstream:status` 要能列出 GitHub 上的版本。設了 `UPSTREAM_URL` 從鏡像拉時，它會另外問 GitHub：說「the mirror lacks …」代表鏡像還沒有上游的新版，先讓鏡像跟上 GitHub（或取消 `UPSTREAM_URL`），不然只能升到鏡像上有的版本；說「GitHub: could not be reached」時，自己到 GitHub 的 releases 看一下，不要當成已經是最新。
2. **main 乾淨，而且和 origin 同步。** 在 checkout 著 main 的目錄執行 `git status`、`git pull --ff-only`。
3. **確認沒有別的 session 正在用 main 發行。** 多個 session 可能同時在這個 repo 工作。
4. **開 worktree 與分支**，一版一個：

   ```bash
   git worktree add ../open-token-monitor-upstream-v0.64.0 -b upstream/v0.64.0 main
   cd ../open-token-monitor-upstream-v0.64.0
   npm ci
   ```

   `.env`、`.env.client`、`.env.ubuntu` 不要複製進 worktree（AGENTS.md）。升級的驗證都用 `npm run smoke:hub` 的測試金鑰，用不到正式的設定。

## 1. 拉一版

```bash
npm run upstream:update -- next
```

- 拉進來的是一個 `Squashed 'upstream/' changes from …` commit 加上 `chore(upstream): update upstream to vX.Y.Z` merge commit。
- **這兩個 commit 不 amend、不 rebase、不還原**，也不在同一個分支上重拉；`check:upstream` 靠它們判斷 `upstream/` 有沒有被改過。唯一要重拉的情況是 main 在升級期間動過，做法見第 7 節，在新的分支上重拉。
- 已經是最新的版本時，它會說 already，什麼都不做。
- **從 upstream-watch 開的 PR 接手**：PR 的 `upstream/<tag>` 分支已經拉好了那一版，不要再拉。在自己的 worktree checkout 那個分支，跑 `npm run upstream:impact -- --out tmp/upstream-impact.md`，從第 2 節開始；PR 說明裡有 workflow 跑的 verify 與 `test:compat` 結果。

## 2. 讀影響報告

打開 `tmp/upstream-impact.md`，**每一項都要看過上游真正的改動**再決定，不能只看清單：

```bash
git diff <from> <to> -- <上游路徑>     # 報告最後一行有兩個 squash commit；路徑不加 upstream/ 前綴
```

每一項標成四種之一，記下來，最後寫進 CHANGELOG 與 PR 說明：

| 標記 | 意思 | 例子 |
|---|---|---|
| 沒影響 | 上游改的地方 overlay 與 `tauri/` 都不依賴 | 上游新增一個用戶端的 provider |
| 修接縫 | overlay 照著上游的舊樣子寫，要跟著改 | `core.js` 指紋不符、bootstrap 多了一行 |
| 移植行為 | overlay 或 `tauri/` 取代了上游的某段邏輯，上游的新行為要搬過來 | 上游 `getStats` 多了欄位，`core.js` 也要給；上游的上傳多了欄位，Rust 用戶端也要送 |
| 要決定 | 需要產品或安全上的決定 | 上游新增的寫入路由要不要開放 |

## 3. 修接縫，直到 `npm run verify` 全綠

| 失敗的地方 | 代表什麼 | 怎麼修 |
|---|---|---|
| `tests/hubOverlayBootstrap.test.js` | 上游 `src/hub/server.js` 的 CLI bootstrap 變了 | 把上游新的幾行照順序抄進 `hub/server.js`，overlay 的步驟只能插在行與行之間；新功能用 `attachX(hub, …)` 掛上 |
| `tests/core.test.js`：指紋不符 | `core.js` 對照的上游函式改了 | 讀上游新版的函式，把 `hub/core.js` 改成一樣的語意，**再**更新 `UPSTREAM_FINGERPRINTS`；不能只改指紋 |
| `tests/core.test.js`：行為對照不符 | 上游的回應多了或少了欄位 | 同上；例如上游 `getStats` 多一個欄位，`core.js` 也要算出來 |
| `tests/ownDeviceView.test.js` | 上游 `/api/stats` 多了欄位，或「只顯示這台電腦」換掉的函式改了 | 新欄位分進 `AGGREGATE_STATS_KEYS` 或 `PASS_THROUGH_STATS_KEYS`；函式改了就照上游新版改 `client/electron/ownDeviceView.js`（[client-build.zh-TW.md](client-build.zh-TW.md)「只顯示這台電腦」） |
| `tests/clientBuild.test.js`：`UPSTREAM_PATCHES` 找不到或次數不對 | 上游改了被 patch 的那一行 | 讀上游新的寫法，改 `packaging/build-client.js` 的 patch，讓它做一樣的事（[client-build.zh-TW.md](client-build.zh-TW.md)「改動上游程式的地方」）；上游多一個語系就多一筆 |
| `tests/clientBuild.test.js`：其他 | 圖示路徑、electron-builder 設定、入口用到的上游函式變了 | 改 `client/` 或 `packaging/` |
| `tests/stream.test.js`、`tests/persistentHub.test.js` | 回應格式或標頭和上游不一致了 | 照上游新的格式改 overlay |
| `tests/upstream.test.js`、`docker/Dockerfile` | hub 執行時需要上游新的目錄或相依 | 加進 Dockerfile 的 `COPY` 或根目錄 `package.json`，新增相依先討論（AGENTS.md） |
| `npm run lint` | 上游換了 ESLint 設定或 plugin 版本 | 根目錄 `package.json` 的 devDependencies 對齊上游 lockfile 的版本，`npm install` 更新 `package-lock.json` |
| `TM_CLIENT_VERSION … must be based on the upstream version` | 用戶端版本要跟上游版本 | 本機打包用 `<新版本>-corp.0`；發行時 tag 用 `client-v<新版本>-corp.1` |

**禁止**：

- 改 `upstream/` 裡的任何檔案。
- 刪測試、放寬斷言、把測試標成 skip 來換綠燈。
- 只更新指紋或次數，不改對應的程式。
- 需要產品決定時自己決定。停下來問負責的人。

修好的程式照常 commit 在 merge commit 之上：`fix(hub): follow upstream's …`、`fix(client): …`，一個接縫一個 commit，訊息寫上游改了什麼。

## 4. 跟上 Rust 用戶端

`tauri/` 不載入上游的程式，而是移植：上傳格式與上游逐欄相容，註解標出對應的上游檔案與函式。`npm run verify` 不包含它，要另外做：

1. 影響報告「tauri/ files that port changed upstream code」的每一項，以及 `check` 指到 `tauri/` 的接縫：讀上游的差異，把行為的改變移植到 Rust/TS，註解寫上對應的上游檔案與函式。規則（wire 相容、核心不依賴 Tauri、只用 rustls……）見 [tauri/AGENTS.md](../tauri/AGENTS.md)。
2. 上游的 `scripts/vendor/tokscale.json` 變了（報告裡的 `tauri/scripts/vendor/tokscale.json` 那一項），就原樣複製到 `tauri/scripts/vendor/tokscale.json`。
3. 驗證：

   ```bash
   cd tauri && npm ci && npm run verify
   npm --prefix tauri run test:compat     # 會編 tm-agent，和上游的 JavaScript 比對
   ```

   `test:compat` 檢查 wire 格式、limits 的 accountKey、session detail 都和上游一致。失敗就是上游改了 Rust 用戶端照抄的地方，照上游新版改 `tauri/`。

修好的程式以 `fix(tauri): …` commit，`tauri/CHANGELOG.md` 一起改。

## 5. 上游新功能要做的決定

影響報告的「Hub routes upstream added or removed」與「TOKEN_MONITOR_* settings」兩節，每一項都要有結論：

- **新的路由**：`hub/overlay.js` 不認得的路由會換上 admin 金鑰交給上游處理，誰能用由 `hub/access.js` 決定：
  - **GET**：client 金鑰可以讀任何上游路由（`/api/admin`、`/api/reports`、`/api/custom` 以外）。client 金鑰等於公開，所以要確認回傳的內容每個人都能看；不行就在 `hub/access.js` 擋掉。
  - **寫入**（POST、PUT、DELETE）：client 金鑰只能 `POST /api/ingest`，其他預設只有 admin。要開放給用戶端寫，就一定要經過 `hub/ingestGuard.js`，而且絕不能讓它寫入所有人共用的設定。
- **資料庫模式**：上游的寫入路由只改上游自己的記憶體狀態，不會進 PostgreSQL，重開 hub 就不見了；讀取路由回的也是上游自己那份（資料庫模式下通常是空的）。要嘛在 overlay 實作（新的 migration），要嘛先擋掉（回 404，上游用戶端會當成 hub 不支援）。不能放著讓它穿透。
- **新的設定**：hub 讀的（`src/hub`、`src/shared`）寫進 `.env.example` 與 [hub.zh-TW.md](hub.zh-TW.md#設定)「設定」，並決定你們 hub 的值；只有用戶端或 agent 讀的，hub 不用處理，但要看 Rust 用戶端（`tauri/`）要不要讀同一個名稱、公司版用戶端的打包要不要設。
- **新的上傳欄位**：確認 `ingestGuard.js` 的大小與型別限制擋得住，`core.js` 合併時沒有丟掉；Rust 用戶端要不要送（第 4 節）。

## 6. 客製功能回歸清單

這一節確保升級沒有弄壞任何客製功能。全部打勾才能合進 main；沒辦法驗的項目要寫出原因，讓負責的人決定。

### 自動（每一版都要）

- [ ] `npm run verify` 全綠。各測試看守的客製功能：

  | 測試 | 看守的客製功能 |
  |---|---|
  | `core.test.js`、`hubOverlayBootstrap.test.js`、`stream.test.js`、`persistentHub.test.js` | overlay 和上游 hub 的接縫、PostgreSQL 版 hub 的行為與回應格式、`/api/stats` 快取與串流 |
  | `access.test.js`、`defects.test.js`、`ingestCoalescing.test.js` | 三把金鑰的權限、上傳驗證、同一台裝置上傳合併 |
  | `persistenceStore.test.js`、`persistenceCapture.test.js`、`purge.test.js`、`backups.test.js` | 資料庫 schema 與寫入、刪除歷史資料、內建備份 |
  | `org.test.js`、`orgImport.test.js`、`xlsx.test.js` | 人事公告匯入、組織樹、裝置自動歸屬、手動歸類 email |
  | `usage.test.js`、`periods.test.js`、`hubDashboard.test.js`、`sessions.test.js` | dashboard 的用量與比較、日週月區間、頁面不含 secret 與中英文、管理員登入 |
  | `reports.test.js`、`analytics.test.js`、`apiTokens.test.js`、`apiDocs.test.js` | 報表 API、API token 與 scope、`/llms.txt` 與 OpenAPI |
  | `clientBuild.test.js`、`ownDeviceView.test.js` | 公司版用戶端：預設連 hub、開機啟動與最小化、保持在工作列上方、系統匣 logo、自己的圖示、主機名稱、GitLab 更新來源與 releases 連結、只顯示這台電腦 |
  | `buildHubImage.test.js`、`deployHub.test.js`、`docker.test.js` | hub 映像的發行、部署、Dockerfile |
  | `upstream.test.js`、`upstreamTools.test.js` | 上游防護、升級工具、接縫清單的路徑都存在 |

- [ ] `cd tauri && npm run verify` 與 `npm --prefix tauri run test:compat` 全綠（第 4 節）：Rust 用戶端的上傳格式、limits 的 accountKey、session detail 和上游一致。
- [ ] 有可以建 schema 的 PostgreSQL 時，設 `TOKEN_MONITOR_TEST_DATABASE_URL` 再跑一次 `npm test`（[postgres.zh-TW.md](postgres.zh-TW.md)「測試」）。`org.test.js` 的「an admin classifies the addresses of unowned devices」在真的 PostgreSQL 上本來就會失敗；只要 main 上也失敗，就不算這次弄壞的。

### hub 冒煙（至少最後一版要做；動到 hub 接縫的每一版都要做）

在升級的 worktree 起一個丟棄式 hub：

```bash
npm run smoke:hub
```

- 跑的是這個 worktree 的 overlay 和新的 `upstream/`，資料庫是 PGlite（在 Node 裡跑的 PostgreSQL），停掉（Ctrl+C）資料就消失。不需要 Docker，也不碰本機的 compose 環境與正式資料庫。
- 已經灌好 5 位員工（公司 `SMOKE`，兩個 BU）、5 台裝置與 45 天的用量；dashboard 預設公開（`TOKEN_MONITOR_PUBLIC_DASHBOARD`，`--private` 關掉）。
- 金鑰是隨機的測試金鑰，連同其他電腦連得到的網址寫在 `tmp/smoke-hub.env`（不進版控），之後用戶端冒煙會用到。
- 預設聽所有網路介面（port 17399），讓測試電腦或 VM 連得到；Windows 第一次可能跳出防火牆詢問。只在本機看就加 `-- --host 127.0.0.1`。
- 它照測試的方式起 hub（store → hub → overlay）。`hub/server.js` 自己的啟動流程由 `hubOverlayBootstrap.test.js` 與 `npm run build:image` 的映像冒煙測試檢查。

逐項看（網址與金鑰在 `npm run smoke:hub` 印出來的那幾行）：

- [ ] `GET /api/health` 回 200；`GET /api/custom/health` 用 admin 金鑰時 `hub.upstreamVersion` 是新版，用 client 金鑰是 403。
- [ ] `/` dashboard：區間切換、組織篩選、比較、帳號與裝置、AI 工具額度都有資料，中英文切換正常（[hub.zh-TW.md](hub.zh-TW.md#dashboard)「Dashboard」）。
- [ ] `/admin`：用 admin 金鑰登入；人事公告匯入預覽（用 `tests/helpers/xlsx.js` 的 `announcement()` 產生的合成名單，絕不用 `docs/dept/` 的真實名單）、API token 建立與撤銷（[hub.zh-TW.md](hub.zh-TW.md#管理員登入)「管理員登入」「每月匯入人事公告」「API token」）。
- [ ] `/install` 與 `/llms.txt` 打得開。
- [ ] 用剛建立的 API token 呼叫一個報表 API，例如 `GET /api/reports/v1/devices`（[reports-api.zh-TW.md](reports-api.zh-TW.md)）。
- [ ] 影響報告裡上游新增的路由，用 client 金鑰打：寫入（POST、PUT、DELETE）要被拒絕（403）；讀取（GET）client 金鑰讀得到，確認回傳的內容可以公開，或已經照第 5 節的決定擋掉。
- [ ] 新 hub 收得下舊用戶端：用戶端冒煙的「從舊版升級上來」那一項會用目前的正式版上傳到這個 hub。

### 用戶端冒煙（至少最後一版、發行用戶端之前一定要做）

用戶端一旦發行就**不能降版**（[client-build.zh-TW.md](client-build.zh-TW.md)「Tag 與版本」），所以這一節沒做完不打 `client-v*` tag。

`npm run smoke:hub` 開著，在 worktree 打一個不會發行的測試版 `<新版本>-corp.0`，連到這個冒煙 hub（不用正式的 `.env.ubuntu`，測試裝置才不會跑進正式 hub 的資料）：

```powershell
.\packaging\build-client.ps1 -Version 0.64.0-corp.0 -HubEnvFile tmp\smoke-hub.env
```

- 裝在測試電腦或 VM 上，不要裝在自己每天用的電腦，它會蓋掉正在用的 Token Monitor。
- 只想快速看入口的話，可以用本機解開的 Electron 跑入口，不安裝。
- 冒煙 hub 重開之後金鑰不變（存在 `tmp/smoke-hub.env`），但資料會清空；測試版要等下一次上傳才會再出現。

照 [client-build.zh-TW.md](client-build.zh-TW.md)「驗證」逐項檢查，至少：

- [ ] 第一次開啟就連上冒煙 hub：`settings.json` 的 `hubMode` 是 `client`，金鑰在 `credentials.json`。
- [ ] 開機時啟動已開啟；開機自動啟動時 widget 縮到工作列；「保持在工作列上方」已勾；系統匣只顯示 logo。
- [ ] 有放自己的圖示與 logo 時（[client/README.md](../client/README.md)），視窗左上角、系統匣、安裝檔都是它們。
- [ ] widget 只顯示這台電腦（LIMITS 只有這台登入的帳號，裝置列表只有一台）。
- [ ] 裝置列表顯示主機名稱，不是 UUID。
- [ ] ⚙ →「一般」→「應用程式更新」寫「GitLab releases」，**每一個語系都是**（上游新增的語系也要），點了開 GitLab 的 Releases。
- [ ] 「檢查更新」執行時不出錯。測試版 `<新版本>-corp.0` 比 GitLab 上所有 Release 都新，所以**不提示新版是正常的**；真正的更新測試在發行之後做（第 8 節）。
- [ ] 30 分鐘內冒煙 hub 的 dashboard 看得到這台電腦的上傳。
- [ ] 從舊版升級上來，設定不變：
  1. 在另一台乾淨的測試電腦先裝目前的正式版。
  2. 第一次開啟前先斷網（不然它會照預設連上正式 hub），開啟後在「多裝置同步」改連冒煙 hub（網址與 client 金鑰在 `tmp/smoke-hub.env`），再接回網路。看到它上傳到冒煙 hub，就同時驗證了新 hub 收得下舊用戶端。
  3. 再裝測試版，確認仍連著冒煙 hub、設定沒有被改掉。
  - 測試電腦不小心連上正式 hub 時，用 admin 金鑰刪掉這台測試裝置（`DELETE /api/devices/<裝置 ID>`，[hub.zh-TW.md](hub.zh-TW.md#overlay-為-hub-增加了什麼)「overlay 為 hub 增加了什麼」）。

## 7. 記錄、合併，再升下一版

1. `CHANGELOG.md`「未發行」加一行「上游升到 vX.Y.Z」，加上使用者看得到的變化（上游的新功能、本 repo 的處理），以及第 5 節的決定；`tauri/` 有改就寫進 `tauri/CHANGELOG.md`。改了設定、路由、部署方式就同時改 `docs/`（AGENTS.md「慣例」）。
2. commit 照 AGENTS.md：英文 conventional commits，不加 AI 的 `Co-Authored-By`。行為改變的文件跟程式放在同一個 commit；只有「上游升到 vX.Y.Z」那一行可以單獨 commit（`docs(changelog): …`），因為上游的 merge commit 是工具做的。
3. 合進 main，在 checkout 著 main 的目錄執行：

   ```bash
   git -C ../open-token-monitor merge --ff-only upstream/v0.64.0
   ```

   用 PR 合的話，PR 說明貼上影響報告、勾掉處理過的項目，合併時用 merge commit 或 fast-forward，**不要用 squash 或 rebase 合併**：兩者都會攤平上游的 merge commit。

   失敗代表 main 在升級期間動過。**升級分支不要 `git rebase`**：一般的 rebase 會攤平上游的 merge commit，把 squash commit 的內容套到 repo 根目錄。改成從新的 main 重來：
   1. 開一個新分支。
   2. 再跑一次 `npm run upstream:update -- <同一版>`。
   3. 把修接縫的 commit `git cherry-pick` 過去。
   4. 重跑 `npm run verify`、`tauri/` 的驗證，以及回歸清單裡和 main 新改動有關的項目。

   推 origin 是另一步，先確認。
4. 還有下一版：回到第 0 步，從新的 main 開下一個 worktree。上一版的 worktree 用 `git worktree remove` 收掉。

## 8. 發行

升完要發行時，照 AGENTS.md「發行與 tag」與 [hub.zh-TW.md](hub.zh-TW.md)「發行：兩種 tag」：

- **hub 和用戶端都要發，而且是同一個上游版本。** 版本號的 N 從 1 重新算，例如 `corp/v0.64.0-corp.1`、`client-v0.64.0-corp.1`。
- **一版一版升，不一定要一版一版發。** 連升好幾版時，可以在最後一版一起發；中間的版本只要合進 main。
- **先 hub，後用戶端，分兩次發**：
  1. hub：`npm run build:image -- --dry-run` 看過版本與文件，再 `npm run build:image`、`git push origin HEAD`；pipeline 跑完後手動執行 `deploy:hub`。部署後確認正式 hub 上舊版用戶端照樣上傳：dashboard 上各裝置的資料時間持續更新。
  2. 用戶端：確認那個 commit 通過 `npm run verify`，再 `git tag client-v<版本>` 並推到 origin。用戶端不能降版，打 tag 前確認第 6 節的「用戶端冒煙」全部打勾。
- **Rust 用戶端**：`tauri/` 有改、要發新版時，照 [tauri/docs/release.md](../tauri/docs/release.md)。
- **發行後的更新測試**：用戶端冒煙那台裝了 `<新版本>-corp.0` 的測試電腦，按「檢查更新」應該提示 `<新版本>-corp.1`，下載安裝後仍連著原本的 hub。`corp.0` 比 `corp.1` 舊，所以這一步驗證的是正式的自動更新路徑。
- **出問題時：**
  - hub：部署上一個 `corp/v*`（[hub.zh-TW.md](hub.zh-TW.md#從-gitlab-部署)「從 GitLab 部署」）。
  - 用戶端：修好發下一號。
  - 推出去的 tag 不刪、不移。

## 卡住或要放棄

- 還沒合進 main：刪掉 worktree 和分支就好，main 沒動。先停掉 `npm run smoke:hub`，關掉開在那個資料夾裡的終端機與編輯器（Windows 刪不掉正在使用的資料夾），再在 main 的目錄執行：

  ```bash
  git worktree remove ../open-token-monitor-upstream-v0.64.0
  git branch -D upstream/v0.64.0
  ```

  `worktree remove` 說 Permission denied 時，git 已經不再登記它，只是資料夾還在：把佔用它的程式關掉後直接刪資料夾，分支照樣要 `git branch -D`。

- 做不到的（例如上游重寫了 overlay 依賴的整個區塊）：停下來，把卡住的地方寫在 PR 裡，不要為了讓測試通過而刪測試、放寬檢查或修改 `upstream/`。
- 已經合進 main、還沒發行：不要 revert 上游的 merge commit。在 main 上繼續修，或請負責的人決定。
- 已經發行：修好發下一號。

## 附錄：v0.63.1 → v0.67.0 預先評估（2026-10-07）

> 這次升級做完後刪掉這一節。這份評估只看了 hub overlay 與 Electron 用戶端；`tauri/` 照第 4 節，每一版看影響報告的 tauri/ 項目與 `test:compat`。

- **v0.64.0、v0.65.0、v0.66.0**：預估接縫都不受影響，verify 應該直接通過，只有用戶端版本號要跟著上游版本走。
- **v0.66.0**：上游把 `tar` 從 dependencies 拿掉，目前還在 lockfile 裡（hoisted 的 devDependency），用戶端跨平台打包仍然找得到。這一點很脆弱，打包時留意。
- **v0.67.0**（上游 #940「optional sync content」）要做這些事：
  - `hub/core.js` 的 `getStats`、`ingest`、`deleteDevice` 跟上游同步（`getStats` 多了 `syncSettingsRevisions`；`deleteDevice` 會留下標題政策的 tombstone），再更新指紋。
  - `hub/server.js` 的 bootstrap 多了 `syncSessionTitles` 那一行，`createHub({…, syncSessionTitles})` 也變了；這一行需要上游的 `src/shared/syncContent`。
  - `client/electron/ownDeviceView.js`：`/api/stats` 的新欄位要分類。
  - `UPSTREAM_PATCHES` 要涵蓋第 6 個語系：上游新增的 pt-BR 寫的是「Versões no GitHub」。i18n 那一筆找的 `'GitHub releases'` 剛好還是 5 次，測試不會失敗，但 pt-BR 的使用者會看到 GitHub；要加一筆 patch 改 pt-BR 那一行。影響報告的 `settings.appUpdate.source` 次數變化（6 → 7）會提醒這件事。
  - **要決定**：上游新增 `GET /api/sync/content`、`GET`／`PUT /api/sync/settings/(modelAliases|customPricing)`、`PUT /api/sync/titles/:deviceId` 和設定 `TOKEN_MONITOR_SYNC_SESSION_TITLES`（預設關閉）。
    - 兩個 GET 不用改程式就是 client 金鑰讀得到（v0.67.0 的用戶端會呼叫）；資料庫模式下回的是上游自己那份，通常是空的。
    - PUT 只有 admin 能用，但會穿透到上游，寫進的東西不會進 PostgreSQL，重開 hub 就消失。
    - 建議四條都先擋掉（404，上游用戶端會當成 hub 不支援），需要時再在 overlay 實作。`TOKEN_MONITOR_SYNC_SESSION_TITLES` 維持關閉，因為 `core.ingest` 一律去掉標題。
