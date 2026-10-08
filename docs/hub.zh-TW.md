# 公司版 Token Monitor

Token Monitor 公司版的 monorepo：hub（伺服器端）的所有客製都在這裡，包括資料庫、金鑰分級、組織與裝置歸屬、dashboard、報表、映像打包與文件。上游程式（[Javis603/token-monitor](https://github.com/Javis603/token-monitor)）以 git subtree 放在 [upstream/](../upstream/)，鎖在上游的一個 release tag，原封不動：

```
open-token-monitor\
  upstream\     上游，git subtree（--squash），不在這裡改
  hub\          hub 的客製
  docker\       映像與 compose
  scripts\      上游防護、上游更新、映像發行
  client\  packaging\   公司版用戶端的入口與打包
  tauri\        Rust/Tauri 用戶端（自己的 package.json，見 tauri\README.md）
  docs\  tests\
```

用戶端有兩種裝法：公司版安裝檔（開機自動啟動、每 30 分鐘上傳、預填 hub 網址與 client 金鑰，安裝見下方「安裝用戶端」，打包與發行見 [client-build.zh-TW.md](client-build.zh-TW.md)），或上游的官方版本再手動輸入（[client-setup.zh-TW.md](client-setup.zh-TW.md)）。

本 repo 的程式透過 [upstream.js](../upstream.js) 使用上游的模組。`upstream/` 被改過時 `npm run verify` 會失敗，所以同步上游不會有衝突要解。已知缺陷見 [缺陷盤點](defects.zh-TW.md)。

## 這裡有什麼

| 路徑 | 說明 |
|---|---|
| `upstream/` | 上游 token-monitor，git subtree（--squash），鎖在一個上游 release tag。不在這裡改，見「同步上游」。 |
| `upstream.js` | 唯一知道上游在哪裡的模組（`upstream/`）。讀上游程式一律 `require(upstream('src/…'))`。hub 映像保留同樣的佈局。 |
| `hub/server.js` | overlay 入口，取代上游的 `npm run hub`。旗標與環境變數和上游完全相同，另外讀取下方「設定」表列出的 overlay 專用變數。 |
| `hub/overlay.js` | 疊在上游 hub 前面的路由層，把下列模組組起來。 |
| `hub/access.js` | 三把金鑰的權限分級。 |
| `hub/ingestGuard.js` | 上傳內容驗證，擋掉原型污染與畸形資料。 |
| `hub/ingest.js` | 上傳的處理：驗證、同一台裝置的合併、寫入佇列與稽核。 |
| `hub/stream.js` | `/api/stats` 與串流：時間窗快取與 gzip。 |
| `hub/core.js` | 有資料庫時，由 overlay 持有的裝置狀態。 |
| `hub/persistence/` | PostgreSQL 持久化：capture、store、driver、寫入佇列與 SQL migration。說明見 [postgres.zh-TW.md](postgres.zh-TW.md)。 |
| `hub/reports.js`、`admin.js` | 報表 API 與組織管理 API。說明見 [reports-api.zh-TW.md](reports-api.zh-TW.md)。 |
| `hub/analytics.js` | 報表 API 裡 scope `analytics:read` 的端點：組織樹、員工清單、AI 帳號的額度視窗與用量分析。用量分析由 `usage.js` 算，這裡逐欄組成 v1 的固定格式，dashboard 的格式變了也不影響串接方。 |
| `hub/apiDocs.js`、`openapi.js`、`llms.txt`、`llms-full.txt` | 報表 API 的英文說明：`/llms.txt`、`/llms-full.txt` 與 OpenAPI 3.1（`/api/reports/v1/openapi.json`），不需要金鑰，網址填入對方連到 hub 用的網址。三份文件與 [reports-api.zh-TW.md](reports-api.zh-TW.md) 要一起改，`tests/apiDocs.test.js` 會檢查每個端點、scope 與錯誤代碼都寫到了，`tests/analytics.test.js` 檢查回應的每個欄位都在 OpenAPI 裡。 |
| `hub/org.js`、`xlsx.js`、`units.js` | 匯入各公司的人事公告 xlsx，建立「公司 → BU → 部門 → 團隊」，自動替裝置指定員工，並提供 dashboard 的組織篩選。`units.js` 是各模組共用的組織樹（層級、往上找某一層的單位）。見下方「組織與裝置歸屬」。 |
| `hub/router.js` | 把一層處理器插在既有 request listener 前面的共用工具。 |
| `hub/usage.js`、`periods.js` | dashboard 的用量資料（`/api/custom/usage`）：區間切成日、ISO 週或月，範圍內某一層單位的比較、「其他」、這一期有用量的人與裝置、每個人（只給管理員）與趨勢。`periods.js` 是日、週、月的算法，報表也用它。見下方「Dashboard」。 |
| `hub/install.html` | 安裝說明頁 `/install`：Windows、macOS、Linux 三個分頁，打開時選好訪客的系統，下載按鈕連到各平台最新一版。Windows 與 macOS 的每一步旁邊畫著那一步的視窗（Windows：檔案總管、SmartScreen、安裝程式；macOS：dmg、Finder、「未打開」對話框、系統設定、「要打開嗎？」對話框），要按的地方用橘色框圈起來；圖是 HTML 畫的，不是截圖。整頁有繁體中文與英文，英文版畫的是英文版 Windows 與 macOS 的視窗（見「安裝用戶端」）。和 dashboard 一樣公開、不含任何 secret 或資料。 |
| `hub/dashboard.html` | dashboard 頁面，hub 的主頁面：在 `/` 是用量，在 `/admin` 是管理頁。任何連得到 hub 的人都拿得到，所以**絕不能寫入 secret**。管理員輸入一次金鑰換成 session cookie，瀏覽器不保存金鑰。整頁有繁體中文與英文（見「Dashboard」的「語言」）。 |
| `hub/purge.js` | 刪除歷史資料：所有裝置在某個月以前的用量，先備份，並記下下限，之後補傳的舊資料不再寫入。 |
| `hub/backups.js` | hub 內建的資料庫備份：每天與管理員要求時以 `pg_dump` 備份 schema，輪替每日備份，提供下載與刪除。見 [postgres.zh-TW.md](postgres.zh-TW.md)「備份與還原」。 |
| `hub/sessions.js` | 管理員的登入 session：`/api/auth/login` 驗證 admin 金鑰後發 HttpOnly cookie，資料庫只存 token 的 SHA-256。見下方「管理員登入」。 |
| `scripts/loadgen.js` | 壓測工具。 |
| `docker/` | 在容器裡跑 hub 的 `Dockerfile`，以及含 PostgreSQL 的 `compose.yml` 與 PostgreSQL 的首次啟動腳本（`postgres/initdb/`）。說明見 [docker.md](docker.md)。 |
| `scripts/check-upstream.js`、`update-upstream.js`、`upstream-status.js`、`upstream-impact.js`、`upstream-remote.js`、`smoke-hub.js`、`upstream-touchpoints.json` | 上游防護（`npm run check:upstream`，包含在 verify 裡）、上游升級（`npm run upstream:status`、`upstream:update -- <next|latest|tag>`、`upstream:impact`）、接縫清單，以及升級驗證用的丟棄式 hub（`npm run smoke:hub`）。見「同步上游」與 [upstream-upgrade.zh-TW.md](upstream-upgrade.zh-TW.md)。 |
| `client/`、`packaging/` | 公司版用戶端：第一次開啟時寫入 hub 設定並開啟開機啟動、「保持在工作列上方」與只顯示 logo 的系統匣圖示，開機自動啟動時把 widget 縮到工作列，widget 只顯示這台電腦的用量（`ownDeviceView.js`），再執行上游的主程式；可以把圖示與視窗左上角換成自己的 logo（[client/README.md](../client/README.md)）；裝置列表顯示主機名稱；`npm run build:client` 打包成安裝檔（Windows、Linux 不簽章，macOS 只有 ad-hoc 簽章）。見 [client-build.zh-TW.md](client-build.zh-TW.md)。 |
| `.gitlab-ci.yml` | GitLab CI：verify、公司版用戶端的打包與 Release。 |
| `scripts/build-hub-image.js` | hub 映像的發行（`npm run build:image`）：打包時寫好這一版的文件，建映像、冒煙測試、打 tag。見 [packaging.zh-TW.md](packaging.zh-TW.md)。 |
| `package.json` | 本 repo 的相依。執行期是 `dotenv`（上游 hub 唯一載入的套件，版本同上游的 lockfile）與資料庫 driver；開發用的是 `eslint` 與上游 ESLint 設定用到的 plugin，版本同上游。`upstream/` 裡不安裝相依。 |
| `start-hub.ps1` | Windows 啟動器（啟動前檢查、背景模式、`-Stop`、`-Status`）。 |
| `deploy/` | 部署腳本：產生 release 資料夾、部署到本機 Docker Desktop 或 Ubuntu。見下方「部署」。 |
| `deploy-ubuntu.cmd` | 一鍵部署到 Ubuntu：雙擊後只要輸入 SSH 帳號與密碼。見下方「部署」。 |
| `docs/` | overlay 文件。 |
| `tests/` | overlay 的測試（`npm test`）。 |

## 安裝用戶端

公司版安裝檔放在本 repo 所在 GitLab 專案的 Releases 頁（`<專案網址>/-/releases`，例如 `https://gitlab.example.com/<group>/<project>/-/releases`），dashboard 標題列的「下載 Token Monitor」也連到這裡。給同事的安裝說明在 hub 的 **`/install`**（例如 `http://<hub>/install`，dashboard 標題列的「安裝說明」）：Windows、macOS 與 Linux（Ubuntu 等）各一個分頁，打開時自動選好訪客的系統，`#windows`、`#macos`、`#linux` 可以直接連到某一個。頁面有繁體中文與英文：瀏覽器是中文時顯示中文，其他語言顯示英文，右上角的「English」／「中文」可以切換，選過的會記在瀏覽器裡；`?lang=en` 或 `?lang=zh-TW` 直接指定，例如 `/install?lang=en#macos`。下載按鈕連到各平台最新一版（從 `TOKEN_MONITOR_CLIENT_DOWNLOAD_URL` 推出來，它是 GitLab 的 Releases 頁時）。Windows 與 macOS 分頁是圖解教學，每一步旁邊畫著那個視窗。Windows：從檔案總管打開安裝檔（從瀏覽器直接打開可能被公司的防毒軟體擋下）、SmartScreen 的「其他資訊」→「仍要執行」、「安裝」與「完成」。macOS：把 app 拖進「應用程式」、從「應用程式」打開、被擋下時按「完成」（不是「丟到垃圾桶」）、到「系統設定」→「隱私權與安全性」按「強制打開」，跳出「要打開『Token Monitor』嗎？」時再按一次「強制打開」（不是藍色的「丟到垃圾桶」）。每一版的 Release 頁用中文與英文列出下載的檔案，安裝步驟連到 hub 的 `/install`（`packaging/client-release-notes.md`）。最新一版也有固定網址：

| 電腦 | 檔案 | 最新一版 |
|---|---|---|
| Windows 10 / 11 | `Token-Monitor_<版本>_x64-setup.exe` | `<專案網址>/-/releases/permalink/latest/downloads/windows` |
| Mac，Apple 晶片（M1、M2、M3、M4…） | `Token-Monitor_<版本>_aarch64.dmg` | `<專案網址>/-/releases/permalink/latest/downloads/macos` |
| Linux x64（例如 Ubuntu） | `Token-Monitor_<版本>_amd64.AppImage` | `<專案網址>/-/releases/permalink/latest/downloads/linux` |

Intel 晶片的 Mac 目前不支援。裝好打開後 app 會自己連上公司的 hub，不用輸入任何設定，之後開機也會自動啟動。

公司版安裝檔沒有正式的程式碼簽章，第一次打開時系統會擋下：

- **Windows**：出現「Windows 已保護您的電腦」時，按「其他資訊」→「仍要執行」。
- **Linux**：`chmod +x` 之後執行 AppImage；說缺少 `libfuse.so.2` 時安裝 `libfuse2`（Ubuntu 24.04 是 `libfuse2t64`）。
- **macOS**：app 只有 ad-hoc 簽章，沒有經過 Apple 公證。照下面做一次就好：
  1. 打開 dmg，把 **Token Monitor** 拖進「應用程式」，從「應用程式」打開。
  2. 出現「未打開『Token Monitor』」（“Token Monitor” Not Opened）時按「**完成**」（Done），**不要**按「丟到垃圾桶」（Move to Trash）。
  3. 到「系統設定」→「隱私權與安全性」（Privacy & Security），往下捲到最底的「安全性」，在「已阻擋『Token Monitor』以保護你的 Mac。」那一列按「**強制打開**」（Open Anyway）。這個按鈕只在剛被擋下後約一小時內出現，找不到就再打開一次 app、按「完成」再回來。
  4. 會再跳出一個視窗，再按一次「強制打開」，輸入這台 Mac 的登入密碼（不是 Apple 帳號的密碼，也可以用 Touch ID）。之後就能直接打開。

  也可以在終端機一步完成，跳過步驟 2～4（拖進「應用程式」之後執行）：

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"
  ```

  說 app「已損毀，無法打開，應丟到垃圾桶」時，app 本身沒有壞，是下載時加上的隔離標示擋住的（ad-hoc 簽章之前打包的 dmg 會這樣）：執行 `xattr -cr "/Applications/Token Monitor.app"`，再打開一次。

更新：Windows、Mac 與 Linux 的 app 會自己檢查 GitLab 上最新的 Release，有新版時提示，按了才下載安裝。Mac 的 app 要放在「應用程式」裡；沒有 Apple 憑證怎麼更新、以後換成正式簽章要改什麼，見 [client-build.zh-TW.md](client-build.zh-TW.md)「3. 註冊 Mac runner」第 5 步與「自動更新」。

## 啟動 hub

第一次：

```bash
git clone <本 repo 的網址> open-token-monitor
cd open-token-monitor && npm ci
```

之後：

```bash
npm run hub                               # = node hub/server.js，取代上游的 `npm run hub`
npm run hub -- --port 17322               # --host、--secret、--staleAfterMs、--dataFile 與上游相同
.\start-hub.ps1                           # Windows；可加 -Background、-Stop、-Status
```

設定優先順序沿用上游：CLI 旗標 → 環境變數（真實環境或 `.env`）→ 內建預設值。`.env` 放在本 repo 的根目錄，`npm run hub` 與 `docker compose --env-file .env` 用的是同一份。資料預設寫在本 repo 的 `data/`。Docker 見 [docker.md](docker.md)。

## 設定

上游原有的 `TOKEN_MONITOR_SECRET`、`TOKEN_MONITOR_PORT`、`TOKEN_MONITOR_HOST`、`TOKEN_MONITOR_DATA_FILE`、`TOKEN_MONITOR_STALE_AFTER_MS` 照舊；開發時 `TOKEN_MONITOR_DATA_FILE` 的預設值是本 repo 的 `data/devices.json`。overlay 另外讀取：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `TOKEN_MONITOR_CLIENT_SECRETS` | — | client 金鑰，逗號分隔，可以列多把以便輪替。發給使用者在上游用戶端手動輸入。設了這個就必須同時設 `TOKEN_MONITOR_SECRET`。 |
| `TOKEN_MONITOR_TRUST_PROXY` | 關 | 放在反向代理後面時設為 `1`，稽核改記 `X-Forwarded-For` 的最後一個值。 |
| `TOKEN_MONITOR_PUBLIC_DASHBOARD` | 關 | 設為 `1` 時，dashboard 不用金鑰就能看統計與用量分析：不帶金鑰的 `GET /api/stats`、`/api/custom/org` 與 `/api/custom/usage` 回 200（用量分析只在使用人數與活躍裝置的明細列出姓名與主機名稱，不含 email 與員工編號），其他路由照舊要金鑰。管理員區塊與個人用量仍要按「管理員」登入。 |
| `TOKEN_MONITOR_CLIENT_DOWNLOAD_URL` | — | dashboard 標題列「下載 Token Monitor」按鈕的連結，通常設成公司版用戶端的 GitLab Releases 頁（例如 `https://gitlab.example.com/<group>/<project>/-/releases`，`.env.example` 有範例）。沒有設定，或不是 `http://`、`https://` 開頭的完整網址時不顯示按鈕（後者開機時會警告）。改了要重新啟動 hub。 |
| `TOKEN_MONITOR_DATABASE_URL` | — | PostgreSQL，`postgres://token_monitor:密碼@host:5432/token_monitor`。密碼含特殊字元時要做 URL 編碼；要加密時加 `?sslmode=require`。沒有設定時只用上游的 JSON 檔。見 [postgres.zh-TW.md](postgres.zh-TW.md)。 |
| `TOKEN_MONITOR_DATABASE_SCHEMA` | `token_monitor` | hub 的 schema。 |
| `TOKEN_MONITOR_DATABASE_POOL_SIZE` | `4` | |
| `TOKEN_MONITOR_STORE_REQUIRED` | `1` | 開機時連不上資料庫就結束。設為 `0` 則改用 JSON 檔降級執行。 |
| `TOKEN_MONITOR_SESSION_RETENTION_MONTHS` | `24` | session 明細的保留月數。 |
| `TOKEN_MONITOR_AUDIT_RETENTION_DAYS` | `90` | `ingest_events` 的保留天數。 |
| `TOKEN_MONITOR_BACKUP_DIR` | `data/backups`；映像裡 `/backups` | hub 內建的資料庫備份（`pg_dump`）放在哪裡。見 [postgres.zh-TW.md](postgres.zh-TW.md)「備份與還原」。 |
| `TOKEN_MONITOR_BACKUP_KEEP` | `14` | 保留幾份每日備份；`0` 是不做每日備份。手動與刪除歷史資料前的備份不會自動刪除。 |
| `TOKEN_MONITOR_BACKUP_HOUR` | `19` | 每日備份在 UTC 的幾點之後做，19 是台北 03:00。 |
| `TOKEN_MONITOR_PG_DUMP` | `pg_dump` | `pg_dump` 的路徑，給 PATH 裡沒有它的開發機用；映像裡已經有。 |
| `TOKEN_MONITOR_STREAM_WINDOW_MS` | `60000` | 串流與 `/api/stats` 快取的時間窗。 |
| `TOKEN_MONITOR_INGEST_MIN_INTERVAL_MS` | `60000` | 同一台裝置兩次套用之間的最短間隔，更頻繁的上傳會被合併。 |

## overlay 為 hub 增加了什麼

| 路由 | 金鑰 | 說明 |
|---|---|---|
| `GET /`、`/dashboard`、`/index.html` | 不需要 | dashboard。頁面本身不含 secret 與用量資料。 |
| `GET /admin` | 不需要 | dashboard 的管理頁：同一個 `hub/dashboard.html`，只顯示「管理」。頁面本身不含 secret 與資料，內容來自 `/api/admin/*` 等路由，要管理員登入才讀得到。 |
| `GET /llms.txt`、`/llms-full.txt`、`/api/reports/v1/openapi.json` | 不需要 | 報表 API 的英文說明（`hub/apiDocs.js`），給串接的人與 AI agent。純文件，不含資料與 secret；文件裡的網址是請求的 `Host`（`TOKEN_MONITOR_TRUST_PROXY` 時用 `X-Forwarded-Proto` 與 `X-Forwarded-Host`），不是單純的主機名稱或位址時改成 `http://<hub>`。 |
| `GET /install` | 不需要 | 安裝說明頁（`hub/install.html`）。`TM_SETTINGS.downloads` 是各平台最新一版的固定網址，`TOKEN_MONITOR_CLIENT_DOWNLOAD_URL` 不是 GitLab 的 Releases 頁時為 `null`，頁面改連那個網址本身。 |
| `GET /usage` | 不需要 | 302 到 dashboard（舊的用量分析頁已經併進 dashboard），查詢字串照帶。 |
| `/api/health` | 不需要 | 與上游格式相同，回報上游註冊的 `node-hub` build id。 |
| `POST /api/ingest` | client、admin | 驗證 → 合併 → 寫入資料庫。回應格式與上游相同。 |
| `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me` | 不需要 | 管理員登入、登出，以及目前的身分（`role`：`admin`、`client`、`viewer` 或 `null`）。見下方「管理員登入」。 |
| `GET /api/stats`、`/api/stats/stream` | client、admin | 時間窗快取；接受 gzip 的連線收到壓縮版。開啟 `TOKEN_MONITOR_PUBLIC_DASHBOARD` 後，`GET /api/stats` 不帶金鑰也可以，但只限同一個網站（跨站的 `Sec-Fetch-Site` 回 401），回應也不帶 CORS 標頭，並拿掉 AI 帳號的代號與用戶端回報的公司信箱（`ownerEmail`）；AI 帳號的 email 與名稱照樣給。 |
| `GET /api/devices`、`/api/history`、`/api/subscriptions` | client、admin | 與上游相同。 |
| `DELETE /api/devices/:id`、`PUT /api/subscriptions` | admin | 先寫資料庫，失敗回 503。 |
| `GET /api/custom/health` | admin | 佇列、串流、ingest 延遲、event loop、API token 數、hub 所用的上游版本，以及架構的升級門檻（見 [postgres.zh-TW.md](postgres.zh-TW.md)「監控」）。 |
| `GET /api/custom/org` | client、admin；開啟 `TOKEN_MONITOR_PUBLIC_DASHBOARD` 時不需要 | 組織樹：單位 ID、名稱、層級與裝置數量，不含任何人名或 email。 |
| `GET /api/custom/usage?org=&from=&to=&granularity=&level=&focus=&employee=&other=&compare=&cfrom=&cto=&client=&unowned=` | 同上 | dashboard 的用量資料：一個單位（不帶 `org` 是全部公司）在區間內，依 `granularity`（`day`、`week`、`month`）切成一段段，每段的合計、`level` 那一層每個單位的用量、「其他」與模型、工具。`other=<層級>` 只算這個單位裡不在任何一個該層單位的用量（單位比較的「其他」），沒有更細的單位可以比、沒有名單人數，`level` 不看，回應的 `otherLevel` 是這個層級；層級不在單位底下時 400 `bad_other`。`unowned=1` 只算當天沒有算給任何員工的用量（員工用量的「沒有對應到員工」），可以和 `org`、`other` 一起用；同樣沒有更細的單位、沒有名單人數，`level` 不看，回應的 `unowned` 是 `true`，給 admin 金鑰的 `devices` 附每台裝置的 `trend`（和單一員工的檢視一樣）；值不是 1 時 400 `bad_unowned`，單一員工的檢視不理會它。`focus=last`（預設）看最後一段，`focus=range` 看整個區間。`previous` 是比較期間：`last` 和前一期的同一段比（還沒過完的一期比前一期同樣的天數，日是和上週同一天比），`range` 和緊接在前、一樣長的天數比。`compare=year` 改和去年同期比：日與週往前 52 週（星期幾對齊，例如 2026-09-28 那一週對 2025-09-29 那一週），月與整個區間用去年的同一個日期（2/29 對 2/28）；`compare=custom&cfrom=&cto=` 和自訂的一段比，最多 400 天、不能晚於今天、不能和這一期重疊，否則 400 `bad_compare`。`previous.mode` 是 `previous`、`year` 或 `custom`。`earliest` 是整個 hub 最早有每日用量的那天（`daily`）與最早有每月合計的月份（`monthly`）。`granularity=month` 時，一台裝置在範圍或比較期間裡完整的一個月沒有任何每日資料，就改用那個月的每月合計（和報表的月報一樣，歸屬以月初為準，不算有用量的天數），`monthlyFallback` 列出用到的月份。`client=<工具>`（例如 `claude`、`codex`，1–64 個可見字元，否則 400 `bad_client`）只算那個工具：每日的列改讀依工具的表，所以合計、單位、「其他」、人、帳號、趨勢與活躍名單都只是那個工具的用量；模型的用量沒有記錄是哪個工具，所以 `models` 是空的。回應的 `client` 是篩選的工具（沒有時 `null`），`tools` 一律列出所有工具這一期的用量與比較期間的數字，給選單用。沒有 `client=` 也不是單一員工時，每個單位與「其他」多了 `clients`：各工具這一期與比較期間的用量（只有工具代號與數字，每個人都拿得到），給管理員的 `users` 也有同樣的 `clients`。區間最多 400 天，比較期間也是。每個單位、「其他」、模型與工具都附這一期與比較期間的數字；只在比較期間或區間其他時候用過的模型、工具放在 `idle`。`composition` 是這一期 token 的組成（只算有組成資料的用量）。`employee=` 是單一員工的用量，只給 admin 金鑰，其他人一律 403 `names_admin_only`（不論員工存不存在）；不存在的員工 404。`active` 是這一期有用量的員工與裝置（姓名、主機名稱、裝置 ID、單位與用量，裝置附當時的使用者），每個人都拿得到，其中的員工編號只給 admin 金鑰。`accounts`（帳號排行）也是每個人都拿得到，有 AI 帳號的 email、主機名稱與裝置 ID，但沒有員工與員工編號。其餘的人名、email、員工編號、主機名稱與裝置 ID（`users`、`devices`、`employee`）只給 admin 金鑰。員工姓名一律不含中文名。`accounts` 是每個 AI 帳號（email，沒有時用帳號名稱）在這一期與比較期間的用量、工具與裝置：一台裝置上一個工具的用量，算給這台裝置最後回報的、同一家供應商的帳號；同一家有兩個以上帳號時合成一條 `shared`，沒有帳號的算 `other`；`byProvider` 是一個帳號在各家（`provider`）這一期與比較期間的用量，`other` 沒有；單一員工的檢視沒有 `accounts`。同時計算的請求太多時，不帶 admin 金鑰的請求收到 503 `usage_busy` 與 `Retry-After`。每一個查詢最多 15 秒，超過時回 503 `usage_slow`（[postgres.zh-TW.md](postgres.zh-TW.md)「用量查詢的時間上限」）。見下方「Dashboard」。 |
| `GET /api/stats?org=<單位 ID>` | 同 `/api/stats` | 只算這個單位與其下所有單位的裝置；不存在的單位回 404。 |
| `/api/admin/*` | admin | 單位（`/api/admin/units`）、員工與裝置歸屬。`GET /api/admin/employees` 有資料庫時每人多附單位路徑、異動生效日、目前的裝置數與最近 30 天的用量。 |
| `POST /api/admin/org/import/preview?company=ACME&fileName=` | admin | body 是一家公司的人事公告 xlsx，只回傳匯入會造成的差異，不寫入。見下方「每月匯入人事公告」。 |
| `POST /api/admin/org/import?company=ACME&fileName=` | admin | 匯入，視為該公司的最新名單。可加 `effectiveFrom`、`confirm=1`、`dropSupersededRules=1`、`keepOldEmails=1`。有警告又沒有 `confirm=1` 時回 409 `needs_confirm`，附上預覽。 |
| `POST /api/admin/org/reconcile` | admin | 立刻重新指定裝置的員工；平常每 5 分鐘、匯入後、用戶端回報新 email 後與 email 規則改變後會自動執行。 |
| `/api/admin/emails…` | admin | 手動歸類 email，見下方「手動歸類 email」。 |
| `GET /api/admin/org/imports[?company=ACME]` | admin | 每家公司最後一次匯入的時間、在職人數、檔案、生效日與變動筆數，超過 35 天沒匯入的標 `overdue`；帶 `company` 時再附那家公司最近 24 次的匯入紀錄（`org_imports`）。 |
| `GET /api/admin/org/units` | admin | 每個單位（含已停用）的路徑、在職人數（含下層與直屬）、裝置數與最近 30 天的用量。 |
| `GET /api/admin/org/issues` | admin | 需要管理員處理的項目：多位員工 email 的裝置、離職員工還在回報的裝置、有問題的 email 規則、手動指定的裝置。 |
| `POST /api/admin/owners/:deviceId/release` | admin | 把手動指定的裝置改回依 email 自動歸屬。 |
| `GET`／`POST /api/admin/api-tokens`、`DELETE /api/admin/api-tokens/:id` | admin | API token：列出、建立（回應裡是唯一一次看得到 token 本身）、撤銷。見下方「API token」。 |
| `GET /api/admin/usage-purge`、`GET /api/admin/usage-purge/preview?month=`、`POST /api/admin/usage-purge` | admin | 刪除所有裝置在某個月以前的用量，先備份；之後補傳的舊資料不會再寫入。見 [postgres.zh-TW.md](postgres.zh-TW.md)「刪除歷史資料」。 |
| `GET`／`POST /api/admin/backups`、`GET`／`DELETE /api/admin/backups/:name` | admin | hub 內建的資料庫備份：狀態與清單、立即備份、下載、刪除。見 [postgres.zh-TW.md](postgres.zh-TW.md)「備份與還原」。 |
| `GET /api/reports/v1/*` | API token、admin | 報表。API token 要有端點的 scope：用量報表、裝置與帳號是 `reports:read`；`units`、`employees`、`limits`、`usage/analysis` 是 `analytics:read`。見下方「API token」。 |

### API token

其他系統（例如成本報表或 BI）用 **API token** 讀報表 API，一個系統一把，由管理員在 dashboard 的「API token」區塊建立與撤銷。

- 格式：`tmk_<8 碼>_<40 碼>`，16 進位。前 8 碼是 token 的代號，dashboard 用它來分辨各把 token。
- 只能讀 `GET /api/reports/v1/*`，其他路由一律回 403。建立時勾選 scope，一把可以有兩個：
  - `reports:read`（報表）：用量的月報、日報、週報，裝置與 AI 帳號。
  - `analytics:read`（分析）：組織樹、員工清單（英文名與 email）、AI 帳號的額度視窗與用量分析。
  - 沒有指定 scope 時只有 `reports:read`，所以 scope 出現之前建立的 token 讀不到分析的端點。沒有 scope 的端點回 403。
- 串接說明在 hub 的 `/llms.txt`、`/llms-full.txt` 與 `/api/reports/v1/openapi.json`（英文，不需要 token），中文見 [reports-api.zh-TW.md](reports-api.zh-TW.md)。
- hub 只存 token 的 SHA-256。token 本身只出現在建立它的那一次回應裡，之後誰都看不到；弄丟就撤銷，再建一把新的。
- 可以設到期日（`expiresAt`，`YYYY-MM-DD` 當天結束時失效，或 ISO 8601 時間）。撤銷與到期立刻生效。
- 每次使用會記下最後使用時間（每把 token 每分鐘最多記一次），dashboard 上看得到。
- 需要資料庫；API token 存在 `api_tokens` 表。

沒有任何金鑰時（上游的單機模式，hub 只綁 loopback），所有呼叫者都視為 admin。client 金鑰可以讀取所有 GET 路由，但只能寫入上傳；上游之後新增的寫入路由會先對 client 關閉。

### 管理員登入

dashboard 不在瀏覽器裡保存金鑰：

- 管理員在「管理員」輸入 `TOKEN_MONITOR_SECRET` 一次，頁面送到 `POST /api/auth/login`。hub 驗證後回一個隨機的 session token，放在 `tm_admin` cookie：`HttpOnly`（頁面上的程式讀不到）、`SameSite=Strict`、`Path=/`、12 小時後失效；hub 用 https（或 `TOKEN_MONITOR_TRUST_PROXY` 後面的 https）時加上 `Secure`。之後的請求都靠這個 cookie。
- 資料庫只存 token 的 SHA-256（`admin_sessions`），所以 hub 重新啟動或重新部署後仍然登入；沒有資料庫時 session 只在記憶體裡。更換 `TOKEN_MONITOR_SECRET` 後，所有舊的 session 立刻失效。
- 用 cookie 做的寫入（非 GET）必須帶 `X-TM-Request: 1`，而且不能是跨站請求（`Sec-Fetch-Site`），否則回 403；只有 cookie 絕對不夠。帶了錯的金鑰時，不論 cookie 為何都回 401。
- 同一個位址一分鐘內登入失敗 5 次後，要等到那一分鐘過了才能再試（429）。
- 「登出」刪掉 session 與 cookie。舊版頁面存在 `localStorage` 的 `tm.secret` 會在載入時刪掉。
- script、Bruno 與報表照舊用 `Authorization: Bearer <admin 金鑰>`，不受影響。`updated_by` 等紀錄裡，用 session 做的變更記成 `admin:session-<前 8 碼>`。

## 組織與裝置歸屬

管理員每月在 dashboard 的「匯入人事公告」區塊上傳各公司的人事公告（可以一次選多個），公司代碼取自檔名開頭，檔名裡的日期是這份名單的日期，例如 `ACME Announcement 20260801.xlsx` 是 `ACME`、2026-08-01。先看差異再匯入，見下方「每月匯入人事公告」。

- **只讀這幾欄**：Employee No.、English Name、Chinese Name、Email Address、BU、Department、Team。職等、晉升、Chat ID 等其他欄位與其他工作表都不會讀取或儲存。
- **單位**存在 `org_units` 表，是一棵四層的樹：公司 → BU → 部門 → 團隊，每個單位記著自己的層級（`level`）。ID 是名稱路徑：`ACME`、`ACME/Games`、`ACME/Games/Arcade`、`ACME/Games/Arcade/Pixel Team`。
  - 名稱不分大小寫合併。
  - 某一層是 `-` 或空白時跳過那一層：沒有 BU 的部門直接掛在公司下，ID 是 `ACME/-/<部門>`（`-` 佔住 BU 的位置，所以不會和同名的 BU 撞 ID）；沒有部門的人算 BU 直屬；團隊只算在部門底下。
  - Team 與部門同名或是「<部門> Department」時，算部門直屬；Department 與 BU 同名或是「<BU> BU」時，算 BU 直屬。
  - 比較某一層的單位時，不在任何一個該層單位裡的用量（例如比 BU 時，沒有 BU 的部門、公司直屬、只靠 email 網域歸到公司，以及完全沒有歸屬的裝置）一律算在「其他」。
- **每次匯入都是該公司的最新名單**：新檔裡沒有的員工與單位標成停用，不會刪除，歷史歸屬仍指向它們。同一個 email 換了員工編號（例如跨公司調動）時，舊編號會交出 email 並停用。
- **裝置歸屬依 email 決定，人事名單（Excel）優先**，寫成日期區間（`device_owners`）：
  1. 用戶端回報的公司信箱（上傳的 `ownerEmail`，存在 `device_claims`）在人事名單上。上游的官方用戶端不會送這個欄位，所以實際上主要靠 2。
  2. 裝置 limits 裡的 AI 帳號 email 在人事名單上，而且剛好對到一位在職員工。對到多位時是**衝突**：不指定，也不讓手動規則決定，列在「需處理」由管理員選這台裝置算誰的。
  3. 名單上找不到的 email，才看管理員的手動歸類（`email_assignments`，見下方「手動歸類 email」）：回報的信箱有規則時用它，否則 AI 帳號的規則指向同一個對象時用它。名單上有的 email 不能寫規則；之前寫的規則在那個 email 出現在名單上之後就不再使用（「已被名單取代」）。
  4. 都沒有時，裝置算「其他」。
  - 之前手動指定的裝置（`updated_by` 不是 `auto:` 開頭）不會被自動覆寫，在「需處理」列出，可以「改回自動」（`POST /api/admin/owners/:deviceId/release`：刪掉手動的那一段，前一段重新打開並標成 `auto:released`）。dashboard 已經沒有手動指定裝置的表單；`/api/admin/owners` 仍然留給 script 使用。
- **對不到員工、但 email 網域只屬於一家公司的裝置**（例如 `initech.example` 只出現在 INITECH 的名單），在 dashboard 的組織樹與篩選裡先算在那家公司，不分部門；歸屬表的來源顯示「email 網域」。網域取自匯入的名單，兩家公司共用的網域不算；回報的信箱優先，其次是 AI 帳號。這不寫入 `device_owners`，所以報表仍然算未歸屬。
- 自動指定的區間 `updated_by` 是 `auto:email-assigned`、`auto:reported`、`auto:ai-email` 或 `auto:released`。裝置第一次被指定時，從它最早有用量的那天起算（hub 第一次看到它的那天、最早的每日歷史，或最早的歷史月份的 1 號，取最早的），讓上傳的歷史也有歸屬；之後才上傳的更早歷史，會讓第一段自動區間往前延伸（重新對應結果的 `backdated`）。之後換人從當天起算；**同一位員工換單位**則從人事名單上異動的生效日起算（`employee_placements.effective_from`，見下方），但不早於目前這一段的開始、也不晚於今天。管理員寫的區間不會被移動。沒有新證據時維持原本的歸屬，所以離職員工的裝置仍算他的，直到新使用者的 email 出現在名單上。

### 每月匯入人事公告

每家公司每月上傳一次最新的人事公告。dashboard 先送到 `/api/admin/org/import/preview`，列出和目前資料的差異，管理員確認後才匯入：

| 差異 | 怎麼判斷 | 匯入後 |
|---|---|---|
| 新進 | 員工編號這家公司原本沒有在職（第一次出現、重新回到名單，或從別家公司以同一個編號調來） | 新增；他的 email 在未歸類的裝置上時，裝置自動歸給他。 |
| 離職 | 上次在名單上、這次沒有 | 停用，不刪除。裝置維持原本的歸屬，歷史不動；還在回報的列在「需處理」。 |
| 部門異動 | 同一個員工編號、單位不同 | 他的裝置從生效日起算新單位，生效日以前仍算舊單位。 |
| 改名 | 同一個員工編號、姓名不同 | 直接更新。 |
| email 變更 | 同一個員工編號、email 不同 | 更新。舊 email 還在裝置上時，勾選「舊 email 的裝置仍歸他」會替舊 email 建一條歸給他的規則。 |
| email 換人 | email 原本屬於另一個員工編號（例如跨公司調動換了編號） | 舊編號交出 email 並停用。 |
| 新單位、停用單位 | 單位 ID（名稱路徑）的增減；改名看起來是「停用 + 新單位」 | 單位停用不刪除；指向停用單位的 email 規則列在「需處理」。 |
| 被名單取代的規則 | 有手動規則的 email 這次出現在名單上 | 名單優先；勾選「刪除被名單取代的歸類規則」會一併刪掉。 |

- **生效日**：預設是檔名裡的日期，沒有日期時是今天；可以在預覽裡改，但不能是未來。只有新進與部門異動的人會記下這次的生效日。
- **要確認才能匯入**（沒有 `confirm=1` 時回 409 `needs_confirm`）：檔名日期比這家公司上次匯入的舊（`older_file`）；會停用三成以上、至少 3 位在職員工（`mass_departure`）；名單上大多數 email 的網域屬於另一家已匯入的公司（`domain_mismatch`，通常是公司代碼選錯）。
- 同一份名單再匯一次不會有任何變動，仍會記一筆匯入紀錄。
- 每次匯入都記在 `org_imports`：公司、檔名、檔案日期、生效日、匯入者、時間與各種變動的筆數及員工編號（不存姓名與 email）。上次匯入超過 35 天的公司，在匯入清單上標「超過一個月沒更新」。

### 手動歸類 email

上游的用戶端只回報裝置上 AI 帳號的 email。對不到人事名單的 email（個人信箱、共用帳號、外包），它的裝置就沒有歸屬，算在「其他」。管理員可以在 dashboard 的「未歸類 email」逐一或勾選多個一起歸類：

- **歸到部門或團隊**：這個信箱的裝置從此算在那個部門或團隊（必須是在用的部門或團隊，不能是公司或 BU），沒有員工。裝置第一次有歸屬時，從它最早有用量的那天起算，所以歷史也跟著算進去。
- **歸到其他**：這個信箱不屬於任何人。它的裝置維持沒有歸屬，在比較時算「其他」；這個信箱也不再被當成歸屬的證據，連 email 網域都不算。
- API 也接受 `{ "employeeId": "ACME-1" }`（歸給員工，例如員工的個人信箱或舊 email），dashboard 只在匯入時的「舊 email 的裝置仍歸他」用到。
- 人事名單上的 email 不能寫規則（409 `listed_in_hr`）：名單決定它屬於誰。
- 規則會立刻套用（重新對應一次）。把規則改成「其他」或刪掉時，由這條規則產生的歸屬從**當天**起結束，之前的日子仍然算給原本的對象；刪掉規則後，這個信箱會回到未歸類清單。規則指向的員工離職時，歸屬維持不變，規則標「員工已離職」。
- 手動指定的裝置不受規則影響。

未歸類清單上每個 email 附原因：`not_in_hr`（名單上沒有）、`departed`（屬於已離職的員工）、`conflict`（名單上有，但這台裝置同時有多位員工的 email，到「需處理」處理）。

| API | 說明 |
|---|---|
| `GET /api/admin/emails/unclassified` | 還要歸類的 email：出現在**沒有歸屬**的裝置上、還沒有規則。附上原因（`reason`）、它的裝置、最後回報時間、最近 30 天的 token 與成本，以及名單上同一個信箱的員工。依最近 30 天的 token 由多到少排。 |
| `GET /api/admin/emails` | 已經寫好的規則，每條附 `problem`：`superseded`（已被名單取代）、`departed`（員工已離職）、`unit_inactive`（單位已停用）或 `null`。 |
| `PUT /api/admin/emails/:email` | body 是 `{ "unitId": "ACME/Games/Aurora" }`、`{ "employeeId": "ACME-1" }` 或 `{ "other": true }`，可以加 `note`。回應附上這次重新對應的結果。 |
| `DELETE /api/admin/emails/:email` | 刪掉規則。 |

### 員工與單位的關聯存在哪裡

`employees` 本身沒有單位欄位。員工和單位之間有兩種關聯，用途不同：

| 資料表 | 記錄什麼 | 誰會讀 |
|---|---|---|
| `employee_placements` | 每位員工**目前**所在的單位，一人一列（PK 是 `employee_id`），每次匯入人事公告都直接覆寫，不留歷史。`unit_id` 是最底層的單位：有團隊就是團隊，沒有就是部門，再沒有就是 BU 或公司。`company_id` 是組織樹的根。`effective_from` 是他新進或換到這個單位的生效日。 | 單位的名單人數、自動指定裝置時決定單位與換單位的起日，以及手動指定時單位留空的預設值。 |
| `device_owners` | 每台**裝置**在一段日期（`valid_from`～`valid_to`）歸哪位員工、算給哪個單位（`unit_id`）。歸屬改變時開一段新區間。依部門或團隊規則歸屬的區間沒有員工（`employee_id` 是 NULL）。 | 報表與用量分析。每天的用量算給當天的歸屬，所以員工換單位後，舊的用量仍然留在原本的單位。 |

- 單位的上下層靠 `org_units.parent_unit_id`。要從團隊往上找部門、BU 與公司，就沿著這個欄位走；要找某一層，看 `level`。
- 從名單消失的員工只會把 `employees.is_active` 設成 false，`employee_placements` 那一列仍然留著，所以查詢時要加上 `e.is_active`。

```sql
SELECT e.employee_id, e.name, u.name AS unit, u.level, c.name AS company
FROM employees e
JOIN employee_placements p ON p.employee_id = e.employee_id
JOIN org_units u ON u.unit_id = p.unit_id
JOIN org_units c ON c.unit_id = p.company_id
WHERE e.is_active;
```

## Dashboard

`/` 是 hub 的主頁面：用量的分析與比較，以及帳號與裝置。管理員的工具在另一頁 `/admin`（見下方「管理」），安裝說明在 `/install`。網址帶著整個畫面，例如 `/?period=week&date=2026-09-28&company=ACME&bu=Games&level=department&measure=rate`，可以直接分享；區間一定寫，其他設定只寫和預設不同的。舊的網址（`period=today`、`period=allTime`、`range=month|lastmonth|7|30|90|14`、`from` 加 `to`）照樣打得開，沒有指定時預設看「週」。

頁面分成兩種 view：

- **一般使用者**（不登入，需要 `TOKEN_MONITOR_PUBLIC_DASHBOARD`）：公司、BU、部門與團隊的彙總、使用人數與活躍裝置的明細（姓名與主機名稱）、帳號排行，以及 AI 工具額度的帳號 email；看不到員工的 email、員工編號、使用者比較與單一員工的檢視。
- **管理員**（按「管理員」輸入金鑰登入，見上方「管理員登入」）：同一頁多了使用者比較與單一員工；管理的工具不在這一頁，在 `/admin`。登入 12 小時後過期，頁面會請你重新登入。

用量分析裡的員工姓名只有英文名，管理員也一樣：人事名單上的「陳大文 David Chen」顯示成「David Chen」，沒有英文名的人顯示 email 在 @ 前面的部分。管理頁的匯入預覽、員工清單與需處理照舊是完整姓名。

標題列左邊的「Token Monitor」回到首頁：重新打開不帶任何篩選的 `/`，畫面和剛打開時一樣，管理員仍是登入狀態。標題列右邊的「下載 Token Monitor」在新分頁打開公司版用戶端的下載頁，「安裝說明」打開 hub 的 `/install`，兩者都只有設了 `TOKEN_MONITOR_CLIENT_DOWNLOAD_URL` 才出現。

**語言**：頁面有繁體中文與英文，規則和 `/install` 相同。網址的 `?lang=en` 或 `?lang=zh-TW` 優先，其次是在 dashboard 或 `/install` 選過的語言（記在瀏覽器的 `tm.lang`），都沒有時瀏覽器是中文（`zh-*`）就顯示中文，其他語言顯示英文。標題列的「English」／「中文」切換語言並重新打開頁面，畫面停在原本的區間與單位；換區間、單位等畫面時網址會一直帶著 `lang=`，所以分享出去的連結打開也是同一種語言，例如 `/?period=month&lang=en`。英文版的「安裝說明」連到 `/install?lang=en`。單位、人、主機與模型的名稱是資料，兩種語言都照原樣顯示。

寫法（改頁面時照做，`hubDashboard.test.js` 會檢查）：

- 標記一律寫中文。只有文字的元素加 `data-en="…"`，`aria-label`、`placeholder`、`title` 加 `data-en-aria-label` 等；英文頁面打開時 `translateMarkup()` 換成英文。裡面還有其他元素的段落寫兩份，分別標 `lang="zh-Hant"` 與 `lang="en"`，CSS 只顯示頁面那一種。
- 腳本寫出的每一段文字都用 `L('中文', 'English')`；英文的單複數用 `plural(n, 'device', 'devices')`。整句一起寫，不要把中文的片段拼起來再翻。沒有頁面時（測試直接跑這些函式）`L()` 回傳中文，所以既有測試的中文結果不變。

最上面的狀態列寫著「已連線（唯讀）」或「已連線（管理員）」與資料時間；登入的管理員多一個「前往管理區」，打開 `/admin`（讀不到用量時也有）。錯誤與使用者自己按出來的更新，也會念給螢幕報讀器。

**篩選列**（最上面一排，下面的數字全部依它計算）

- **區間**：日、週、月、年、近 7 天、近 30 天、近 90 天、自訂。
  - 日、週、月：週是 ISO 週（週一到週日），月是日曆月。用 ◀ ▶ 前後移動、用日期跳到任一天；要回到今天所在的那一期，用日期選今天或按 ▶ 到底。
  - 年：一個日曆年，依月份畫趨勢，整年是焦點（日均除以已經過的天數），預設和去年同期比（今年到今天為止，和去年的同一段比）。「今年」「去年」直接跳過去，◀ ▶ 前後一年；網址是 `period=year`，去年是 `period=year&date=2025-01-01`。
  - 日期欄位與 ◀ 不會早於 hub 最早有用量的那天（每日資料的第一天，或每月合計的第一個月）；看到更早的範圍時，KPI 上方提醒那段只有每月合計，請用「月」或「年」看。
  - 近 N 天：到昨天為止，不含今天，所以比較的兩邊都是整天，數字也不會隨著每次上傳跳動。
  - 自訂：選開始與結束日期後按「套用」，最多 400 天。
  - 過了午夜，看目前這一期與近 N 天的畫面會自動移到新的一天；自訂區間與選定的日期不動。
- **組織**：公司 → BU → 部門 → 團隊。每一層只列出上一層選的單位底下的單位；點開後可以直接輸入名稱搜尋（不分大小寫，空白隔開的每個詞都要符合，也比對單位所在的上層名稱），用 ↑ ↓ 選、Enter 確定、Esc 取消。直接選一個部門時，它的公司與 BU 會自動帶出來。管理員看單一員工時，這裡多一個「員工：<姓名> ✕」，按 ✕ 回到原本的單位；改任何一個組織選單也會回到單位檢視。
- **工具**：全部工具，或只看一個 AI 工具（Claude Code、Codex、Cursor…，選單只寫工具名稱，這一期用量多的在前）。選了之後 KPI、單位比較、趨勢、使用者比較、帳號排行、活躍名單與裝置表的今日、本月都只算那個工具，範圍旁出現「只看 Claude Code ✕」。模型的用量沒有記錄是哪個工具用的，所以模型區塊寫出無法細分，趨勢也沒有「依模型」「依工具」。在「工具」區塊點一個工具也會只看它，再點一次回到全部。網址帶 `tool=`。帳號與裝置也只列出這一期用過那個工具的裝置，AI 工具額度只列那個工具的帳號（沒有額度帳號的工具，例如 Hermes Agent，寫出它沒有額度帳號），工具狀態只列那個工具。

**用量**（資料來自 `/api/custom/usage`，分頁看得到時每分鐘更新一次）

- **範圍與比較**：KPI 上方是目前的範圍（「全部公司 › ACME › Games」，點上層就回到那一層，並標出剛才看的單位），以及比較的對象，例如「和上週同期（09-21 ～ 09-23）比較」「和上週同一天（09-23，三）比較」「和前 30 天（08-01 ～ 08-30）比較」「和去年同期（2025-01-01 ～ 2025-10-04）比較」。
  - 一律和上一期比，沒有比較的選單（2026-10-05 起；以前可以選去年同期或自訂期間，網址的 `compare=`、`cfrom=`、`cto=` 現在不理會）。上一期跟著區間：日是上週同一天、週是上週、月是上月、年是去年，近 N 天與自訂區間是緊接在前、一樣長的天數。
  - 還沒過完的一期和前一期**同樣的天數**比。
  - 比較的期間早於 hub 開始收資料的那天時會提醒：那段只有裝置補傳的歷史，可能偏少。
- **KPI**：token、等值成本、使用人數（名單人數與使用率）、活躍裝置（還沒有對應到員工的台數，管理員多一個「去歸類」），每張都寫著和比較期間相差多少與上期的數字（「▲ 18%，上期 10.44M」）。看今天時不算百分比，只列上週同一天全天的數字。
  - 點使用人數或活躍裝置的數字，KPI 下方列出這一期有用量的每個人（姓名、單位、用量、裝置數、有用量天數）或每台裝置（主機名稱、單位、用量），用量多的在前；不用登入也看得到。管理員點姓名就打開那個人的用量。點主機名稱就捲到下方帳號與裝置的「裝置」，搜尋框填入那台的主機名稱（這個名稱也會找到別台時改填裝置 ID）並展開它的帳號與工具，每個人都能點；已從 hub 刪除的裝置不能點。單位是這一期最後一天有用量時的歸屬。
- **總覽**（KPI 下方的四張圖）：Token 與等值成本同時列出。總覽以下的區塊一律依 Token 排序、畫條與和上期比較，等值成本寫在每一條的明細（手機寬度不顯示）與表格裡，表格可以點「等值成本」欄依成本排序；只有「趨勢」可以切換成等值成本。管理員看到的是每個人；不是管理員時改成比較的層級（例如每個部門），看單一員工時改成他的每台裝置。
  - **每日 Token 趨勢**、**每日等值成本趨勢**（週、月的檢視是每週、每月）：一人一條折線，範圍和「趨勢」相同。Token 最多的 7 個人各一個顏色，兩張圖裡同一個人同一個顏色；其餘的人、沒有對應到員工的裝置與沒有細分到的用量合成一條灰線，圖例寫出灰線包含什麼。虛線是還不完整的一期。滑過或用左右方向鍵看那一期每個人的數字，點一下或按 Enter 打開那一期。
  - **模型分布**：這一期的等值成本依模型畫成甜甜圈，旁邊列出每個模型的金額與占比。前 7 個模型各一個顏色，其餘的模型與沒有細分到模型的用量合成灰色。管理員可以選一位員工，只看那個人的模型分布；只改這張圖，網址不變，模型的顏色沿用全部員工的。只看一個工具時無法細分模型。
  - **員工用量**：這一期每個人的 Token 與等值成本並排，兩邊各自一個刻度，Token 多的在前，顏色和折線相同。先顯示前 10 人，「顯示全部」列出其餘的，最後是「沒有對應到員工」。點一個人就看他一個人的用量；點「沒有對應到員工」見下方「看沒有對應到員工的用量」。
- **單位比較**：
  - 切換要比較的層級：公司、BU、部門、團隊，只列有單位或這段期間有用量的層級。
  - 「搜尋單位」用名稱或上層的名稱篩選比較條與表格（空白隔開的每個詞都要符合），名次照全部的單位算；搜尋時不列「其他」。
  - 「排序」選總量、人均（÷ 名單人數）、使用率（使用人數 ÷ 名單人數）或變化（和上期相差多少，依變化的大小排，由中線往兩邊畫）。排序同時決定順序、條的長度與右邊的數字；人均與使用率的灰線是目前範圍整體的值。名單人數是最新一次匯入的名單，所以過去的期間使用率可能超過 100%。
  - 「依工具…」依某一個工具（例如 Codex）的用量排序：條的長度、右邊的數字與 ▲▼ 都是那個工具的，明細寫出它占這個單位的多少。網址帶 `measure=tool:codex`。
  - 總量與人均的每一條依工具分段上色，上方有圖例：用量最多的 7 個工具各一個顏色（和趨勢「依工具」相同的顏色），其餘的工具與沒有細分到工具的用量是灰色。「工具」區塊也用同樣的顏色。只看一個工具時不分段，也沒有「依工具…」。
  - 每一條附名次、和上期的比較（▲ ▼、「新」、「持平」）與明細（例如「$1,234.56 · 占 23% · 18／25 人使用」）。
  - 不屬於任何一個該層單位的用量，合成最後一條灰色的「其他」；「其他」沒有名單人數，不列入人均與使用率。比公司時，「其他」是還沒有歸屬、email 網域也對不到公司的裝置（只靠 email 網域對得到公司的裝置算在那家公司）。
  - 點一個單位就只看它；已停用、組織樹裡已經沒有的單位不能點。「表格」依同樣的順序列出每個單位的完整數字與合計列，最後是每個有顏色的工具一欄與「其他工具與未細分」。點表頭依那一欄排序（數字先由大到小、文字先由小到大，再點一次反過來），「其他」與合計固定在最後；換了上面的「排序」，表格回到和比較條相同的順序。
  - 點「其他」也一樣只看它（網址帶 `other=<層級>`，例如 `?period=week&company=ACME&other=bu`）：範圍寫成「ACME › 其他」並說明它包含什麼，KPI、趨勢、模型、工具、使用者比較與帳號排行都只算其他，活躍裝置的明細自動打開，列出是哪些裝置。「其他」底下沒有單位可以比，所以不顯示單位比較；點範圍裡的「ACME」回到 ACME、依同一層比較並標出「其他」。帳號與裝置也只列出這一期在其他裡有用量的裝置與它們的帳號。
- **趨勢**：
  - 日是最近 14 天、週是 12 週、月是 12 個月；近 N 天與自訂區間依長度用日、週或月。
  - 預設依比較的層級（公司、BU、部門或團隊），也可以改成依模型、依工具，管理員還可以依人員。
  - 「分開」（預設）：每個單位（或模型、工具、人）一張直條圖，用量多的在前，「其他」與沒有細分到的用量也各一張；全部用同一個刻度，所以高低可以直接比。先顯示前 8 個，「顯示全部」列出其餘的。
  - 「堆疊」（網址帶 `layout=stack`）：疊成一張圖，Token 最多的 7 個各一個顏色，其餘、「其他」與沒有細分到的用量合成灰色，所以每一欄的高度都是範圍的合計。同一個單位在兩種圖裡是同一個顏色。
  - 「Token｜等值成本」只換趨勢的圖、刻度、數字與表格，網址帶 `metric=cost`（2026-10-07 以前在篩選列，叫「指標」，會連下方的區塊一起換）。顏色一律依 Token 排名，所以同一個單位、模型、工具或人，在 Token 與等值成本的圖裡、和總覽與單位比較都是同一個顏色。
  - 有底色的是目前這一期，斜線是還不完整的一期（進行中，或被區間截掉），日的圖週末是淡灰底。
  - 滑過或用左右方向鍵看每一欄的數字，點一下或按 Enter 打開那一天、那一週或那個月（手機上點第二下才打開）。「表格」有每一欄的確切數字。
- **模型**、**工具**：這一期的排名，附和上期的比較與占範圍的比例。先顯示前 8 個，展開後列出全部，也列出這一期降到 0 的。沒有細分到模型或工具的用量是灰色的「未細分」。
- **Token 組成**：輸入、輸出、快取讀取、快取寫入與未分類。只算有組成資料的用量（部分用戶端只回報總量，較早的歷史也沒有組成），不到全部時寫出占這段期間的多少。
- **使用者比較**（只給管理員）：範圍內每個人的用量，排序選總量、變化或「依工具…」（網址 `usort=tool:<工具>`），總量時每一條依工具分段上色，可以用姓名、email 或單位搜尋。點一個人就看他一個人的用量。沒有對應到員工的裝置合成最後一條「其他」，「列出 N 台裝置」列出它們的主機名稱，點「其他」本身和點員工用量的「沒有對應到員工」一樣。
- **帳號排行**（每個人都看得到，2026-10-07 起；之前是只給管理員的「帳號比較」）：範圍內每個 AI 帳號（email）依 Token 由多到少排名，跟著篩選列走：公司、BU、部門或團隊、期間與比較期間、工具、「其他」與沒有對應到員工。先顯示前 10 名，「顯示全部 N 個帳號」列出其餘的，「只顯示前 10 個帳號」收起；可以用 email、工具、主機名稱或單位搜尋，搜尋時依找到的帳號重新排名。每一條寫出帳號的工具、單位、等值成本、各工具的用量、裝置台數與和上期比較，滑鼠移上去看裝置的主機名稱。用量是推算的：一台裝置上一個工具的用量，算給這台裝置回報的同一家帳號（Claude Code 算給 Claude 帳號、Codex 算給 Codex 帳號，對應用上游的 `limitProviderForClient`）。同一台裝置同一家有兩個以上帳號時分不開，合成一條標「共用」；沒有額度帳號的工具算最後一條「其他」。上游只保留裝置最後一次回報的帳號，換過帳號的話，之前的用量也會算給現在的帳號。使用者比較與帳號排行都有「表格」，列出搜尋到的每一個人或帳號，點表頭排序，例如帳號依等值成本或和上期比較排。之前的「依工具」分組與「變化」排序拿掉了，舊網址的 `asort=`、`agroup=` 不再作用。
- **看單一員工**（只給管理員）：員工（單位、是否在職）、token、等值成本與裝置數的卡片，他每一台裝置的用量（「裝置」），預設依裝置堆疊的趨勢，以及他的模型、工具與 token 組成。網址帶 `employee=<員工編號>`：沒有金鑰時不理會，不是 admin 金鑰時 hub 回 403，頁面回到單位檢視。
- **看沒有對應到員工的用量**（從員工用量或使用者比較點進來）：只算目前範圍裡（打開了「其他」時是那個「其他」裡）當天沒有算給任何員工的用量，也就是還沒有歸屬、或 email 歸到「其他」的裝置。網址帶 `unowned=1`，例如 `?period=week&unowned=1`。範圍寫成「全部公司 › 沒有對應到員工」，點前面的範圍回到原本的檢視與比較層級。和看單一員工一樣，第一張卡片寫出它包含什麼並連到「未歸類 email」去歸類，「裝置」列出每一台裝置的用量，趨勢預設依裝置堆疊；活躍裝置的明細自動打開，寫出每台裝置的單位（只靠 email 網域對到公司的寫那家公司）。沒有單位可以比、也沒有人，所以不顯示單位比較與使用者比較；帳號排行照樣有，可以從 AI 帳號看出裝置是誰的；帳號與裝置也只列出這些裝置與它們的帳號。
- dashboard 沒有 CSV 下載。要把用量匯出成 CSV，用報表 API 的 `format=csv`（[reports-api.zh-TW.md](reports-api.zh-TW.md)）。
- 數字怎麼算：和報表一樣從每日用量表加總，每一天算給當天持有裝置的人（`device_owners`）。月與年的檢視（以及依月份畫的長區間）另外補上每月合計：一台裝置在範圍或比較期間裡某個完整的月份完全沒有每日資料時（通常是它第一次上傳以前的歷史），用它那個月的合計，算給月初那天持有裝置的人，不算有用量的天數；KPI 上方會寫出是哪幾個月。週、日與被截斷的月份不用每月合計。沒有歸屬、但 email 網域只屬於一家公司的裝置，算在那家公司，但不在它底下的任何單位。頁面最下方的「說明」也寫著：等值成本不是實際帳單、名單人數以最新一次匯入的名單計算、最近兩三天的數字之後可能還會增加。
- email、員工編號、使用者比較與單一員工的檢視只給管理員；不帶金鑰與 client 金鑰拿得到單位名稱、人數與用量數字，以及使用人數、活躍裝置明細裡的姓名、主機名稱與每個人、每台裝置的用量（2026-10-01 起），還有帳號排行裡每個 AI 帳號（email）的用量、工具與主機名稱（2026-10-07 起）。只有一兩個人的單位，這些數字實際上就是那個人的用量（最小人數門檻還沒有實作）。
- hub 忙碌時（503 `usage_busy`，只會發生在不帶 admin 金鑰的請求），頁面保留目前的畫面，幾秒後自動重試。查詢超過 15 秒時（503 `usage_slow`）不重試，請使用者縮短區間、選比較小的單位或只看一個工具。

**管理**（`/admin`，管理員登入後才看得到）

管理是獨立的一頁 `/admin`，和用量分開：hub 送的是同一個 `hub/dashboard.html`，在 `/admin` 只顯示管理，在 `/` 只顯示用量與帳號與裝置，兩邊都只讀自己需要的資料。標題列寫「Token Monitor 管理」，沒有「下載 Token Monitor」與「安裝說明」，狀態列的「回到用量」回到 `/`；沒有登入時寫出「管理頁只給管理員」並直接打開輸入金鑰的欄位，登入過期時請你重新登入，登出後留在這一頁。用量頁的「去歸類」、「未歸類 email」與「前往匯入」打開 `/admin` 的那一段（例如 `/admin#emailSection`）；員工清單點姓名，在新分頁打開那個人在 `/` 的用量，清單保持原樣。英文頁面之間的連結都帶著 `?lang=en`。

**左側列**：登入後 `/admin` 左邊有一排圖示，滑鼠移上去或用 Tab 移進去時展開成文字，移開就收回；按「固定」讓它一直展開（記在瀏覽器的 `tm.railPinned`）。項目依「組織資料」（匯入人事公告、需處理、未歸類 email、部門清單、員工清單）、「對外整合」（API token）與「系統維護」（資料庫備份、刪除歷史資料、用戶端版本）分組，最上面的「回到用量」回到 `/`。一次只顯示一個區塊：網址的 `#importSection` 這類 hash 指定哪一個，沒有或那一區沒顯示時是第一個，所以用量頁的「去歸類」等連結照樣打開那一區。「需處理」、「未歸類 email」與「用戶端版本」旁邊是件數（比 hub 舊的裝置數），收起時變成圖示上的點。手機寬度時改成標題列左邊的 ☰，點了才從左邊滑出。

- **匯入人事公告**：把 xlsx 拖進框裡或選檔案，可以一次多個，按「預覽差異」。每個檔案一張卡片：人數、各種變動的筆數與明細（可以展開）、略過的列、警告；可以改生效日、勾選要不要刪除被取代的規則與保留舊 email，有警告時要勾「我確認要匯入這個檔案」才能按「匯入」。下面列出每家公司最後一次匯入的時間、在職人數、檔案、生效日與上次的變動，超過一個月沒更新的標出來。「重新對應裝置」的結果也列出只到公司與往前延伸的台數。
- **需處理**：多位員工 email 的裝置（按員工名字決定這台算誰的，從裝置第一天起算）、離職員工還在回報的裝置、有問題的歸類規則（可以刪除），以及之前手動指定的裝置（「改回自動」）。
- **未歸類 email**：見上方「手動歸類 email」。每個 email 附原因、裝置、最近 30 天的 token 與成本；選部門或團隊後按「歸到這個單位」，或「歸到其他」；勾選多個時，上方出現一次歸類的工具列。選到一半的單位與勾選不會被每分鐘的更新清掉。
- **部門清單**（展開才載入）：公司 → BU → 部門 → 團隊的樹，每個單位的在職人數（含下層，另列直屬）、裝置數與最近 30 天的用量；可以搜尋、顯示已停用的單位，「看員工」跳到員工清單並篩出那個單位。
- **員工清單**（展開才載入）：員工編號、姓名、email、單位、異動生效日、裝置數與最近 30 天的用量；可以用姓名、email、編號或單位搜尋，依公司與「在最新名單上／已不在名單上／全部」篩選。點姓名在新分頁看他一個人的用量。
- **API token**：建立、列出、撤銷。
- **資料庫備份**：hub 每天自動備份的時間與保留份數、每一份備份（時間、種類、大小）。「立即備份」馬上做一份；每一份都可以下載或刪除，刪除前的備份刪除時會再警告一次。不能備份時寫出原因（例如找不到 `pg_dump`）。還原不在網頁上，照 [postgres.zh-TW.md](postgres.zh-TW.md)「備份與還原」手動做。
- **刪除歷史資料**：選「保留 YYYY 年 M 月起的資料」，按「預覽」看每張表會刪掉幾列與合計，輸入月份確認後按「先備份，再刪除」。刪除所有裝置在那個月以前的每日、每月用量與 session 明細，之後用戶端補傳的舊資料也不會再寫入；刪除前的備份列在「資料庫備份」，不會自動刪除。只能往後刪，刪除紀錄在下面。見 [postgres.zh-TW.md](postgres.zh-TW.md)「刪除歷史資料」。
- **用戶端版本**：hub 所用的上游版本，以及版本比它新（⚠）或舊的裝置。使用者自己更新用戶端，比 hub 新的用戶端可能送出 hub 還不認得的資料，見 [client-setup.zh-TW.md](client-setup.zh-TW.md)。

**帳號與裝置**（資料來自上游的 `/api/stats`，依選的單位過濾）

跟著篩選列：只列出所選期間、在目前的範圍裡有用量的裝置，也就是 KPI「活躍裝置」算到的那幾台，AI 工具額度只列這些裝置上的帳號，工具狀態也只算這些裝置。範圍是選的單位、打開的「其他」、沒有對應到員工或單一員工；只看一個工具時是用過那個工具的裝置，AI 工具額度只列那個工具的帳號。所以這段期間沒有用量的裝置（例如請假沒開機的）不會出現，裝置的標題寫出「13 台有用量 · 其餘 3 台不符合篩選條件」；要看它們，把區間拉長。用量還在載入時三個區塊寫「載入中…」；讀不到用量時（例如 hub 沒有資料庫）列出單位裡的全部裝置與帳號。

- **AI 工具額度**：每家供應商一行摘要（「Claude · 45 個帳號 · 最低剩餘 12% · 3 個低於 15% · 最快 2 小時後重置」），展開才看每個帳號，以帳號名稱與 email 標示，不用登入也看得到（2026-10-01 起，之前只給管理員）。
  - 帳號名稱旁標出方案，例如 Claude 的 Pro、Max 20x、Team，Codex 的 Plus，Cursor 的 Free。方案和上游 app 一樣，取用戶端回報的 `planLabel`，沒有時取 `accountLabel`（Claude 與 Codex 放在這裡）；沒有回報方案的帳號不標。
  - 每個帳號會寫出它在哪幾台裝置上（只寫下方「裝置」列出的），以及這些裝置在所選期間的用量（Token 與等值成本）。點裝置的主機名稱就捲到下方的「裝置」，搜尋框填入那台的主機名稱（這個名稱也會找到別台時改填裝置 ID）並展開它的帳號與工具，和活躍裝置明細的主機名稱相同。
  - 帳號底下列出每個額度視窗，但還沒花錢的花費視窗不列，例如 Claude 的「帳單週期 · Usage credits」是 USD 0.00 時；花了錢就會出現。
  - 「工具」只看一家供應商，例如只看 Claude，選了就直接展開它的帳號；選單列出每家有帳號的供應商和帳號數。
  - 供應商固定依名稱排，不互相比較用量或剩餘額度（2026-10-07 起；之前整區共用一個排序，供應商也照它排）。
  - 每家供應商有自己的「排序」，只排這一家的帳號，各家互不影響，例如 Cursor 看剩餘額度、Codex 看用量。展開「列出 N 個帳號」時才出現在那一行的右邊；只有一個帳號的供應商沒有。
    - 用量（預設）：帳號所在裝置在所選期間的 Token，多的在前。讀不到用量時，剩餘額度低的在前。
    - 剩餘額度：最低剩餘少的在前。
    - 名稱：依 email。
    - 再按一次選中的排序就反過來，例如用量少的在前、名稱 Z → A。按鈕上的 ▼（大的在前）或 ▲（小的在前）是目前的方向，滑鼠移上去會寫出來，例如「用量少的在前，再按一次反過來」。改選別的排序時，從那個排序原本的方向開始。
    - 沒有百分比的帳號排在最後，反過來也一樣；一樣時依序比剩餘額度、用量、名稱。
    - 沒有依重置時間排序（2026-10-05 拿掉）。
  - 工具與各家的排序都寫在網址裡，連結打開就是同一個畫面：`ltool=claude`；每家不是預設排序時各一個 `lsort=<供應商>.<排序>`，反過來時再加 `.rev`，例如 `lsort=cursor.left&lsort=codex.usage.rev`。之前整區共用的 `lsort=left`、`lrev=1` 不再作用，打開時每家都依用量排。
  - 離線裝置上的帳號也會列出，標示 stale 與最後回報時間。滑鼠移到 stale 上，馬上跳出一個提示框說明它跟 live 的差別；用 Tab 移到它上面、或在手機上點一下也會出現，按 Esc 關掉。上游只要同一家供應商有在線的帳號，就會把 stale 的帳號拿掉；頁面再從各裝置最後一次回報的額度補回來。
  - 摘要裡的最低剩餘、低於 15% 與最快重置只看在線的帳號，整家供應商都離線時才用最後一次回報的數字。stale 帳號的視窗如果在回報之後已經過了重置時間，會寫「回報後已重置」。
- **裝置**：每台裝置的狀態，放在可以捲動的表格裡。這裡照上游，所有看得到 dashboard 的人都看得到主機名稱。「狀態」一欄的 live 是在 stale 門檻內有回報，數字是最新的；stale 是超過門檻沒回報，數字停在最後一次回報。門檻是 hub 的 `TOKEN_MONITOR_STALE_AFTER_MS`（預設 10 分鐘），用戶端每 10、20 或 30 分鐘才上傳一次時，改成上傳間隔的兩倍。滑鼠移到 live 或 stale 上，馬上跳出一個提示框，寫出兩者的差別與這台的門檻，例如「live：1 小時內有回報…」；用 Tab 移到它上面、或在手機上點一下也會出現，按 Esc 關掉。離線（stale）的裝置也列在表裡，主機名稱下面列出這台裝置最後一次回報的 AI 帳號，一個 email 一行（沒有 email 時列帳號名稱），前面寫出是哪個工具的帳號，例如「Claude amy.lin@example.com」；同一個 email 用在好幾個工具上時只列一行，例如「Claude、Codex ben.wu@example.com」。和 AI 工具額度一樣每個人都看得到。「所選期間」一欄是這台裝置在所選期間的 token，表格依這一欄排序，多的在前；同樣多時依序比本月、今日的 token，最後比主機名稱。讀不到用量時，就依本月的 token 排。點表頭可以改依任何一欄排序，再點一次反過來；上方的搜尋框在列出的裝置裡用主機名稱、裝置 ID、系統、版本、AI 帳號的 email、這一期的使用者與單位，或有用量、已安裝的工具篩選，標題旁寫出「找到 N／M 台」。搜尋與排序只存在這個分頁，不寫進網址。點一台裝置展開它的工具：先是「有用量 2 個 · 已安裝待用 1 個」，再把有用量、已安裝待用，以及有 token 但沒有追蹤的工具各列一列，附上今日與本月的 token（用裝置自己的日期，和那一列相同）；沒有安裝、也沒有 token 的工具不列。每分鐘更新後，展開的裝置仍然展開。
- **工具狀態**：列出的裝置裡，每種工具有幾台裝置有用量；只列至少一台裝置有安裝的工具，不顯示「未安裝」。

同一個（單位、區間、粒度、層級、焦點、比較期間、工具、員工、是否含人名）的結果會重用一個串流時間窗（`TOKEN_MONITOR_STREAM_WINDOW_MS`，預設 60 秒）；匯入名單、歸屬或 email 規則改變時立即作廢，當時還在計算的結果也不會留下。同時最多計算 2 個、另外 16 個排隊。

## 掛接方式

請求依序經過三層 request listener，由 `router.js` 的 `wrapRequestListeners()` 疊上：

1. **overlay 層**（`overlay.js`）：處理上表的路由與金鑰判斷。其他請求換上 admin 金鑰後交給下一層，因為上游只認一把 secret。
2. **dashboard 層**（`createDashboardHub()`）：回答 dashboard 頁面。
3. **上游的 handler**：`createHub()` 原本的處理。

有資料庫時，裝置狀態由 `core.js` 持有，hub 物件的資料方法（`ingest`、`getStats`、`getDevices`…）都改指向 core，上游每次上傳都整份重寫 JSON 檔的 `persist()` 就不會再執行。`core.js` 以上游匯出的同一組函式逐行重建上游的語意。

依賴的上游接縫全是公開的：`createHub` 與它的回傳物件、`src/shared/` 的匯出，以及 `hub.server`。會偵測上游改動的測試：

- `hubOverlayBootstrap.test.js`：上游 CLI bootstrap 的每一行都必須原樣、依序保留在 overlay 的版本裡。overlay 只能在行與行之間插入。
- `core.test.js`：`core.js` 所對照的上游函式留有原始碼指紋，也與上游逐項比對行為。上游一改，就要比對並更新 `core.js`。
- `stream.test.js`、`persistentHub.test.js`：回應格式與標頭和上游一致。

## 同步上游

`upstream/` 是上游的 git subtree，用 `--squash` 拉進來。每次更新是一個「Squashed 'upstream/' …」commit 加上它的 merge；commit 訊息的 `git-subtree-split` 記著上游的 commit。上游直接從 GitHub 的 [Javis603/token-monitor](https://github.com/Javis603/token-monitor) 拉，不需要鏡像（連不到 GitHub、要改從鏡像拉時，設環境變數 `UPSTREAM_URL`）：

**升級的完整步驟、接縫對照與客製功能回歸清單在 [upstream-upgrade.zh-TW.md](upstream-upgrade.zh-TW.md)（上游升級 SOP）**；Claude Code 的 `/upstream-update` skill 照著它做。

```bash
npm run upstream:status                  # 目前的上游版本與 GitHub 上更新的版本
npm run upstream:update -- next          # 拉下一個 release 進 upstream/，跑 verify，寫出 tmp/upstream-impact.md
npm run upstream:update -- v0.64.0       # 指定的 release tag（跳過中間的版本要加 --allow-skip）
npm run upstream:impact                  # 印出影響報告；-- --out tmp/upstream-impact.md 寫回檔案
npm run smoke:hub                        # 驗證用的丟棄式 hub：PGlite、測試金鑰、假資料，不需要 Docker
```

- 只拉上游的 release tag，不拉 `main`，而且一版一版升：跳過中間的版本時 `upstream:update` 會拒絕，除非加 `--allow-skip`。hub 鎖在哪一版，相容的用戶端就是哪一版；公司版用戶端也從同一個 `upstream/` 打包。
- 更新後 verify 失敗（結束代碼 3），代表上游動到了接縫。修改本 repo，絕不修改 `upstream/`；修好之後照常 commit。
- 影響報告列出被碰到的接縫（[upstream-touchpoints.json](../upstream-touchpoints.json)，加上自動掃描到的 `upstream('…')`），以及上游新增的 hub 路由與 `TOKEN_MONITOR_*` 設定。升級時碰到清單沒寫到的接縫，就補進 `upstream-touchpoints.json`。
- **不要改 `upstream/` 裡的任何檔案。** `npm run check:upstream`（包含在 `npm run verify` 裡）會比對 `upstream/` 與最近一次 subtree commit 的 tree，有差異就失敗；working tree 裡還沒 commit 的改動也一樣。
- `npm test` 用 PGlite（在 Node 行程裡跑的 PostgreSQL），不需要資料庫伺服器。寫入鎖這類需要多條連線的測試，只有在設定 `TOKEN_MONITOR_TEST_DATABASE_URL`（一個可以建立 schema 的帳號）時才會跑，例如 compose 內建的 `postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/token_monitor`（見 [postgres.zh-TW.md](postgres.zh-TW.md)「測試」）。

## 發行：兩種 tag

推上 GitLab 的 tag 決定發行什麼。兩種 tag 的版本號都是 `<上游版本>-corp.<N>`：

| tag | 發行什麼 | 怎麼打 | 推上去之後 |
|---|---|---|---|
| `corp/v<版本>` | hub | 只用 `npm run build:image`，再 `git push origin HEAD`（下方「建立 hub 映像」）。不要手打。 | `verify` → `build:hub`（建映像、冒煙測試、存到 Package Registry）→ 手動按 `deploy:hub` |
| `client-v<版本>` | 公司版用戶端 | 確認那個 commit 通過 `npm run verify`，再 `git tag client-v<版本>` 並推到 origin（[client-build.zh-TW.md](client-build.zh-TW.md)「發行」）。 | Windows、macOS、Linux 打包 → `release:client` 建立 GitLab Release，已安裝的 app 從最新的 Release 更新。推到 GitHub 則由 `client-release.yml` 建立不帶金鑰的公開 Release（[client-build.zh-TW.md](client-build.zh-TW.md)「從 GitHub 發行」） |

- 兩種 tag 的 N 各算各的：同一個上游版本，hub 可能在 `corp/v0.63.1-corp.2`，用戶端已經到 `client-v0.63.1-corp.9`。上游版本換了，N 從 1 重新算。
- 推出去的 tag 不刪也不移。那一版有問題時，修好再發下一號，例如 `corp/v0.63.1-corp.1` 的 pipeline 卡在 verify，修好後發的是 `corp/v0.63.1-corp.2`。
- 兩種 tag 都要在 Settings → Repository → Protected tags 設成 protected，只讓 Maintainers 建立。不是 protected 的 tag 拿不到 protected 的 runner 與變數：hub 的 tag 會在 `verify` 失敗並說明，用戶端的 tag 則是 job 一直 pending。
- 只有 `client-v*` 會建立 Release。最新的 Release 沒有 `latest.yml` 時，所有 app 的更新檢查都會失敗。

## 建立 hub 映像

發行一律用 `npm run build:image`，它在打包時寫好這一版的文件（[packaging.zh-TW.md](packaging.zh-TW.md)）：

```powershell
npm run build:image -- --dry-run    # 先看這一版的文件與要跑的指令
npm run build:image                 # 發行：文件與 corp/v<版本> tag，推到 origin
git push origin HEAD                # 發行文件的 commit 也推上去
```

- 推上 tag 之後，GitLab 的 `build:hub` 建映像、做冒煙測試，存到 Package Registry；再按 `deploy:hub` 部署（下方「從 GitLab 部署」）。
- 版本號是 `<上游版本>-corp.<N>`，例如 `0.63.1-corp.1`。
- 每一版的文件在 `docs/releases/<版本>.md`，寫著相容的用戶端版本、異動、migration、設定的變化、部署與回滾。
- Compose 不會自己建映像（`pull_policy: never`），用的是本機的 `token-monitor-hub:latest`。
- 不經過 GitLab 部署時，從 Package Registry 的 `token-monitor-hub/<版本>` 下載映像檔與 `SHA256SUMS`，到那台主機上核對之後 `docker load -i`。`--build` 則在本機建映像，產出在 `dist/hub/<版本>/`。
- 開發時可以直接 `docker build -f docker/Dockerfile -t token-monitor-hub .`，但那會用 working tree 建置，包括還沒 commit 的改動。

## 部署

**一鍵部署到 Ubuntu**：在檔案總管雙擊本 repo 根目錄的 `deploy-ubuntu.cmd`，輸入 SSH 帳號與密碼就好。

- 它等於不加參數執行 `.\deploy\3.deploy-ubuntu.ps1`：以這個 checkout 已 commit 的 `HEAD` 重新產生 release 資料夾，再部署到 Ubuntu。沒有 commit 的改動不會部署上去。
- 帳密輸入後先登入一次，打錯或連不上主機時馬上停下來，不必等映像建完。之後不再詢問任何事情。
- Docker Desktop 沒有開時會自動打開，等它就緒再繼續。
- 結束時視窗停著，看完結果按任意鍵關閉。
- 從終端機執行時可以加 `3.deploy-ubuntu.ps1` 的其他參數，例如 `.\deploy-ubuntu.cmd -SkipBackup`。

`deploy/` 的腳本都在 Windows 上用 PowerShell 執行，只取**已 commit** 的程式。1 產生 release 資料夾，2 部署它現在的內容；3 自己先以 `HEAD` 重新產生，再部署：

```powershell
.\deploy\1.token-monitor-release.ps1   # 產生 ..\token-monitor-release（-Ref 指定分支、tag 或 commit，預設 HEAD）
.\deploy\2.deploy-local.ps1            # 把 ..\token-monitor-release 部署到本機的 Docker Desktop
.\deploy\3.deploy-ubuntu.ps1           # 以 HEAD 重新產生 ..\token-monitor-release，部署到 Ubuntu（預設 192.0.2.10），執行時輸入 SSH 帳號與密碼
```

| 腳本 | 做什麼 |
|---|---|
| `1.token-monitor-release.ps1` | 用 `git archive` 把 repo 組成 `..\token-monitor-release`：上游原版在 `upstream/`，公司版在根目錄，也就是 `upstream.js` 與映像要的佈局；`RELEASE-INFO.txt` 記著 commit 與上游版本。重新產生時整個換掉，只保留 `.env`、`data/` 與 `backups/`；不是這些腳本產生的資料夾會改名成 `<資料夾>.bak-<時間>` 留著，不會刪除。 |
| `2.deploy-local.ps1` | 以 release 資料夾現在的內容在本機建映像，再以 release 資料夾裡的 `.env` 執行 `docker compose up -d`。 |
| `3.deploy-ubuntu.ps1` | 以 `-Ref`（預設 `HEAD`）重新產生 release 資料夾，在本機建映像，經 SSH 把程式與映像上傳到 Ubuntu，部署到該帳號家目錄的 `token-monitor-release`（`-RemoteDir`）。主機只需要 Docker 與 compose v2，不需要 git、Node 或對外網路。 |
| `server-deploy.sh` | 部署在伺服器上的那一半：release 資料夾、備份、`.env`、映像、`docker compose up -d` 與健康檢查。由 `3.deploy-ubuntu.ps1` 上傳執行，GitLab 的 `deploy:hub` 也用它，不直接執行。 |
| `install-runner-ubuntu.ps1` | 經 SSH 在 Ubuntu 安裝 GitLab CI 的 `ubuntu` runner（Docker executor，systemd 開機啟動），見 [client-build.zh-TW.md](client-build.zh-TW.md)「GitLab 設定」。加 `-HubDeploy` 則安裝部署 hub 的 `hub-deploy` runner，見下方「從 GitLab 部署」。 |
| `install-runner-macos.ps1` | 經 SSH 在 Mac 安裝 `macos` runner：Command Line Tools、Node 22、gitlab-runner，裝成開機就啟動的 LaunchDaemon，接電源時不睡眠。 |
| `common.ps1` | 這些腳本共用的函式，不直接執行。 |

在本 repo 的 checkout 執行 2 或 3 時：

- 2 部署的是 `-Target`（預設 `..\token-monitor-release`）現在的內容，不會重新產生。還不是 release 資料夾（沒有 `RELEASE-INFO.txt`）時會停下來，請先執行 1。
- release 資料夾的 commit 不是這個 checkout 的 `HEAD` 時會提醒，但照樣部署。
- 2 加 `-Ref <分支、tag 或 commit>` 時，先以那個版本重新產生 release 資料夾再部署，等於先跑 `1.token-monitor-release.ps1 -Ref …`。
- 3 一律先重新產生：`-Ref` 預設 `HEAD`，所以不加參數就部署已 commit 的 `HEAD`。要像 2 一樣部署 release 資料夾現在的內容，例如 1 用 `-Ref` 產生的別的版本，改加 `-AsIs`（不能和 `-Ref` 一起用）。
- `.env` 的處理不變：2 仍然換上 checkout 的 `.env`，3 仍然上傳 checkout 的 `.env.ubuntu`（見下方）。

兩個 `install-runner-*.ps1` 註冊 runner 用的 token 放在 `.env.runner`（範例 `.env.runner.example`，不進版控），或用 `-Token` 傳入；已經註冊過的 runner 不需要 token。重複執行是安全的，已經裝好的會保留。

release 資料夾裡也有一份 `deploy/`，可以在那裡直接執行 `2.deploy-local.ps1` 或 `3.deploy-ubuntu.ps1`：這時部署的就是這個資料夾現在的內容，不會重新產生，也不需要 git，所以 `-Ref`、`-Target` 不適用。上傳到 Ubuntu 時不帶本機的 `.env`、`data/` 與 `backups/`。要更新 release 資料夾，可以回到本 repo 的 checkout 執行 `1.token-monitor-release.ps1`，也可以直接在 release 資料夾裡執行它：這時會列出 `RELEASE-INFO.txt` 記的 `source` checkout 與它的 git worktree，讓你輸入編號或路徑選一個，再以它的 `-Ref`（預設 `HEAD`）重新產生這個資料夾，一樣保留 `.env`、`data/` 與 `backups/`；直接按 Enter 取消。`-Force` 不問、直接用記錄的 `source`，`-Source <路徑>` 不問、用指定的 checkout。

Windows 預設不允許執行 PowerShell 腳本。可以用 `powershell -ExecutionPolicy Bypass -File .\deploy\2.deploy-local.ps1` 只放行這一次，或執行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，讓自己的帳號可以執行本機的腳本。`deploy-ubuntu.cmd` 已經這樣放行，不受這個限制。

`1.token-monitor-release.ps1` 與 `2.deploy-local.ps1` 會把本 repo checkout 的 `.env`（或 `-EnvFile` 指定的檔案）當成 release 資料夾的 `.env`：release 資料夾裡已有不同的 `.env` 時，舊的先存到 `backups/env-<時間>.bak` 再換掉；兩份的 `POSTGRES_PASSWORD` 或 `TOKEN_MONITOR_DB_PASSWORD` 不同時會停下來，因為資料庫只認建立時的密碼。checkout 沒有 `.env` 時才走下面的「第一次部署」。

兩個部署腳本都會：

- Docker Desktop 沒有在跑時自動打開，最多等 3 分鐘。
- **第一次部署**時從 `.env.example` 產生 `.env`，`TOKEN_MONITOR_SECRET`、`TOKEN_MONITOR_CLIENT_SECRETS` 與資料庫密碼都用隨機值，並打開 `TOKEN_MONITOR_PUBLIC_DASHBOARD=1`，讓使用者不用金鑰就能在 dashboard 看用量。代價是內網任何連得到 hub 的人都看得到全公司的用量（使用人數與活躍裝置的明細列出姓名、主機名稱與各自的用量，帳號排行列出每個 AI 帳號的 email 與用量；員工的 email、員工編號與個人用量檢視仍然只給管理員；只有一兩個人的單位，單位的數字實際上就是那個人的用量，最小人數門檻還沒有實作），要關掉就把 `.env` 那一行註解掉再部署一次，細節見 [docker.md](docker.md)「這裡的 secret 不是可選的」。之後一直沿用同一份 `.env`。要用現成的 `.env` 就加 `-EnvFile <路徑>`。資料庫 volume 已經存在、`.env` 卻不見時會停下來，因為新密碼進不了舊資料庫。
- 資料庫容器在跑時，先把 `pg_dump` 備份寫到 release 資料夾的 `backups/`（`-SkipBackup` 跳過）。hub 自己每天的備份在另一個 volume `hub-backups`，和這份無關。
- 把原本的 `token-monitor-hub:latest` 留成 `:previous`。回滾：`docker tag token-monitor-hub:previous token-monitor-hub:latest`，再 `docker compose … up -d`；有新 migration 的版本要先還原備份（[postgres.zh-TW.md](postgres.zh-TW.md)「備份與還原」）。
- 等 `/api/health` 回應後印出網址。
- `-SkipBuild` 不建映像，改用現有的 `token-monitor-hub:latest`，例如 `npm run build:image` 發行的那一版。

Ubuntu 部署的帳號與密碼：

- 帳號在執行時詢問，或用 `-User` 帶入；主機用 `-Server`、`-SshPort` 換，預設值寫在 `3.deploy-ubuntu.ps1` 開頭的參數。
- 密碼只留在記憶體，給這次的 ssh、scp 使用，帳號不在 `docker` 群組時也給 `sudo` 用。直接按 Enter 則改用 SSH 金鑰。
- 輸入後先登入一次確認。帳號、密碼打錯或連不上主機時，在建映像之前就停下來。
- 第一次連線時自動接受主機金鑰（`StrictHostKeyChecking=accept-new`），之後主機金鑰變了會拒絕連線。

Ubuntu 的 `.env`：

- 本 repo 的 checkout 有 `.env.ubuntu`（或用 `-EnvFile` 指定）時，每次部署都會上傳它，換掉伺服器的 `.env`，舊的存到伺服器的 `backups/env-<時間>.bak`。沒有這個檔案時，伺服器沿用自己的 `.env`。
- `.env.ubuntu` 裡的 `POSTGRES_PASSWORD`、`TOKEN_MONITOR_DB_PASSWORD`、`TOKEN_MONITOR_DB_READONLY_PASSWORD` 留空，就沿用伺服器現有的值；新資料庫則自動產生。填了卻和伺服器不同時會停下來，因為資料庫只認建立時的密碼。
- 要讓其他電腦直接連 PostgreSQL，在 `.env.ubuntu`（與 `TM_HUB_ENV`）設 `POSTGRES_HOST_BIND=0.0.0.0`，並先在主機上執行 `deploy/postgres-lan-firewall.sh`（[postgres.zh-TW.md](postgres.zh-TW.md)「從其他電腦連線」）。
- `-ResetDatabase` 先備份（`-SkipBackup` 則不備份），再刪除伺服器的資料庫 volume 與所有用量資料，以 `.env` 的密碼建一個空的資料庫。執行時要輸入伺服器位址確認。hub 內建的備份在 volume `hub-backups`，不會被刪掉。

### 從 GitLab 部署

`.gitlab-ci.yml` 的 `deploy:hub` 在 GitLab 上部署 hub，不需要 Windows 與 SSH 帳密。到 CI/CD → Pipelines，在下面兩種 pipeline 裡按 `deploy:hub` 的 ▶：

- **發行的版本**：`npm run build:image` 推出 `corp/v<版本>` tag，它的 pipeline 跑完 `verify` 與 `build:hub`（建映像 `token-monitor-hub:<版本>`、冒煙測試、存到 Package Registry）之後，按 `deploy:hub` 部署那一版。見 [packaging.zh-TW.md](packaging.zh-TW.md)。
- **main 的最新 commit**：推到 main 不會跑 pipeline，先按 **Run pipeline**（分支選 `main`），跑完 `verify` 之後按 `deploy:hub` 會以那個 commit 建映像 `token-monitor-hub:<上游版本>-main.<commit>` 再部署，沒有冒煙測試，適合試用還沒發行的改動。

兩者都是：

- 跑在 hub 主機上的 `hub-deploy` runner（shell executor），直接用主機的 Docker。
- 執行 `deploy/server-deploy.sh`，也就是 `3.deploy-ubuntu.ps1` 在伺服器上做的那一半：備份資料庫、換上 `.env`、把原本的 `latest` 留成 `:previous`、`docker compose up -d`、等 `/api/health`。
- 一定先備份資料庫，也不會刪除資料庫：job 把 `RESET_DATABASE` 與 `SKIP_BACKUP` 固定為 0，CI/CD 變數改不了。要清空資料庫只能用 `3.deploy-ubuntu.ps1 -ResetDatabase`，它會要你輸入伺服器位址確認。
- release 資料夾是主機的 `/opt/token-monitor`，`.env` 與 `backups/` 也在那裡。要換位置，設 CI/CD 變數 `TM_HUB_DEPLOY_DIR`。
- 同一時間只會有一個部署在跑。Operate → Environments → `hub/production` 列出每一次部署，對舊的那次按 re-deploy 就是重新部署那個 commit。有新 migration 的版本要先還原備份（[postgres.zh-TW.md](postgres.zh-TW.md)「備份與還原」），因為舊版 hub 看到比較新的 schema 會拒絕啟動。

第一次設定：

1. GitLab 的 Settings → CI/CD → Runners → New project runner：tag `hub-deploy`、Run untagged jobs 關、**Protected 開**。這個 runner 的 job 能操作主機的 Docker，等於有主機的 root，所以只接 protected 的分支與 tag，merge request 的 job 不會跑到它上面。token 放進 `.env.runner` 的 `TM_RUNNER_TOKEN_HUB_DEPLOY`。
2. 執行 `.\deploy\install-runner-ubuntu.ps1 -HubDeploy`，在 hub 那台 Ubuntu 註冊 shell runner：
   - 用自己的 `/etc/gitlab-runner/hub-deploy.toml` 與 systemd 服務 `gitlab-runner-hub-deploy`，不動 `ubuntu` runner。
   - 缺的話安裝 git 與 Node.js 22（NodeSource）。
   - 把 `gitlab-runner` 加進 `docker` 群組，建立 `/opt/token-monitor`。
3. GitLab 的 Settings → CI/CD → Variables 新增 `TM_HUB_ENV`：Type **File**、Environment `hub/production`、Protected 開、Expand variable reference 關，值是 `.env.ubuntu` 的完整內容。
   - 它就是伺服器的 `.env`，處理方式和上面「Ubuntu 的 `.env`」相同，例如資料庫密碼留空就沿用伺服器現有的值。
   - 沒有設定時，伺服器沿用 release 資料夾裡的 `.env`。
   - 改了 `.env.ubuntu` 要一併更新這個變數。
4. Settings → Repository → Protected tags 保護 `corp/v*`，只讓 Maintainers 建立。tag 的 pipeline 要是 protected 的，才拿得到 Protected 的 runner 與 `TM_HUB_ENV`；不保護的話，`hub-deploy` runner 不會接 `build:hub` 和 `deploy:hub`：tag pipeline 的 `verify` 一開始就會失敗，說要保護 `corp/v*`。保護之後，到 Build → Pipelines 按 Run pipeline、選那個 tag 重跑一次；原本那條 pipeline 不會因為事後保護而動起來。
5. 建議在 Settings → CI/CD → Protected environments 保護 `hub/production`，只讓 Maintainers 部署。

和 `3.deploy-ubuntu.ps1` 並存：兩者操作同一組容器與 volume（compose 的 project 名稱固定是 `token-monitor`），只是 release 資料夾不同，一個是 `/opt/token-monitor`，一個是 SSH 帳號的 `~/token-monitor-release`。最後部署的那一個生效。

### 部署後：發給用戶端的金鑰

有 `.env.ubuntu` 時，client 金鑰就是它的 `TOKEN_MONITOR_CLIENT_SECRETS`。沒有時，伺服器上的 `.env` 是第一次部署時自己產生的，跟本機 `.env` 的金鑰不同。從伺服器讀出 client 金鑰（`-RemoteDir` 換過就改路徑）：

```powershell
ssh <SSH 帳號>@192.0.2.10 "grep ^TOKEN_MONITOR_CLIENT_SECRETS= ~/token-monitor-release/.env"
```

- `=` 後面的值就是用戶端「多裝置同步」的「密鑰」；逗號分隔的多把只要給其中一把。
- 不要發 `TOKEN_MONITOR_SECRET`，那是 admin 金鑰。
- hub 前面有把 http 轉到 https 的反向代理時，用戶端的 Hub URL 要直接填 `https://…`。轉址會讓 fetch 丟掉 `Authorization`，用戶端就一直顯示「Wrong or missing secret」，上傳也會失敗。
- 其他欄位見 [client-setup.zh-TW.md](client-setup.zh-TW.md)。

## 開發規則

1. 程式、測試（`tests/`）與文件（`docs/`）都在本 repo 的根目錄；`upstream/` 不改。
2. 讀上游程式一律 `require(upstream('src/…'))`，不要寫 `../upstream/src/…` 這種相對路徑：上游的位置只寫在 `upstream.js`。
3. 只在本機的檔案（`.env`、`.env.client`、`data/`、`tmp/`、`dist/`、人事公告 `docs/dept/`）已經列在 `.gitignore`。
4. 功能異動（新功能、行為或設定改變、路由、部署或發行方式）在同一個 commit 裡記進 [CHANGELOG.md](../CHANGELOG.md) 的「未發行」，並更新對應的文件。發行時 `npm run build:image` 會把「未發行」改成那一版的 `corp/v<版本>` 與日期。
5. commit 前先 `npm run verify`；commit 格式與其他慣例見 [AGENTS.md](../AGENTS.md)。
6. 改 overlay 永遠不需要上游的 `npm run update:hub-build`：上游的 `src/hub/server.js` 沒變，上游註冊的 build id 仍然正確。
