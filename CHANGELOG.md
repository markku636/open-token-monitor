# 功能異動紀錄

hub 與 Electron 用戶端打包（`X.Y.Z-corp.N`）的功能異動，新的在上面。Rust 用戶端的異動見 [tauri/CHANGELOG.md](tauri/CHANGELOG.md)，上游本身的異動見[上游 repo](https://github.com/Javis603/token-monitor/releases)。

- 功能異動一律寫在「未發行」底下。
- 發行時，`npm run build:image` 會把「未發行」改成那一版的 tag 與日期，例如 `## corp/v0.63.1-corp.1（2026-10-01）`，在上面開一個新的「未發行」，並把這一段寫進 `docs/releases/<版本>.md`（[packaging.zh-TW.md](docs/packaging.zh-TW.md)）。
- `corp/v<版本>` tag 就是那一版的原始碼。

## 未發行

- 組織名單不再需要人事公告（[hub.zh-TW.md](docs/hub.zh-TW.md)「組織與裝置歸屬」）：
  - 管理頁的「匯入人事公告」改成「組織名單」：輸入公司代碼後直接在網頁上編輯（新增、刪除、從 Excel 貼上多列），預覽差異後儲存。
  - 「下載 Excel」：那家公司目前的名單，新公司是空白範本，欄位是員工編號、姓名、Email、部門；填好拖回來匯入。檔名開頭不是公司代碼時，用輸入的公司。
  - 匯入讀得懂中文表頭（員工編號、姓名、Email、部門、團隊）與單一的「姓名」欄；人事公告照舊能匯入。
  - 新路由：`GET /api/admin/org/roster`、`POST /api/admin/org/roster[/preview]`、`GET /api/admin/org/roster.xlsx`，都只限管理員。
- Dashboard 的組織只分兩級：公司 → 部門（[hub.zh-TW.md](docs/hub.zh-TW.md)「組織與裝置歸屬」）。
  - 篩選列只剩公司與部門，比較的層級只有公司與部門；團隊算在所屬部門，BU 不顯示。舊網址的 `bu=`、`team=` 不再作用。
  - 人、裝置與帳號的單位顯示成「公司 / 部門」；部門清單、匯入預覽與 email 歸類也只列公司與部門，email 只能歸到部門（之前歸到團隊的規則照常有效）。
  - 資料不變：匯入仍讀 BU 與團隊欄，資料庫照舊存四層。`GET /api/custom/usage` 與 `usage/analysis` 預設只比公司與部門、單位路徑不含 BU，`level=bu|team` 仍可指定；組織樹、員工清單與 `reports:read` 的報表不變。
- README 預設改成繁體中文（`README.md`），英文版移到 `README.en.md`，截圖更新為兩級組織。
- 用戶端改從 GitHub 發行與更新（[client-build.zh-TW.md](docs/client-build.zh-TW.md)「從 GitHub 發行」）：
  - 推 `client-v*` tag 到 GitHub，`.github/workflows/client-release.yml` 跑 verify、打包 Windows、macOS、Linux，並建立 GitHub Release。
  - repo 是公開的，所以這些安裝檔不帶 hub URL 與金鑰（新設定 `TM_CLIENT_NO_HUB=1`），使用者在「多裝置同步」自己填。
  - 新設定 `TM_CLIENT_UPDATE_GITHUB_REPO=owner/repo`：app 從那個 repo 最新的 Release 更新。只能搭配 `TM_CLIENT_NO_HUB=1`，帶著金鑰時打包會失敗。
  - GitLab 的發行與更新方式不變。
- 首次開源（2026-10-03）：一個 monorepo 包含三部分。
  - hub overlay：PostgreSQL、組織資料、dashboard、報表 API 與部署腳本，見 [docs/hub.zh-TW.md](docs/hub.zh-TW.md)。
  - Electron 用戶端打包：見 [docs/client-build.zh-TW.md](docs/client-build.zh-TW.md)。
  - Rust/Tauri 用戶端：見 [tauri/](tauri/README.md)。
- 上游 Javis603/token-monitor 以 git subtree 放在 `upstream/`，目前是 `v0.63.1`，直接從 GitHub 拉，不需要鏡像。
- 升級上游：
  - `npm run upstream:status` 比對目前版本與上游最新版。
  - `npm run upstream:update -- <next|vX.Y.Z|latest>` 拉新版並跑 verify。`next` 一版一版升，跳過中間的版本要加 `--allow-skip`；verify 沒過時結束代碼是 3。
  - `npm run upstream:impact` 依 `upstream-touchpoints.json`、overlay 的 `upstream('…')` 與 `tauri/` 的註解，列出要檢查的檔案，以及上游新增或移除的 hub 路由與 `TOKEN_MONITOR_*` 設定。
  - `npm run smoke:hub` 起一個驗證用的丟棄式 hub：PGlite、測試金鑰與假資料，不需要 Docker。
  - 流程寫在 [docs/upstream-upgrade.zh-TW.md](docs/upstream-upgrade.zh-TW.md)、[AGENTS.md](AGENTS.md)「升級上游」，以及 Claude Code 的 `/upstream-update` skill。
  - GitHub Actions 每週檢查上游，有新版就開 PR。
- Dashboard（[hub.zh-TW.md](docs/hub.zh-TW.md)「Dashboard」）：
  - 繁體中文與英文，依瀏覽器語言，標題列可以切換，`?lang=en`、`?lang=zh-TW` 直接指定；和 `/install` 共用同一個選擇。
  - 「總覽」：同時列出 Token 與等值成本的每日趨勢、模型分布與員工用量。「指標」切換移到「趨勢」的標題列，只換趨勢的圖與表格。
  - 「帳號排行」取代帳號比較，不用登入也看得到：每個 AI 帳號依 Token 排名，跟著篩選列走。
  - 員工用量的「沒有對應到員工」可以點開，整頁只算當天沒有算給任何員工的用量（API `unowned=1`）。
  - 活躍裝置明細與 AI 工具額度裡的主機名稱可以點，捲到下方「裝置」並展開那一台；活躍裝置明細拿掉「使用者」欄。
  - 帳號與裝置跟著整個篩選列（期間、其他、沒有對應到員工、員工、工具），不只跟著單位。
  - AI 工具額度：每家供應商各自排序，再按一次反過來；拿掉「重置時間」排序；沒花錢的 Usage credits 帳單週期不列。
  - live／stale 的說明改成馬上出現的提示框；拿掉「比較」選單與「本期」按鈕，一律和上一期比；左上角的標題回到預設畫面。
- 管理移到獨立的一頁 `/admin`，有可以收合的左側列，依組織資料、對外整合與系統維護分組。
- 安裝說明頁 `/install`：繁體中文與英文；Windows 與 macOS 分頁改成圖解教學，每一步旁邊用 HTML／CSS 畫出那個視窗（不是截圖）。
- 報表 API 多了 scope `analytics:read`：組織樹、員工清單（只有英文名）、AI 帳號的額度視窗與用量分析；英文說明 `/llms.txt`、`/llms-full.txt` 與 OpenAPI 3.1（`/api/reports/v1/openapi.json`），見 [reports-api.zh-TW.md](docs/reports-api.zh-TW.md)。
- PostgreSQL 可以開給其他電腦直接連線：`POSTGRES_HOST_BIND=0.0.0.0`，搭配 `deploy/postgres-lan-firewall.sh` 限制來源網段（[postgres.zh-TW.md](docs/postgres.zh-TW.md)「從其他電腦連線」）。
- 公司版用戶端（[client-build.zh-TW.md](docs/client-build.zh-TW.md)）：
  - widget 只顯示這台電腦的用量（`TM_CLIENT_OWN_DEVICE_ONLY`，預設開），上傳不變。
  - 開機自動啟動時把 widget 縮到工作列（`TM_CLIENT_START_MINIMIZED`）；每台電腦第一次開啟時打開「保持在工作列上方」；系統匣與選單列預設只顯示圖示。
  - macOS 也從 GitLab Release 自動更新，不需要 Apple 憑證（`packaging/macAfterSign.js` 重新做 ad-hoc 簽章）。
  - Release 說明改成中英文，安裝步驟連到 hub 的 `/install`。
  - electron-builder 遇到網路錯誤時等一下再試；GitLab 的發行與部署上傳、下載遇到網路短暫中斷也會重試。
- `corp/v*` tag 沒設成 protected 時，tag pipeline 的 `verify` 直接失敗並說明原因，不再卡在 pending。
- 用戶端不附 logo：沒有 `client/assets/`、`client/build/icon-win.ico`、`client/electron/title-logo.png` 時沿用上游的圖示，要換自己的 logo 見 [client/README.md](client/README.md)。
