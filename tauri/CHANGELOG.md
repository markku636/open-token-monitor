# Changelog

## 0.2.0 — GitHub 發行

- GitHub 發行：`client-v*` tag 會同時打包 Rust 版 `Token-Monitor-Rust_<版本>_x64-setup.exe`，和 Electron 版放在同一個 Release。安裝檔不帶 hub 與金鑰，從該 repo 最新 Release 的 `latest.json` 自動更新（新的編譯時常數 `TM_UPDATE_GITHUB_REPO`，`build-installer.ps1 -GitHubRepo/-DownloadBase`，`make-latest-json.mjs --download-base`）；「查看完整版本資訊」開 GitHub 的最新 Release。
- 設定頁「公司 hub」：沒有內建 hub 的安裝檔（GitHub 發行、本機模式）直接顯示位置與金鑰的輸入欄，不必先點「覆寫位置或金鑰」；按鈕改成「清除」。

## 未發佈 — M3

- 最低 Rust 版本改成 1.88（`Cargo.toml` 的 `rust-version` 與 CI）：鎖定的相依（darling 0.24、image 0.25.10、time 0.3.55 等）需要 1.88，CI 原本釘在 1.85 而編不過。
- 打包修正：`build-installer.ps1` 改用 `npm.cmd` 執行 `tauri build`（npm 11 的 `npm.ps1` 會把 splatting 的參數解析成 `pm`）；`package-lock.json` 補上 vitest 的 esbuild 0.28.2 平台套件（原本標成 extraneous，npm 11 的 `npm ci` 會拒絕）；配合 Rust 1.96 的 clippy 簡化 `tm-agent` 參數判斷。
- 已知差異：廠商圖示、遮罩與介面主題照 2026-09-24 的上游 main 移植，還沒跟上 v0.63.1 的 `vendorPresentation`／`rowIconMasks.js` 重構；相容測試裡對照這些的六項暫時標成 todo（[architecture.md](docs/architecture.md)「v1 與上游的已知差異」）。
- 動態效果（上游 Reduce Motion 與資料動畫）：總數從舊值數到新值（1 秒，切換期間 0.8 秒；啟動時從 0 數上來），清單的長條與數字跟著變化、排名變動時整列滑動，切換檢視時長條從零長出；主頁的活動模組進入時熱力圖由左到右淡入、趨勢線畫出，熱力圖可拖曳捲動、滑過時有聚光與提示；趨勢視圖的期間長條長出，點長條開啟用量儀表板；儀表板的趨勢區重新顯示熱力圖與趨勢線（視窗有焦點時才淡入），每日用量圖與工具、模型長條也有動畫。視窗看不到時先不畫，打開時才從上次看到的數字動過去。設定頁「一般」的「減少動態效果」可選跟隨系統、開啟或關閉。新設定：`reduceMotion`（`system` / `on` / `off`，預設 `system`），與上游同名。
- 主頁（上游 Home）：widget 預設打開主頁，依序顯示額度、模型與活動（熱力圖＋最近 45 天趨勢），設定頁新的「主畫面」可打開工具與裝置模組、調整順序與隱藏、選主頁額度的提供者與顯示帳號數；點模組跳到對應視圖並可「返回主頁」。視圖切換改成底欄的循環按鈕（點一下換下一個，長按、右鍵或滑到箭頭打開選單），可調整視圖順序與隱藏；服務狀態移出額度分頁成為獨立的「狀態」視圖，與上游一樣預設隱藏（要看時在設定頁「主畫面」打開）。熱力圖與趨勢線從趨勢分頁搬到主頁的活動模組，趨勢視圖只留依期間的長條與統計；熱力圖依 token 或成本上色改成設定（原本選 token 的會自動沿用）。新設定：`viewDisplayOrder`、`hiddenViews`（預設 `status`）、`homeModuleOrder`、`hiddenHomeModules`（預設 `tool,device`）、`showHomeLimitBars`、`showHomeLimitProviderNames`、`homeLimitProviderOrder`、`hiddenHomeLimitProviders`、`homeLimitAccountCount`（預設 3）、`homeActiveDaysWindow`（預設 `all`）、`heatmapMetric`（預設 `cost`），與上游同名。
- 工具圖示（上游 Tool Icons）：工具、模型、session、專案、全公司的裝置與工具明細、服務狀態的清單前面，顯示各工具與模型廠商的圖示（取自上游，顏色跟著文字）；進行中的 session 在圖示右下角標綠點。設定頁「外觀」的「工具圖示」可以關閉，關閉時改回色點。新設定：`showToolIcons`（預設開），與上游同名；另外先加上標題列用的 `showLiveDot`（預設開）、`titleIconOnly`（預設開）、`settingsInTitlebar`（預設關），名稱與預設同上游，settings.json 與 Electron 版互通，標題列還沒照它們呈現。
- 版本說明連結：更新提示的版本說明與設定頁「更新」多了「查看完整版本資訊」，用瀏覽器開 hub 的版本頁（`/downloads/releases#v<版本>`；本 repo 根目錄的 hub 目前沒有這一頁）；檢查、下載或安裝失敗時設定頁有「查看 release」可以手動下載。已下載的版本在沒有版本說明時，點版本號改為開版本頁，安裝只走「重新啟動」，與上游相同。
- 介面主題（上游 Appearance）：設定頁新的「外觀」區塊可選預設、黑曜、瓷白三種配色，或在「進階自訂」改強調色、背景、文字、次要文字；「主題代碼」可複製或貼上 `TM1-…`，與 Electron 版互通；「廠商色」可覆寫每個工具與模型廠商在清單與圖表的顏色。預設配色與品牌色改成與上游相同（儀表板把近黑的品牌色提亮），模型依廠商上色，趨勢圖與熱力圖不再跟著強調色。原本的「主題」改稱「色彩模式」並移到「外觀」，只在沒有自訂背景色時決定明暗；淺色時的底色就是「瓷白」，設定頁的色格與複製的主題代碼都照畫面上的配色。新設定：`themeColors`、`vendorColors`（預設 `{}`），與上游同名。
- 修正：匯出的資料夾裡有檔案被 Excel 開著時不再每次留下暫存檔；儀表板在換幣別後會更新金額；儀表板換期間、邊緣額度條打開額度分頁不再把 widget 下次開啟的期間與分頁蓋回舊值；全公司範圍不再每分鐘閃一次「載入中」、午夜剛過不會重複算昨天、hub 失敗時不會每幾秒重打；「忽略此版本」記在設定（新設定 `appUpdateDismissedVersion`），自動下載會跳過它、手動檢查才解除（與上游相同），下載中不能忽略；安裝失敗會顯示原因；未分類的工具／模型列也能展開 token 組成；專案顏色與上游一致；token 數字在單位交界不再顯示「1000K」；全部期間的每月長條只畫最近 12 個月；版本說明只去掉真的 HTML 標籤並解碼實體；服務狀態的「N 秒前」取整、切換分頁回來時照設定的間隔決定要不要重查；新增模型別名時以相同的比對鍵取代舊的。
- session 逐回合明細（上游 Session detail）：Session 清單裡 Claude Code、Codex、OpenCode 的 session 可以點開，依每則提問分組，展開看每一輪 AI 回覆的輸入、輸出、快取、推理 token 與用到的工具，可依時間或 token 排序；成本依 token 比例分攤（OpenCode 用真實成本）。只讀本機紀錄，不上傳。
- `tm-agent session-detail <client> <session-id> [--period] [--cost]`：印出同一份明細（JSON），排查用。
- 全公司分頁也有本星期、最近 7 日、最近 30 日（上游的 WEEK / 7D / 30D）：列出每台電腦在這段範圍的用量，由它自己上傳的每日歷史、即時的今日與它自己的日期算出，點開看各工具的占比；總數是各台相加，看得到工具與模型的拆分。沒有可用每日歷史的電腦（即時數字是 0 也一樣，範圍內仍可能有用量）不計入，清單上會標出來，底下註明台數（上游在這種情況整個範圍不顯示）。需要有 `GET /api/custom/device-daily` 的 hub（本 repo 根目錄的 hub 目前沒有）；沒有這個路由的 hub 仍只看全公司的總數與工具、模型的拆分（hub 的 `/api/history` 加上全公司即時的今日）。
- 用量儀表板多了「每日用量」圖（上游儀表板的 Trends）：最近 7／30／90 天、1 年或全部，可選依工具或依模型堆疊的每日長條（附圖例與占比），或每根代表數天的 K 線（開、高、低、收）。
- 模型別名（上游 Model aliases）：設定頁「顯示」可以自動合併同一模型的不同寫法（合併重複／移除前綴），或手動把某個模型 id 合併成另一個名稱；widget 的模型清單、工具下的模型、session 與全公司的裝置明細都照別名顯示。只影響畫面，上傳與匯出保留原本的模型 id。新設定：`modelAliases`、`modelAliasGrouping`（預設 `off`），與上游同名。
- 服務狀態（上游 Status 視圖）：額度分頁底部顯示 Claude、OpenAI、Cursor、DeepSeek 官方狀態頁的正常／降級／中斷、進行中的事件與受影響的組件，點一下開官方狀態頁。顯示時每分鐘檢查（設定頁「顯示」可改間隔或只手動）。新設定：`serviceStatusRefreshMs`（預設 60000），與上游同名。
- 資料匯出（上游 Data export）：設定頁「資料匯出」可以自動匯出到資料夾（每 30 秒到 60 分鐘，資料沒變就不重寫），或選一個資料夾手動匯出一次。產出 `token-monitor-export.json`（三個期間與每日歷史，無損）與 `token-monitor-snapshot.csv`、`token-monitor-daily.csv`、`token-monitor-daily-models.csv`（UTF-8 BOM、CRLF，Excel 直接開），格式與上游相同；不含其他裝置與額度。新設定：`exportAutoEnabled`（預設關）、`exportDir`、`exportIntervalMs`（預設 60000），與上游同名。
- 新相依：`tauri-plugin-dialog`（選資料夾的系統對話框；Tauri 官方 plugin，只在 GUI 建置）。
- 幣別換算（上游 currency.js / exchangeRates.js）：設定頁「顯示」的「貨幣」可選 USD、TWD、HKD、CNY，所有成本依匯率換算顯示（成本本身仍以美金計算）。匯率自動抓每日匯率（fawazahmed0 currency-api 的 jsDelivr 與 Cloudflare Pages 鏡像，每 6 小時檢查、快取在設定資料夾的 `exchange-rates.json`），抓不到時用快取或內建值；也可以手動設定。新設定：`currency`（預設 `USD`）、`currencyRates`（手動匯率），與上游同名。
- 全公司分頁點一台電腦可以展開（上游 Devices 視圖的明細）：依工具的占比與 token、各工具的模型，以及系統、程式版本與多久前同步。
- 更新提示改成上游的樣式：有新版時 widget 底部顯示「↑ v版本」，下載中顯示百分比，下載好後可按「↻ 重新啟動」；點版本號看版本說明（`latest.json` 的 notes，照上游規則解析 `### 標題` 與 `- 項目`，也支援 `<!-- app-update-notes:zh-TW:start -->` 分語言的區段），× 可以忽略這個版本。設定頁的「更新」也顯示版本說明。
- Token 速率（上游 tokenRatePresentation.js）：總數下方顯示期間的平均生成速度（≈ tok/s，點一下改成 tok/min）；設定頁新的「顯示」區塊可開啟底欄的即時速率，以兩次掃描之間新增的生成時間計算，8 秒後變暗、3 分鐘後顯示「—」。新設定：`showLiveTokenRate`（預設關）、`tokenRateMode`（`speed` / `burn`，預設 `speed`），與上游同名。
- 期間多了本星期、最近 7 日、最近 30 日（上游的 WEEK / 7D / 30D）：已經選在「本月」時再點一次，可從選單切換；由每日歷史加總、今天用即時數字，看得到工具與模型的拆分與 token 組成（沒有專案與 session 明細）。一週從星期幾開始依系統的地區設定。趨勢分頁選在範圍時，活躍時間與峰值單日是那個範圍的。
- 新的「趨勢」分頁（上游 widget 的 Trends 視圖與主頁的「活動」）：滾動一年的熱力圖（可依 token 或成本上色）、最近 45 天的趨勢線與峰值，以及依期間的長條（今日看近 7 天、本月看每天、全部看每月）與活躍天數、連續天數、活躍時間、峰值單日。資料是本機的每日歷史，今天那格用即時數字；每日歷史關閉時不顯示這個分頁。
- 本機分頁的清單多了「專案」與「Session」（上游 widget 的 Projects、Sessions 視圖）：專案依成本排序、長條是各工具比例的漸層，展開看各工具的 token；session 依最近使用排序、一頁 100 筆，10 分鐘內有活動的標綠點，Codex 的背景審查合成一列「Codex 自動審查」。工具列展開可切換 token 組成（快取命中／未命中、輸出）與模型拆分，模型列展開看 token 組成。專案統計關閉時不顯示「專案」。
- 英文介面：設定頁「語言」可選自動（跟隨系統）、繁體中文或 English；widget、設定視窗、tray 與 tooltip 都會換。
- 淺色主題：設定頁「外觀」的「色彩模式」可選跟隨系統、深色或淺色。
- 新設定：`theme`（預設 `system`）。視窗模式的「一般」改稱「標準」。
- 每日用量歷史：每 15 分鐘（以及啟動、手動重掃、換日時）以 `tokscale graph` 掃出每天、每個工具與模型的用量，隨上傳送到 hub，hub 的熱力圖、`/api/history` 與日報表就有這台電腦；本機分頁多了「近 30 天」長條圖與連續使用天數。設定頁「每日歷史」可以關閉或改間隔；`tm-agent` 支援 `TOKEN_MONITOR_HISTORY_ENABLED`、`TOKEN_MONITOR_HISTORY_INTERVAL_MS`（與上游 agent 相同）。
- 新設定：`historyEnabled`（預設開）、`historyIntervalMs`（預設 900000）。
- `TOKEN_MONITOR_LIMITS_ENABLED` 與上游一樣接受 `false` / `no` / `off`。
- 保持在工作列上方（實驗性，Windows）：浮動模式下把 widget 拖到工作列上，切換 app 後 widget 仍留在工作列上面（上游 #533 的做法：重疊時每 250 ms 重新置頂，加上前景事件 hook）。設定頁「一般」可開啟；`keepAboveTaskbar` 預設改為關，與上游相同。
- 新相依：`windows`（與 Tauri 同一個版本與 feature，沒有多編譯任何東西）。
- 全域顯示／隱藏快捷鍵：設定頁「一般」錄製組合鍵（至少搭配 Ctrl、Alt 或 Win），Esc 取消、Backspace 清除；被其他程式占用時顯示「無法註冊」。新設定 `windowToggleShortcut`（預設關閉），格式與上游相同。
- 玻璃效果：widget 背後的 Windows acrylic 模糊（新設定 `systemGlass`，預設開，與上游相同），Windows 11 以 OS 畫反鋸齒圓角並拿掉 1px 系統邊框。
- 縮放 70–160%：設定頁滑桿，或在 widget 上按 Ctrl + = / - / 0（新設定 `zoomFactor`）。
- 新相依：`tauri-plugin-global-shortcut`。
- 系統匣：圖示可改成「額度長條」（最接近上限的工具，上面 5 小時、下面每週的已用比例；墨色跟著工作列的淺色／深色），tooltip 多一行額度；右鍵選單新增「開啟 ▸ 本機／全公司／額度」、「視窗模式」與「系統匣顯示」子選單。新設定 `trayContent`（`icon` | `bars`，預設 `icon`）。
- 系統匣模式（視窗模式「系統匣」）：widget 平常隱藏，按 tray 圖示或快捷鍵時在圖示旁彈出，失去焦點就收起來（上游的 tray presentation）。`windowMode` 多一個值 `tray`。
- 浮動泡泡：浮動模式下 widget 失去焦點就縮成螢幕邊緣的小把手（顯示今日 token），按一下展開、可拖著移動，在 widget 上按 Esc 立刻收合。新設定 `floatingBubbleEnabled`（預設關，與上游相同）。
- 邊緣額度條（上游 Edge Dock 的精簡版）：主螢幕左或右邊緣的細條，游標碰到就展開成各工具 5 小時與每週的額度圓環，點圓環開啟額度分頁。新設定 `edgeDockEnabled`（預設關）、`edgeDockSide`、`edgeDockOffset`。
- 系統匣圖示多一種「各工具 5 小時」（上游 `barsAllSessions`：上面 Claude Code、下面 Codex）；`trayContent` 多一個值 `barsSessions`。
- widget 標題列的釘選鈕：浮動 → 標準 → 桌面輪流切換（上游的 pin button）。
- 保留已刪除的 session（上游 session usage archive）：Claude Code 等工具刪掉舊紀錄後，那些 session 的用量仍算進本月與全部（以 `archived: true` 補回，hub 也看得到）。history 的日子也一樣保留（上游 daily history archive，`daily-history-archive.json`），hub 的熱力圖不會因為 transcript 被刪而少一塊。存在設定目錄的 `session-usage-archive.sqlite`。新設定 `sessionUsageArchiveEnabled`（預設開，與上游相同）；`tm-agent` 支援 `TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED`。
- Cursor 額度：方案的兩個模型池（Cursor Models／Other Models）或每月請求數、Grok Bot 週額度、團隊共用池與 on-demand 花費（上游 providers/cursor）。帳號是 tokscale 的 Cursor 帳號檔（桌面版登入時自動寫入）；只用 Cursor CLI 的人可以在設定頁「額度」貼上 token。`limitProviders` 多一個值 `cursor`，預設開。
- 窗口排序照上游：Cursor 依官方 dashboard 的順序、Antigravity 依模型群組。
- `tm-agent`：上游 agent 的呼叫方式也能用（`--once`、`--dryRun`、`--hubUrl`、`--deviceId`、`--intervalMs`、`--watchDebounceMs`、`--sessionArchive`、`--limitProviders` 等，不帶子命令就是常駐），讀執行檔旁的 `.env`；新增 `TOKEN_MONITOR_PROJECTS_ENABLED`（`--projects`）與 `TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS`；`run --dry-run` 不需要 hub、每筆 record 印一行 JSON；關閉主控台、登出與關機（Unix 的 SIGTERM / SIGHUP）時先送出最後一筆再結束。
- 重開程式（或改了不影響掃描範圍的設定）時，沿用今天一小時內的錨點（`collector-anchor.json`，上游同名檔），第一個 tick 只掃 today；大量裝置同時開機時不必每台都重跑三期間的完整掃描。`once` 與 dry run 不讀不寫。
- widget 開啟時先顯示上次完整掃描的數字（不上傳），不必等第一輪掃描；完整掃描時 today 與本月掃完就先更新畫面，不必等最慢的「全部」（上游 progressive preview 與 anchor seed）。
- 用量儀表板多了全期間的 8 張活動卡：總 Token、總花費、活躍天數、連續天數、活躍時間、峰值單日、常用模型、訊息數（上游 dashboard 活動分頁）。
- 修正：`--dry-run` 不再寫 session 與 history archive（與上游相同，dry run 沒有副作用）。
- 額度窗口的重置時間一過（30 秒後）就提早再查一次，不必等下一個查詢間隔（上游 resetBoundary）。
- 工具在程式啟動後才第一次使用（資料夾剛出現）時，完整掃描後自動開始監看，不必重開程式就有即時更新。
- 手動重掃（tray「立即重新掃描」、widget 的重新整理鈕）不等 5 分鐘的節流，立刻同步 Cursor 與 Antigravity（上游 `forceSelfSync`）。
- GitHub Copilot 額度：Premium requests 與 Chat 的剩餘比例與重置日（上游 providers/copilot）。設定頁「額度」以 GitHub device flow 登入（在 github.com 輸入代碼），token 存在 Windows 認證管理員；也接受上游的 `COPILOT_API_TOKEN` / `GITHUB_COPILOT_TOKEN` 與 GHE 的 `COPILOT_ENTERPRISE_HOST`。`limitProviders` 多一個值 `copilot`。
- 用量儀表板視窗（上游的 dashboard）：從 tray「用量儀表板…」或 widget 標題列開啟，今日／本月／全部的摘要、放大的趨勢（熱力圖、趨勢線、活躍統計）與依工具、模型的拆分。
- 修正：開發時 vite 監看到 `src-tauri/target` 裡 cargo 正在寫的檔案會整個結束。

## 未發佈 — M2

- 額度分頁：Claude Code（5 小時、每週、每週 Fable、額外用量）與 Codex（5 小時、每週、每月與其他桶）的用量上限、方案與重置時間，每 5 分鐘更新並隨上傳送到 hub（hub 的 dashboard 看得到全公司的額度）。讀取本機的 Claude Code / Codex 登入；不上傳任何 token。設定頁可以關閉、選擇工具與查詢間隔。
- `tm-agent limits [--json]`；`tm-agent run` / `once` 支援 `TOKEN_MONITOR_LIMITS_ENABLED`、`TOKEN_MONITOR_LIMIT_PROVIDERS`、`TOKEN_MONITOR_LIMITS_REFRESH_MS`（與上游 agent 相同）。

- 全公司分頁：widget 頂部切換「本機／全公司」。連上 hub 的即時串流，顯示全公司今日／本月／全部的 token 與等值成本、依工具或模型拆分、線上台數，以及每台電腦的用量清單（本機數字即時疊上，不必等上傳）。
- `tm-agent company [--json] [--follow-secs N]`：在命令列看同一份全公司資料，排查串流用。
- 修正與 fork hub 的相容：hub 每個串流 frame 是獨立的 gzip member，改為自行解壓（reqwest 的自動解壓只認得第一個）。

- 即時更新：監看各工具自己寫的紀錄，有變動時幾秒內只掃今天，本月與全部以上游的精確 delta 推出（`usage/delta.rs`、`collector/watch.rs`）；每小時與換日時仍完整重掃。Cursor 與 Antigravity 不監看，由定時掃描同步。設定頁「即時更新」可以關閉並顯示監看狀態；`tm-agent run` 支援 `TOKEN_MONITOR_WATCH` / `TOKEN_MONITOR_WATCH_DEBOUNCE_MS`（與上游 agent 相同）。
- 新設定：`watchEnabled`（預設開）、`watchDebounceMs`（預設 1500）。「完整掃描間隔」改名為「定時掃描間隔」。
- 新相依：`notify`。
- 自動更新（Tauri updater）：從公司 hub 的 `/updates/latest.json` 檢查（啟動後 30–120 秒，之後每小時），自動下載並以 minisign 驗章，使用者按「重新啟動以更新」才安裝。widget 橫幅、設定頁「更新」區塊與 tray 都能操作；dev、debug 與沒有簽章公鑰的建置不更新。
- `build-installer.ps1`：`-SigningKeyFile` 產生 updater 簽章與 `latest.json`（`scripts/make-latest-json.mjs`），`-ReleasesDir` 依安裝檔 → `.sig` → `latest.json` 的順序發佈到 hub，`-NotesFile` 放版本說明，`-NoUpdater` 產出不自動更新的公司版。公鑰在打包時以 `--config` 注入，repo 不放金鑰。
- 新相依：`tauri-plugin-updater`。
- 新文件：[docs/release.md](docs/release.md)。

## v0.1.0（未發佈）— M1

- 新專案：以 Tauri 2 + Rust 重寫 Token Monitor 員工端。
- Rust 核心：tokscale 掃描（相同 pin、自動退路）、上游 `usage.js` / `sessionMetadata.js` 的解析移植、裝置狀態、最新者優先的上傳佇列、上傳 payload 預算、hub client。
- `tm-agent`：`run`、`once`、`scan`、`health`、`doctor`、`secret`、`settings`；環境變數沿用上游 agent。
- deviceId 規則：沿用官方版 / hostname / GUID。
- hub 位置與 client secret 可在編譯時內建（`TM_HUB_URL`、`TM_CLIENT_SECRET`）；覆寫值存 Windows 認證管理員。
- widget：今日／本月／全部的 token 與等值成本、依工具或模型拆分、上傳狀態；設定視窗；tray；開機啟動。
- 相容測試：與上游 JavaScript 逐欄比對解析、正規化與 payload；overlay hub（SQLite 持久化）端對端上傳。
- 支援的工具固定為 Claude Code、Codex、OpenCode、Hermes Agent、Cursor IDE / Cursor CLI、Antigravity、GitHub Copilot，全部預設追蹤。
- Cursor：自動偵測桌面版登入並在掃描前同步帳號層級的用量（IDE 與 CLI 都算得到）；Antigravity：掃描前同步 IDE 的用量。設定頁每個工具旁顯示偵測與同步狀態；`tm-agent doctor` 顯示 Cursor 登入與 Antigravity 資料狀態。
- 新相依：`rusqlite`（bundled），用來唯讀 Cursor 的 `state.vscdb`。
- `build-installer.ps1`：產出 NSIS 安裝檔（currentUser），`-HubUrl` + `TM_CLIENT_SECRET` 產出公司版，否則產出本機模式版；尚無程式碼簽章與自動更新。

驗證：`npm run verify`、`npm run verify:shell`、`TM_COMPAT_LIVE=1 npm run test:compat`。
