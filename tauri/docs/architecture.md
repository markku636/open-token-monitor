# 架構

## 分層

```
React（src/）  ──invoke / listen──▶  Tauri 殼（src-tauri/src/gui/）  ──callback──▶  核心（src-tauri/src/*，不依賴 Tauri）
                                                                                     │
                                                              tokscale 子程序 ◀──────┤──────▶ 公司 hub（HTTPS）
```

單一 crate，`gui` feature 把 Tauri 與所有 plugin 藏起來。

- `token-monitor`（GUI）：`src/main.rs` → `gui::run()`。
- `tm-agent`（CLI）：`src/bin/tm_agent.rs` → `cli::run()`，`--no-default-features` 也能編，不連 WebView。

核心模組只拿 `EventSink = Arc<dyn Fn(CoreEvent)>`，從不碰 `AppHandle`；GUI 的 `gui/bridge.rs` 把核心事件轉成前端事件，CLI 把它印成 log 或 JSON lines。

## 資料流

1. **收集**（`collector/`、`device/runtime.rs`）有兩種 tick：
   - **完整**：依序跑 `tokscale --today`、`--month`、`--since <allTimeSince>`（絕不平行），結果同時成為**錨點**，也寫進設定目錄的 `collector-anchor.json`（上游同名檔，`once` 與 dry run 不寫）。啟動（沒有今天、一小時內、設定指紋相同的錨點時）、手動重掃（tray、widget 按鈕）、跨過本地午夜、錨點超過一小時時跑。widget 在 today 與 month 掃完時各先發佈一筆**預覽**（上游 `progressive` / `onPreview`）：還沒掃到的期間由今天的錨點以同一條 delta 算式推出，錨點不能用（跨日）就沿用上一筆，兩者都沒有就不發佈；預覽只補 archive、不寫。`tm-agent` 不發預覽。
   - **開機畫面**：widget 冷啟動時先把今天的持久化錨點當成一筆 record 顯示（上游 `primeLocalStatsFromAnchor`，`device/state.rs` 的 `seed`），不佔 revision、不上傳、limits 也不拿它組 record；掃描時間不可信的錨點不用。改設定造成的重啟不做（畫面上的數字比錨點新）。
   - **anchored**：只跑 `--today`，month / allTime = 錨點 + (新 today − 錨點 today)（`usage/delta.rs`，上游 `applyPeriodDelta` 的逐條移植），再把 today 的專案身分補到衍生期間、由 session 重新彙總專案。來源檔案有變動（watch）或每 `collectionIntervalMs`（預設 5 分鐘）時跑。`tests/compat` 用上游 JavaScript 逐欄比對這條路徑。
   - **watch**（`collector/watch.rs`，`notify`）：監看各工具自己寫的紀錄（Claude `projects/`、`transcripts/`，Codex `sessions/`，OpenCode、Hermes 的資料庫，Copilot `otel/`、資料庫與 VS Code `chatSessions/`，以及 `customScanPaths`）。尾端防抖 `watchDebounceMs`（預設 1.5 秒），到點時有 tick 在跑就重新計時，沒有冷卻時間；watch tick 不會把定時 tick 往後推。**Cursor 與 Antigravity 不監看**：它們的 cache 是 tokscale 同步寫入的，監看會自我觸發（上游 issue #15），由定時的 anchored tick 順便同步。監看無法啟動時只靠定時 tick（設定頁會顯示原因）。
   完整 tick 與定時的 anchored tick 會先做**自我同步**（`collector/self_sync.rs`），每個工具最多每 5 分鐘一次、整個程序共用節流；watch tick 不同步（3–5 秒的承諾禁不起最多 30 秒的 Antigravity 同步）：
   - Cursor：讀 Cursor 桌面版 `state.vscdb` 的 `cursorAuth/accessToken`（`rusqlite` 唯讀），正規化後寫進 tokscale 的 `cursor-credentials.json`（不切換 active 帳號），再 `tokscale cursor sync --json`。「Not authenticated」視為未登入，不是錯誤。
   - Antigravity：`~/.gemini/antigravity*` 存在才 `tokscale antigravity sync`（30 秒逾時）；我們逾時終止時，只清理那個子程序自己留下的 `sync.lock`。
   - 結果以 `CoreEvent::SelfSync` 回報給畫面（設定頁每個工具旁的說明），不上 wire。
2. **解析**（`usage/`）：tokscale JSON → `Period`。這是上游 `src/shared/usage.js` 與 `sessionMetadata.js` 的逐條移植。
3. **裝置狀態**（`device/state.rs`）：用量與（M2 的）limits 合成帶 revision 的 `DeviceRecord`。
4. **上傳節奏**（`device/runtime.rs`）：`syncUploadIntervalMs = 0` 每筆都送；否則第一筆立刻送，之後每個間隔送最新的一筆，關閉時補送最後一筆（最多等 5 秒）。
5. **上傳佇列**（`device/sink.rs`）：同時一筆、最新者優先、暫時性錯誤重試 5 / 15 / 45 秒。
6. **hub client**（`hub/`）：`POST /api/ingest`，`Authorization: Bearer <client secret>`、`x-token-monitor-response: minimal`。body 超過預算時依上游規則縮減明細；hub 仍回 413 就去掉 history 的 token 組成與 allTime 專案再送一次。
7. **畫面**（`display.rs`）：完整 record 留在 Rust，前端只拿瘦身的 `LocalStats`。

## wire 相容性

hub 端不改（上游 `src/hub/server.js` + monorepo 根目錄 overlay 的 `hub/`），所以我們送的 record 必須和上游 widget 送的逐欄相同。

| 欄位 | 值 | 為什麼 |
|---|---|---|
| `agentRuntime` | GUI `tauri-widget`、CLI `tauri-agent` | 與 `electron-widget` / `headless-agent` 區別；hub 在 runtime 改變時的 GUI-secret provider 規則依賴它 |
| `historyAvailable` | 設定 `historyEnabled` | hub 只在 `hasOwn` 時更新這個旗標，所以每筆都明確送 |
| `history` | 三態：不帶／`null`／完整物件 | hub **整份取代**；關閉時送 `null`，還沒掃過或失敗時不帶（hub 保留上一份） |
| `syncUploadIntervalMs` | 與實際上傳間隔相同 | hub 的 stale 門檻 = `max(base, 2 × interval)` |
| `periodWindows` | 裝置本地時區的日／月結束時間（UTC ISO） | hub 以 `endsAt` 讓離線裝置的 today / month 過期 |
| `limits` | payload 永遠帶（沒有時是空集合） | hub 看到 `limits` 鍵才會取代舊值 |
| session 標題 | 永不上傳 | 上游的隱私規則；我們根本不產生 |
| `ownerEmail` | 設定頁的「公司信箱」、`TOKEN_MONITOR_OWNER_EMAIL` 或 tm-agent 的 `--owner-email`；小寫；沒填時整個鍵不送 | 上游沒有這個欄位：`normalizeDeviceRecord()` 直接略過，所以不影響相容。fork hub 在合併前取出它（monorepo 根目錄 overlay 的 `hub/ingest.js`），存進 `device_claims`，用來把裝置歸給員工（`hub/org.js`）；不合法的值 hub 只丟掉這個欄位，不拒絕上傳 |

守門的是 `tests/compat/`：

- `wire-compat.test.mjs`：同一份 tokscale JSON 交給上游 JavaScript 與 `tm-agent`，比對三個期間的每個欄位（含每個 session、專案、client × model）、hub 的 `normalizeDeviceRecord()` 結果、`aggregateDevices()` 是否計入、以及上游 `serializeSyncPayload()` 產生的 payload。
  有 `graph.json` 時另外比對 history（上游 `normalizeHistory(parseGraphResult())`），並讓 fork hub 的 `ingestGuard` 檢查 payload；history 的 graph 是相對於今天產生的，固定日期的 fixture 一年後會整個掉出 370 天窗口。
- `hub-e2e.test.mjs`：用 monorepo 根目錄 overlay 的 `tests/helpers/overlayHub.js` 起 overlay hub（PGlite 持久化，也就是行程內的 PostgreSQL），實際上傳，確認 client 金鑰權限、報表用的每日用量表，以及 history 出現在 `/api/history` 並寫成 `source = history` 的日表列；另外用合成的人事公告確認回報的 `ownerEmail` 會讓 hub 把裝置自動歸給那位員工。

前端純函式的上游對照是 vitest 的 `src/*.compat.test.ts`（目前是 `homeViews.compat.test.ts`，見「主頁與視圖」）：`npm run test:compat` 在 node 的測試之後也跑它們，`npm test` 同樣會跑；沒有上游 checkout 時略過。

## 模組與上游對應

| 模組 | 上游 | 規則重點 |
|---|---|---|
| `usage/js.rs` | usage.js 的 `asNumber` / `firstNumber` / `firstString` | JS truthiness 與 `Number()` 語意；`firstNumber` 跳過 0 |
| `usage/keys.rs` | usage.js 的 `*_KEYS` | 原樣照抄，順序有意義 |
| `usage/client_name.rs` | usage.js `normalizeClientName`、history.js、tokscaleClientMapping.js | 判斷順序照抄；傘狀 id（mimo、devin）展開成 tokscale 的子 id |
| `usage/extract.rs` | usage.js `collectUsageRows` … `extractUsageBundleFromTokscale` | 根物件的 totalInput / totalCost 不算列；Codex 等 client 的 reasoning 另外加；cursor `auto` → `cursor-auto`；Reasonix 的 session 不上傳 |
| `usage/session_meta.rs` | sessionMetadata.js `applyTokscaleSessionMetadata`、`projectIdentity` | `projectId = sha256("project\0<路徑>\0")`，Windows 路徑小寫 |
| `usage/projects.rs` | usage.js `projectRollupFromSessions`、projectKey.js | NFC + 小寫為 key，label 取字典序小者 |
| `usage/history.rs` | history.js `parseGraphResult`、`normalizeHistory` | reasoning 只算進 codex / droid / dsh / reasonix；Reasonix 的 messages 是 0；day.tokens = perClient 加總，不用 tokscale 的 totals |
| `hub/payload.rs` | syncPayload.js | 預算 1 MiB − 16 KiB；history 只有最近 30 天帶 token 組成；縮減順序見檔頭 |
| `device/sink.rs` | orderedSink.js | 最新者優先；另加重試 |
| `device/state.rs` | deviceState.js | limits 等用量出現後才發佈 |
| `identity.rs` | config.js `defaultDeviceId`、osVersion.js | build ≥ 22000 的 "Windows 10" 更正為 Windows 11 |
| `tokscale/` | collector.js `runTokscale`、`spawnTokscaleJson` | 不認得的 group-by / client 自動退路，並以 binary 為單位記住 |
| `collector/cursor.rs` | providers/cursor/auth.js | token 正規化（cookie、`::`、JWT → `user_…%3A%3A…`）；探測不切換 active 帳號；內容沒變就不寫檔 |
| `collector/antigravity.rs` | providers/antigravity/selfSync.js、tokscaleConfig.js | 只刪「我們剛終止的子程序」的鎖；tokscale 設定目錄在 Windows 是 `%APPDATA%\tokscale` |
| `collector/self_sync.rs` | collector.js `maybeSyncCursor` / `maybeSyncAntigravity`、selfSyncThrottle.js | 5 分鐘節流，嘗試即計時；節流是程序共用的 |
| `detail.rs` | renderer 的 usageAttributionRows.js、toolDetails.js、projectRows.js、sessionRows.js | 只給前端顯示，不上 wire；排序與餘數規則照抄 |
| `ranges.rs` | renderer 的 fixedPeriodRanges.js（`company_ranges` 是 `fixedPeriodSnapshotFromDevices`）、historySource.js `devicesWithLocalHistory` | 只給前端顯示；今天用即時的 today（不小於 history 時）；全公司逐台以各自的日期鍵推、總數是逐日相加；`tests/compat/device-ranges.test.mjs` 逐欄比對 |
| `export.rs` | src/shared/exporter.js、main.js `writeExportTo` | 欄位與檔名照抄；沒有 history 時不寫 |
| `session_detail.rs` | src/shared/sessionDetail.js、sessionFiles.js、providers/opencode/session.js | 只在本機讀；`tests/compat/session-detail.test.mjs` 逐欄比對 |
| `trends.rs` | renderer 的 homeOverview.js `patchDailyToday` | 只給前端顯示；今天用即時的 today |
| `view_prefs.rs` | main.js `migrateViewDisplayOrder`、`normalizeHomeLimitAccountCount` 等，renderer 的 viewDisplayPreferences.js、homeModulePreferences.js | id 轉小寫比對，列舉值只去空白；全部隱藏收成空字串；修改時不合法的列舉保留目前的值 |
| `collector/roots.rs` | collector.js `clientSourceRoots`、providers/hermes/profiles.js | 只列公司支援的七個工具 |

## 設定與 secret

- `settings.json`（`store::config_dir()`）：所有欄位有預設值，未知鍵原樣保留；`validate()` 把值收斂到 hub 接受的集合。
- hub 網址解析：CLI → `TOKEN_MONITOR_HUB_URL` → 設定檔的 `hubUrl` → 編譯時的 `TM_HUB_URL`。
- secret 解析：CLI → `TOKEN_MONITOR_SECRET` → OS 認證管理員的覆寫值 → 編譯時的 `TM_CLIENT_SECRET`。
- 覆寫只給金鑰輪替用：設定頁或 `tm-agent secret set`。

## GUI

- 主視窗 `main`：無邊框、透明、預設浮動在最上層、不出現在工作列；位置與大小由 window-state plugin 記住。關閉 = 收到 tray。
- 設定視窗 `settings`：一般視窗，第一次開啟時才建立（`index.html?view=settings`）。
- 啟動：`visible:false` → 前端首次繪製後呼叫 `window_show_ready`；4 秒保險絲確保前端壞掉時視窗仍會出現。
- tray：左鍵切換視窗；選單有重新掃描、設定、日誌資料夾、檢查更新（下載好後變成「重新啟動以更新」）、結束。tooltip 顯示今日用量。「開啟 ▸」子選單與邊緣額度條送的 `open-tab` 仍是舊的分頁 id（`local` / `company` / `limits` / `trends`），前端 `viewPrefs.ts` 的 `LEGACY_VIEW` 換成視圖 id；新的視圖 id 也接受（見「主頁與視圖」）。
- 開機啟動：autostart plugin（HKCU Run，免管理員）；debug build 不註冊。
- CSP 嚴格：webview 不連網，所有網路都在 Rust 端（hub、額度 API、匯率、服務狀態頁）。

## 工作列上方（Windows）

- `gui/taskbar.rs`，上游 windowsTaskbarZOrder.js + windowsForegroundHook.js。只在浮動模式、`keepAboveTaskbar` 開啟、而且視窗有一部分落在工作區外時運作；其他時候計時器與系統 hook 都拆掉。
- tao 的 `set_always_on_top(true)` 只在狀態改變時呼叫 `SetWindowPos`，重複呼叫沒有效果，所以直接呼叫 `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)`。
- 前景事件 hook（`EVENT_SYSTEM_FOREGROUND`，out-of-context）必須在有訊息迴圈的主執行緒安裝與拆除；callback 只呼叫 `Notify::notify_one`。
- 驗證方式：把 widget 移到工作列上，從外部 `SetWindowPos(Shell_TrayWnd, HWND_TOPMOST)` 模擬 shell 抬起工作列；關閉時 widget 留在下面，開啟時 250 ms 內回到上面。從腳本 `SetForegroundWindow(工作列)` 會被前景鎖擋掉，重現不了。

## 視窗外觀與快捷鍵

- `gui/chrome.rs`：`DWMWA_WINDOW_CORNER_PREFERENCE = ROUND` 與 `DWMWA_BORDER_COLOR = NONE`（上游 windowsChrome.js）；玻璃用 Tauri 內建的 `Effect::Acrylic`（Windows 11 22H2+ 是 `DWMWA_SYSTEMBACKDROP_TYPE = 3`）。驗證以 `DwmGetWindowAttribute` 讀回（圓角 2、backdrop 開 3／關 1）；`CopyFromScreen` 在螢幕沒有合成時只拍到桌布，要看畫面用 `PrintWindow(PW_RENDERFULLCONTENT)`。
- 系統匣（`gui/tray.rs`、`gui/tray_bars.rs`）：額度長條選工具的規則是上游 `pickWorstLimitProvider` / `compactLimitSelection`，但長條畫**已用**比例（與額度分頁一致；上游預設畫剩餘）。圖示只在四捨五入後的百分比或墨色變了才重畫；墨色讀 `HKCU…ThemesPersonalizeSystemUsesLightTheme`，每分鐘檢查一次。tray 的設定變更與設定頁共用 `commands::apply_settings_patch`，勾選狀態由 `tray::sync_checks` 同步。
- 系統匣模式（`WindowMode::Tray`，`gui/window.rs`）：位置是上游 tray.js `popoverBounds`（圖示中心、上方 8 px、夾在工作區內 4 px），錨點是最近一次 tray 點擊的圖示範圍，沒有就用游標。剛顯示的 250 ms 內不因失去焦點而收起。啟動時的 4 秒顯示保險絲與 `window_show_ready` 都要跳過這個模式。
- 浮動泡泡（`gui/bubble.rs`，上游 floatingBubble.js）：收合是把同一個視窗縮成把手（上游在 Windows 上重建視窗，我們只改大小與位置、暫時拿掉最小尺寸）。收合前的大小只存在記憶體，結束前 `restore_for_exit` 先還原，window-state plugin 才不會存到把手的大小。實測可用 `PostMessage(WM_SETFOCUS)` 再 `WM_KILLFOCUS` 觸發收合。
- 邊緣額度條（`gui/dock.rs`、`src/Dock.tsx`）：獨立的 `dock` 視窗（在 capabilities 與 window-state 的 denylist 裡）。上游用兩個視窗並輪詢游標；這裡只有一個視窗，hover 用 webview 的滑鼠事件（非作用中的視窗也收得到），展開 140 ms、收回 320 ms 的延遲在前端。只放主螢幕，位置由設定決定，不能拖曳。
- `gui/shortcut.rs`：`tauri-plugin-global-shortcut`，設定值先經 `settings::normalize_window_toggle_shortcut`（上游 windowShortcut.js 的規則）。註冊失敗不改設定，狀態放在 `AppStatus.windowShortcut`。模擬按鍵（`keybd_event`）在這個環境連自己註冊的 hotkey 都觸發不了，實際按下只能手動測。

## 自動更新

- feed：`<生效的 hub>/updates/latest.json`（monorepo 根目錄 overlay 的 `hub/releases.js` 提供）。跟著設定頁的 hub 覆寫走，IT 搬 hub 不必重發安裝檔；安裝檔一律以內建公鑰驗章，覆寫不會讓人換掉程式。
- 公鑰：repo 的 `tauri.conf.json` 只有 `plugins.updater.pubkey: ""`。build-installer.ps1 以 `--config` 把 `-SigningKeyFile` 同目錄的 `.pub` 與 `createUpdaterArtifacts: true` 疊上去，所以 repo 不放任何金鑰，每家公司用自己的金鑰。
- 停用條件（`update::feed_url`）：dev 建置（沒有內建 secret）、debug build、沒有公鑰（`-NoUpdater`）、沒有 hub。設定頁會說明原因。
- 排程：啟動後 30–120 秒第一次檢查（大量裝置同時開機時錯開），之後每小時 ±5 分；失敗 15 分鐘後重試。`automaticAppUpdates` 開啟時找到就下載並驗章，否則停在「有新版」。
- 安裝只在使用者按「重新啟動以更新」（widget 橫幅、設定頁、tray）時發生：先停 runtime 送出最後一筆，再以 NSIS passive 模式安裝並重新啟動。與上游 Electron 版一樣，關閉 app 時不會自動安裝。
- 狀態機在 `update.rs`（Tauri-free，可單元測試），接 plugin 的部分在 `gui/updater.rs`；前端事件 `update-state`。
- 版本說明連結（「查看完整版本資訊」、出錯時的「查看 release」）開 `<生效的 hub>/downloads/releases#v<版本>`（`update::release_page_url`），頁面上每個版本是一個 `<section id="v…">`（本 repo 根目錄的 hub 目前沒有這一頁）；不知道版本（出錯）時不帶錨點。只由 Rust 的 `update_open_release` 組網址並開啟，前端不能指定網址。已下載、沒有版本說明時點更新提示的版本號是開版本頁，安裝只走「重新啟動」（上游相同）。

## 全公司視圖

- 串流（`hub/stream.rs`）：`GET /api/stats/stream`，帶 `x-token-monitor-stream: 2` 與 client secret。`snapshot` / `stats` 取代快取，`freshness` 只更新各裝置的時間戳與 stale（上游 `applyFreshnessEvent`）；`: hb` 是心跳，90 秒沒有任何位元組就重連。
- gzip：fork 的 hub 每個 frame 送一個獨立的 gzip member。reqwest 0.12 的自動解壓遇到第二個 member 會報錯，所以串流的 client 用 `no_gzip()`、自己送 `accept-encoding: gzip`，再以 `flate2::write::MultiGzDecoder` 邊收邊解。不要改回自動解壓（`gzip_members_are_decoded_one_frame_at_a_time` 守著）。
- 數百台裝置時一個 frame 約 16 MB：只反序列化畫面要的欄位（`HubStats`），session 與專案明細由 serde 略過。各裝置的 `periodWindows` 另外留下 today / month 的 `key` 與 `timeZone`：全公司的範圍以每台裝置自己的日期鍵推（見「本星期／最近 7 日／最近 30 日」）。
- 組合（`display::compose_company`，上游 `composeLocalSyncStats`）：hub 上自己那一列換成本機最新的 record，期間總和只加未過期的裝置，其他裝置的 stale 以本機時鐘重算（`max(staleAfterMs, 2 × 上傳間隔)`）。hub 有新快照或本機有新 record 時重算，前端事件 `company-updated`，數百台時約 90 KB。
- 重連：1 秒起跳加倍到 30 秒、±20% 抖動；401 / 403 等 60 秒。設定改變時隨 runtime 重開，換 hub 時清掉舊快照。
- 點開一台裝置（`company_device`，`display::device_detail`，上游 deviceBreakdown.js）：依工具分組、總量大於各工具加總的餘數是未分類，每個工具下列模型（`HubStats` 因此多收 `clientModels` 與 `osVersion`）；不含成本。期間已過期時是空的，與清單的數字一致；本機那台用最新的本機 record。
- `tm-agent company [--json] [--follow-secs N]` 印同一份資料，排查串流用。

## 額度（limits）

- 範圍（v1）：Claude Code 與 Codex 的 OAuth 路徑（`limits/claude.rs`、`limits/codex.rs`）。不做 claude.ai cookie、`claude /usage` 的 CLI 退路、Codex app-server RPC、WSL、多帳號。
- Claude 憑證：`CLAUDE_CODE_OAUTH_TOKEN` → `~/.claude/.credentials.json` → Windows 認證管理員 `Claude Code-credentials`（含 `:<USER>`、`/<USER>`）→ macOS 鑰匙圈。到期前 5 分鐘或 401 時換 token，只有檔案來源會寫回（保留其他鍵與順序）。用量 API 必須帶 `claude-cli/…` 的 user-agent。
- Codex 憑證：`~/.codex/auth.json`，不換 token（上游靠 Codex CLI 自己換）；`chatgpt-account-id` 以 auth.json 存的為準，其次 id_token 的宣告。
- 身分：`accountKey` 與上游位元相同（`hash_key(["claude-account", …])`、`hash("codex", email + "\0" + account_id)`），hub 才能把 Electron 與 Tauri 裝置上的同一個帳號合併。方案（`Max 20x`、`Pro 5x`）放在 `accountLabel`。
- 輸出（`limits/normalize.rs`、`wire/limits.rs`）：就是上游 `normalizeLimitsSummary` 的結果；`tests/compat` 以「上游正規化後不變」及「同一份 API 回應與上游對應函式逐欄相同」守著。
- 排程（`limits/runtime.rs`）：啟動探測一次，之後每 `limitsRefreshMs`（預設 5 分鐘）逐一探測；暫時性失敗保留上次成功的數字只換狀態、以 5 秒起跳的退避重試，登入失效或沒登入則清掉。**本機用量絕不觸發額度探測**，只有定時、啟動與手動（設定頁、額度分頁的按鈕）。
- Cursor（`limits/cursor.rs`）：tokscale 的 `cursor-credentials.json` 裡 active 的那一個帳號，以 `WorkosCursorSessionToken` cookie 與瀏覽器 user-agent 呼叫 cursor.com 的 usage-summary、auth/me、usage 與 sand（Grok Bot）。v1 只查一個帳號；設定頁可以手動貼 token（`cursor_set_token`，只寫進 tokscale 的帳號檔）。`tests/compat` 把同一份 API 回應注入上游 `fetchCursorLimits` 逐欄比對。
- Copilot（`limits/copilot.rs`）：`copilot_internal/user` 的 Premium／Chat 快照（沒有快照時退回 monthly/limited 次數），token 來自 device flow（client id 與上游相同，存 `secrets::COPILOT_TOKEN`）或環境變數。device flow 由 `gui/commands.rs` 的 `copilot_login_start` 背景輪詢，結果以 `copilot-login` 事件回報，token 不經過前端。
- `tm-agent limits [--json]` 探測一次並印出；`tm-agent once` 在上傳前探測一次（上游 `runAgentOnce`）；固定 JSON 來源（測試）不探測。環境變數與上游 agent 相同：`TOKEN_MONITOR_LIMITS_ENABLED`、`TOKEN_MONITOR_LIMIT_PROVIDERS`、`TOKEN_MONITOR_LIMITS_REFRESH_MS`。

## session usage archive

- `usage/archive.rs`（上游 sessionUsageArchive.js）＋ `usage/archive_store.rs`（SQLite，每個 session 一列，只 upsert 變動的 key）。每個 tick 收集後、發佈前：記住這次的 session，再把沒掃到的以 `archived: true` 補回 today（同一天）、month（同一月）與 allTime，最後重算專案。錨點是補回之前的原始結果。
- 沒移植 Cursor 舊 CSV 列的取代連結與 Reasonix 合成 session（公司的七個工具用不到）。
- daily history archive（`usage/history_archive.rs`，上游 dailyHistoryArchive.js）與它同一個開關：每次 graph 掃描先把每一天的「client × 模型」觀測記進 `daily-history-archive.json`（token 多的贏），再以 archive 重建 graph，所以 hub 整份取代 history 時不會少掉被刪的日子。沒移植 `liveDays` 與 Cursor 成本對帳。
- `tests/compat` 以「同一個設定目錄連跑兩次、第二次少一個 session」與上游 `updateSessionUsageArchive` + `applySessionUsageArchive` 逐欄比對。

## 用量歷史（history）

- 來源：`tokscale graph --client <csv> --no-spinner`（輸出就是 JSON，逾時 60 秒），`usage/history.rs` 轉成 `{daily, monthly, summary}`：daily 是以今天結尾的 370 天，monthly 與 summary 用全部日子（lifetime 不受 370 天限制）。graph 一天都沒有就不送。
- 時機（`device/runtime.rs`）：用量發佈**之後**、同一個 tick 裡序列地跑，不拖慢即時更新、不與用量掃描並行。第一個 tick、手動重掃、換日一定跑；其他 tick 距上次嘗試滿 `historyIntervalMs`（預設 15 分鐘）才跑。換日那次失敗 60 秒後補跑一次，之後回到一般間隔。
- 上一份成功的 history 帶進之後每一筆 record（`device/state.rs`，上游 `mergeUsagePart`）。
- widget 的「近 30 天」（`display::history_preview`）以今天結尾補滿 30 格，今天那格用即時的 today，不等下一次 graph。
- 環境變數與上游 agent 相同：`TOKEN_MONITOR_HISTORY_ENABLED`、`TOKEN_MONITOR_HISTORY_INTERVAL_MS`。

## 明細畫面（工具／模型／專案／session）

- 完整 record 留在 Rust（`state.record`），前端打開那個清單時才以 `usage_detail(period)`、`usage_sessions(period, page)` 要資料（`gui/views.rs` → `detail.rs`），本機有新 record（`LocalStats.updatedAt` 變了）時重拉；不隨每次掃描推送，allTime 上千筆 session 才不會每幾秒搬一次。
- 規則照上游 renderer：工具與模型列是 `attributionRows`（總量扣掉各列的餘數成為「未分類」，token 為 0 且成本顯示為 $0.00 時不顯示）；工具的模型拆分是 `modelRowsForTool`；token 組成的「快取未命中」= 總量 − 未分類 − 快取讀取 − 輸出（快取寫入算在未命中裡，與上游相同，前端 `detailFormat.ts`）。專案以 `period.projects` 為準、沒有時由 session 的專案標籤重建，依成本 → token → 名稱排序。session 依 `lastUsedAt`（沒有時 `startedAt`）新到舊、一頁 100 筆，長條以所有頁中最大的 session 為滿格；Codex 的 `background-review` 合成最後一列。
- 「進行中」只看最後活動在 10 分鐘內：我們不讀 transcript，沒有上游用來提早熄燈的 `turnEnded`。
- 逐回合明細（`session_detail.rs`，上游 src/shared/sessionDetail.js、sessionFiles.js、providers/opencode/session.js）：點 Claude / Codex / OpenCode 的 session 時才讀它自己的紀錄——Claude 的 `projects|transcripts/**/<id>.jsonl`（續接重放的行以 `uuid` 去重、同一回覆拆成多行以 `message.id` 只算一次）、Codex 的 `sessions/YYYY/MM/DD/<rollout>.jsonl`（`token_count.last_token_usage`，input 扣掉 cached）、OpenCode 的 `opencode*.db`（唯讀）。session id 只能是單一路徑片段。Claude / Codex 的成本依 token 比例分攤清單上的 session 成本，OpenCode 用每則訊息的真實成本。GUI 在 blocking 執行緒讀檔（`session_detail_get`）；`tm-agent session-detail` 印同一份資料。明細只在本機，不進 wire record。`tests/compat/session-detail.test.mjs` 以上游 `readSessionDetail` 逐欄比對（`TM_COMPAT_LIVE=1` 另外比這台電腦上最近的真 transcript）。
- 全公司分頁只有工具與模型（hub 串流只帶彙總）；清單選在專案或 session 時切過去會顯示工具。
- 本機清單換期間時，新期間的明細到之前留著上一個期間的（`useFetched` 的 `keepPrevious`，只有 `LocalBreakdown` 用；拉失敗才回 null）：列的身分不斷，新資料到了數字與長條才從舊期間動過去（上游換期間時就是從舊的列動過去），動畫用的期間是資料實際所屬的期間（`useFetchedEntry` 帶回的 key）。沒有這個選項時換 key 仍先回 null。

## 工具圖示

- 素材與對照表照抄上游：`src/assets/brand/*.svg` 逐字複製自上游 `assets/icons/`（加上 renderer 的 `icons/views/project-row.svg`），`src/brandIcons.ts` 的 `CLIENTS_WITH_ICON`（上游 `clientsWithIcon`）、`UPSTREAM_LIMIT_PROVIDER_IDS`、`MASK_FILE` + `LIMIT_MASK_OVERRIDE`（上游 styles.css 的 `.row-icon-<id>` 與 `.limit-icon.row-icon-grok`）。`tests/compat/brand-icons.test.mjs` 比對這些字面值、逐位元比對每個圖檔，並逐條比對 `modelVendorFor` 的正規式。全公司分頁會出現 Electron 裝置回報的任何上游 client，所以整份都帶，不只 Tauri 的七個工具。
- 一律用 CSS 遮罩、底色 `currentColor`（`.brand-icon`、`BrandMark.tsx` 的 `RowMark`），圖示是那一列文字的顏色，不是廠商色：有些 SVG 把顏色寫死（例如 os-windows），直接內嵌會變成彩色。圖檔由 Vite 打包或內嵌成 data URI，都在 CSP 的 `img-src 'self' data:` 之內。圖檔網址（`import.meta.glob`）放在 `brandIconUrl.ts`，`brandIcons.ts` 才能讓 compat 測試直接以 Node 載入。找不到檔案時退回色點，不會像上游缺規則時畫成實心方塊。
- 選圖示（`iconKindFor`，上游 app.js 同名函式）：工具看 `CLIENTS_WITH_ICON`（未分類畫色點）；模型看 `modelVendorFor` 的廠商，認不出（含未分類）畫 Token Monitor 的 Σ；session 看工具；專案是資料夾；裝置看 `platform` 的系統；額度看 `LIMIT_MARK_IDS`。Tauri 專有的「其他」合併列一律色點。
- `showToolIcons`（預設開）管本機的工具、模型、專案、session 清單、全公司的清單、裝置與裝置明細的工具、主頁的四個模組（上游 `applyHomeListMark`），以及服務狀態（圖示放在狀態色點與名稱之間，色點保留）；關閉時回到色點。儀表板沒有圖示（上游的儀表板視窗也沒有）。額度卡片標頭的圖示照上游不受開關控制，還沒加（`LimitsPanel.tsx`）。

## Token 速率

- `PeriodTotals` 帶上 tokscale 的速率計數（`timedTokens`、`timedOutputTokens`、`timedDurationMs`，只算有生成時間的回覆，時間是各回覆的生成時間加總）與 `throughput`。平均速度 = 輸出 × 1000 ÷ 時間（tok/s），消耗 = token × 60000 ÷ 時間（tok/min）；四捨五入是 0 或沒有速率（範圍）時不顯示（前端 `tokenRate.ts`，上游 tokenRatePresentation.js）。
- 即時速率在前端算：每次 `stats-updated` 取 today 計數與上一次的差，任何計數變小（換日）清掉，時間沒增加沿用上一個樣本；8 秒內是即時、之後變暗，3 分鐘後顯示「—」。tracker 在 `Rate.tsx` 的模組層級訂閱 `store.ts` 的 `onLocalStats`（每一筆推送都算，包括視窗看不到、store 先收著的那些；上游 onStatsPush 同樣每一筆都 `observeLiveTokenRate`），底欄沒顯示時基準也保持最新，打開視窗時不會把藏起來前的舊平均當成剛量到的即時速率。範圍只有「這部裝置」：hub 串流的瘦身快照沒有各裝置的速率計數，上游的「所有裝置」不提供。

## 資料匯出

- 格式（`export.rs`，上游 src/shared/exporter.js）：JSON 是 `{generatedAt, app, snapshot: {today, month, allTime}, daily, monthly}`，期間原樣；CSV 有快照（期間 × 工具／模型）、每日工具、每日模型（輸入 = 總量 − 輸出 − 快取讀寫 − 未分類；組成超過總量時整列算未分類）。UTF-8 BOM、CRLF、RFC 4180。不含其他裝置與額度，金額一律 USD，模型 id 原樣。
- 寫法：逐檔暫存 + 改名，這次沒寫的舊檔刪掉（歷史清空後不留過期的日表）。還沒有 history（第一次掃描前、掃描失敗）時什麼都不寫，否則孤兒清理會刪掉既有的日表；history 關閉時只寫 JSON 與快照。
- 自動匯出（`gui/export.rs`）：背景工作每 `exportIntervalMs` 檢查一次，內容簽章（期間 + 歷史的 SHA-256）與上次寫到同一個資料夾的相同就跳過（資料夾常是 OneDrive）；設定改變時立刻檢查。手動匯出一律寫。選資料夾用 `tauri-plugin-dialog`。

## 模型別名

- 只影響畫面（上游 renderer/modelAliases.js，main 在送給 renderer 前套用）：wire record、hub 上的資料與匯出的檔案都保留原本的模型 id。我們在前端套（`modelAliases.ts` + `useModelAlias.ts`），摺疊模型的 token、成本與組成；手動別名以「小寫、. _ 空白換成 -」比對、優先於自動合併，自動合併的結果再套一次手動。
- 自動合併的候選是本機與全公司「全部」期間出現的模型；`duplicates` 只在兩種以上寫法同時出現時合併，`prefix` 連單獨的 `供應商/模型` 也去掉前綴。設定在 Rust 以上游的 `normalizeModelAliases` 收斂（最多 4096 組）。

## 服務狀態

- `service_status.rs`（上游 src/electron/serviceStatus.js）：Claude、OpenAI、Cursor 的 Statuspage `summary.json`，DeepSeek 用 `deepseek.statuspage.io` 鏡像（官方頁只給瀏覽器 HTML）但連結指向官方頁。indicator none / minor / major、critical 對應正常 / 降級 / 中斷；受影響組件排除維護中的，事件排除 resolved / completed / postmortem。
- `gui/service_status.rs`：畫面顯示時才查（`serviceStatusRefreshMs`，0 = 只手動），平行、各 5 秒逾時，程序內快取 60 秒（有失敗 10 秒）；`service_status_open(id)` 只開對照表裡的狀態頁，前端不能要求任意網址。
- 前端是獨立的「狀態」視圖（上游 Status 視圖），與上游一樣預設隱藏（`hiddenViews` 預設 `status`）；只在顯示時輪詢。要看時在設定頁「主畫面」打開，或由 tray 以 `open-tab` 開啟（隱藏的視圖也能開，離開前留在切換順序裡）。

## 幣別

- 成本一律以 USD 計（tokscale 的牌價），只有顯示換算：前端 `fmtUsd` 乘上 `currency-updated` 事件給的匯率、加上幣別符號。匯出的檔案與額度的金額不換算（上游相同）。
- 匯率（`currency.rs`，上游 currency.js / exchangeRates.js）：手動（`currencyRates`）> 每日匯率 > 內建值（TWD 31.5、HKD 7.8、CNY 6.8）。每日匯率來自 fawazahmed0 currency-api（jsDelivr，其次 Cloudflare Pages 鏡像，各 8 秒），回應要有所有支援的幣別才算數；快取在 `<config_dir>/exchange-rates.json`，來源日期不是今天（UTC）而且抓取超過 24 小時才重抓。
- 抓取在 `gui/currency.rs` 的背景工作：啟動 20 秒後、之後每 6 小時，只在選了非 USD 幣別時；設定的幣別或手動匯率改變時立刻重算並喚醒。公司網路擋外連時安靜地用快取或內建值。

## 本星期／最近 7 日／最近 30 日

- tokscale 只掃 today / month / allTime；其他範圍由 `ranges.rs`（上游 renderer fixedPeriodRanges.js 的 `dailyForRange`、`derivePeriod`、`summaryForDaily`）從本機 history 的每日列加總：兩端都含、以裝置本地的日期鍵、沒有用量的日子補 0；今天那一列在即時數字不小於 history 時換成即時的 today（`rowFromLivePeriod`，組成依序夾住）。推出的期間只有工具與模型（含 token 組成），沒有 session、專案與速率計數；`antigravity-cli` 併進 `antigravity`。
- `range_get(range, weekStart)` 回 `ready`（總數、明細、摘要）、`loading`（還沒有 history；掃描失敗時前端依 `status.historyError` 顯示暫時無法使用）或 `disabled`。`weekStart` 由前端依 `navigator.languages[0]` 的 `Intl.Locale` 週資訊決定（不是介面語言），取不到用星期一，與上游相同。
- 期間選擇存在 view 偏好（`period`、`monthMode`）；中間那格顯示本月或選中的範圍，再點一次開選單。
- 全公司的範圍（`company_range_get`，`ranges::company_ranges`，上游 `fixedPeriodSnapshotFromDevices`）逐台推：
  - 來源：hub 的 `GET /api/custom/device-daily`（只給 client 與 admin 金鑰；本 repo 根目錄的 hub 目前沒有這個路由，見下方「快取」的退回方式）——各裝置最近 32 天（UTC 今天往前 31 天起）的每日 token、成本、活躍時間與依工具／模型的 token 與成本，加上上游 `parseDeviceHistories` 的 `historyAvailable` 與整份歷史有沒有用量（`historyHasUsage`，上游以完整的每日列決定裝置有沒有參與）。hub 每個串流時間窗算一次、共用 gzip；數百台約 3 MB、gzip 後不到 1 MB。上游抓的 `/api/devices` 是完整 record，數百台時 18–54 MB、每次重新序列化，這裡不用它。
  - 每台裝置用串流快照裡它最新的 today（原樣、不因過期歸零）與 `periodWindows.today`，本機那台用最新的本機 record（歷史照上游 `devicesWithLocalHistory`：record 帶了就用、沒帶沿用 hub 的那份）。範圍以裝置自己的日期鍵計算；日已過期時，它最後的 today 落在自己那一天，範圍到它現在的那一天（`device_day_state`：由 `endsAt` 推出時差，見下方「已知差異」）。
  - 總數是各台的範圍列逐日相加（`mergeSelectedDaily`），起訖日是各台範圍的聯集，摘要取合併後的列；每日歷史可用、整份與即時都沒有用量的裝置不列。清單（`RangeDeviceRow`）依 token 由多到少，點開是那台依工具的拆分（`company_range_device`；推出的期間沒有工具 → 模型的拆分，所以沒有模型）。
  - 沒有可用每日歷史的裝置標成「沒有可用的每日歷史」、不計入總數，底下註明台數（上游整個範圍不顯示，見「已知差異」）。即時的 today / month / allTime 全是 0 也一樣要標：上游先要每台都有歷史才判斷誰參與，因為 allTimeSince 等設定可能讓即時數字是 0、範圍內卻有用量，不能無聲地算成 0。
  - 快取：成功 60 秒、失敗 30 秒；hub 回 403 / 404（沒有這個路由的 hub，例如本 repo 根目錄的 hub 與上游 hub）記為不支援 10 分鐘，這段期間退回 v1：`GET /api/history`（hub 以 `aggregateHistory` 合併所有有每日歷史的裝置；widget 同樣快取 60 / 30 秒）+ 全公司即時的今日（`CompanyTotals`，沒有 token 組成），沒有逐台清單。hub 本身每個時間窗才重算，所以不移植上游清單對不上時的 3 × 4 秒重試：快照裡有、payload 裡還沒有的裝置在下一次抓取（最多約 60 秒）前顯示為沒有歷史。

## 趨勢分頁

- 資料：`trends_get`（`gui/views.rs` → `trends.rs`）從本機 record 的 history 取每日（有用量的日子）、每月與 summary，只帶畫圖要的欄位（約 30 KB）；今天那一格換成即時的 today（上游 `patchDailyToday`），沒有就補上。打開分頁時拉，本機有新 record 時重拉。
- 趨勢視圖只有上游 Trends 視圖的內容：期間長條（今日 = 以今天結尾的 7 個日曆天、本月 = 這個月有用量的日子、全部 = 每月）與活躍天數、連續天數、活躍時間、峰值單日。活躍天數與連續天數一律取 summary，活躍時間與峰值單日跟著期間。長條在切進趨勢視圖時從零長出、換期間時從上一次的高度變過去（新的長條從零，依序延遲 14 ms；上游 `animateTrendBarsFrom`）；點長條或右上角的 ↗ 打開儀表板（Enter／Space 也行，上游 `.trends-spark`），儀表板裡的同一組長條不能點。
- 熱力圖與趨勢線在主頁的「活動」模組（`Activity.tsx`，上游 `renderHomeTrendsModule`）：熱力圖從 11 個月前那個月的 1 號往前推到星期日、每欄一週，分級是相對最大值的線性四級（≥75% / ≥50% / ≥25% / >0），依設定 `heatmapMetric`（`tokens` / `cost`，預設成本，與上游同名；舊版存在 view 偏好 `heatMetric` 的 token 選擇在第一次啟動時搬過去一次）；趨勢線是最後 45 列（不補空白）的平滑面積圖（pad 4/3/4/3）。畫法照上游 usageCharts.js 與 homeOverview.js（前端 `trendsFormat.ts`）。儀表板的趨勢區用同一個元件（`ActivityBody variant="dashboard"`）。
- 熱力圖的互動（上游 `setupHomeActivityScroller` / `setupHomeActivityHover`）：捲軸藏起來，滑鼠按住拖曳捲動（觸控照常捲），往回捲時左緣淡出。捲動位置在這次開啟期間記住（`homeActivityScrollTarget` / `homeActivityScrollRecord`，預設跟著最右邊；還原位置在 ResizeObserver 回報排好之後做，冷啟動的視窗在 rAF 裡常量到還沒排好的寬度）。游標在格子上時點亮那一格（光暈）、放射漸層遮罩的聚光燈跟著游標（每幀靠近 32%），浮動提示掛在 body 上（token 數與日期，`tokens` 一字不翻譯、不含成本，上游相同），上面放不下就放下面；使用者捲動、拖曳或離開時收起，程式還原捲動與資料重畫時游標沒動就接回同一天。光暈與亮色格子用主題的強調色（上游固定藍色）。
- 進場動畫（上游 `animateHomeHistoryVisuals`，`HOME_*_MOTION_MS`）：切進主頁（活動模組掛上）後第一次排好時播一次——看得到的格子依欄位由左到右淡入（整段 640 ms、每格 240 ms），趨勢線描出來、面積由左往右展開（920 ms）；資料更新不重播。儀表板照上游 dashboard.js `animateHeatmapEntry`：格子先藏著（`tm-heat-pending`），等視窗有焦點、再等兩幀，所有格子依 x 淡入（720 / 280 ms、`ease`）。視窗看不到時等看得到才播。趨勢線量了實際寬度當 viewBox（不拉伸、線寬 2、圓端點），`getTotalLength()` 才是畫面上的長度。
- history 關閉時沒有趨勢視圖（上游同樣移除 Trends 視圖）；設定頁把它畫成隱藏、不算進可見數量，按眼睛就打開 history 並取消隱藏（上游 `setTrendEnabled`）。
- 儀表板的「每日用量」（`DashboardTrends.tsx` + `dashboardCharts.ts`，上游 dashboard.js `renderTrends`、usageCharts.js `dailyBarsChart` / `candleChart`）：資料是 `history_series_get`（每天依工具與模型的 token，今天用即時的 today），範圍取最後 N 列（有用量的日子，不補空白，與上游 `clampDaily` 相同）。K 線每根的天數：跨度 ≤ 10 天是 2 天，否則讓每根約 24 px 寬、至少 3 天，從最新的一天往回分組。動畫照上游 `animateChartGeometry` / `animateCandles`：第一次有資料、換堆疊方式或從 K 線換回長條時每根從底部長出（依序延遲 12 ms），換範圍、換圖種與資料更新時從舊位置 FLIP 過去（800 ms，位置取自模型、不量 DOM），K 線的實體展開、影線描出（560 ms）；只是視窗寬度變了不動。

## 主頁與視圖

- 視圖（`viewPrefs.ts` `VIEW_IDS`，上游 `DEFAULT_VIEW_LIST` 的 id 與順序）：`home` 主頁、`tool` 本機、`status` 狀態、`device` 全公司、`limits` 額度、`trends` 趨勢。上游獨立的 model / project / session 視圖在這裡是本機視圖的拆分（工具／模型／專案／Session），所以沒有。舊的分頁 id（localStorage `tm:view.tab`、`?tab=`、tray 的 `open-tab`）對應 local → tool、company → device。
- 可用性（上游 `availableBreakdownIds`）：趨勢要有 `historyEnabled`，額度要 `limitsEnabled` 而且至少一個 provider；其他永遠可用。
- 設定（`src-tauri/src/view_prefs.rs`，由 `Settings::validate()` 呼叫，規則逐字照上游 main.js）：`viewDisplayOrder` 空字串 = 預設順序，否則存完整排列（一個已知 id 都沒有時收成空字串）；`hiddenViews` 預設 `status`，全部隱藏時收成空字串（全部重新顯示）。自訂順序缺主頁時主頁排第一（上游 `effectiveViewDisplayOrderValue`）。這幾個 CSV 鍵與 `homeLimitAccountCount` 用寬鬆的反序列化：型別錯了只回到預設值，不會讓整個 `settings.json` 被當成壞檔改名。修改時不合法的 `heatmapMetric` / `homeActiveDaysWindow` 保留目前的值（`sanitize_patch`，上游相同），讀檔時則回到 `cost` / `all`。
- 切換（`Widget.tsx` `useVisibleViews`，上游 `visibleBreakdownOrder` / `ensureBreakdownVisible`）：目前的視圖被隱藏或停用時換到第一個看得到的；tray 以 `open-tab` 打開的隱藏視圖（`allowHidden`）離開前留在切換順序裡。目前的視圖記在 localStorage `tm:view`（不像上游存進設定）；沒記過時第一次拿到設定後開自訂順序的第一個視圖。只有 widget 視窗接 `open-tab`（`app.emit` 會送到每個視窗）、改寫 `tm:view`；設定、儀表板與邊緣額度條的 store 是載入當時的舊值，儀表板換期間只留在自己的記憶體裡，否則整份寫回會蓋掉 widget 之後的選擇。
- 底欄的循環切換鈕（`ViewSwitcher.tsx`，上游 `renderViewSwitcher`）：按一下到下一個視圖；長按 420 ms、右鍵或滑鼠移到箭頭打開選單（離開 160 ms 後關閉），選單支援方向鍵、Home／End、Esc。取代原本頁首下方的分頁列。
- 主頁模組（`Home.tsx`，上游 homeOverview.js；順序與隱藏是 `homeModuleOrder` / `hiddenHomeModules`，預設隱藏工具與裝置）：
  - 總數、工具、模型：這台電腦的本機數字（範圍時用 `range_get`）；工具不套用工具的排序與隱藏、模型一律依 token 排名（上游相同）。
  - 裝置：全公司串流的裝置（沒有 hub 時只有這台），前 4 名。本星期、最近 7／30 日用全公司分頁同一份逐台推出的範圍（`company_range_get` 的 `devices`，上游 `fixedPeriodDevices()`），沒有可用每日歷史的裝置不列；舊的 hub 沒有逐台資料時顯示說明，沒有 hub 時用本機的 `range_get`。
  - 活動：`trends_get`（見「趨勢分頁」）。上次拿到的結果在這次開啟期間留著（上游 `state.homeHistory`），回到主頁先畫它；第一次還沒拿到、或拿到的沒有用量時改用統計附帶的 30 天預覽（`pickHomeHistory`），兩邊都沒有才顯示空狀態。活躍天數依 `homeActiveDaysWindow`（`all` 取 summary、`year` 數熱力圖有用量的格子）。熱力圖的互動與進場動畫見「趨勢分頁」。
  - 額度：`homeLimitRows`（上游 app.js 同名）從 LimitsView 取每個帳號最多兩個窗口（session → daily → weekly → billing → monthly；codex 的 additional 窗口不算），預設依最低剩餘 % 由少到多，設了 `homeLimitProviderOrder` 就照它排；顯示剩餘 %（`showLimitUsed` 移植前一律剩餘），`showHomeLimitBars` 時剩不到 20% 標紅、不到 50% 用帳號色，最多 `homeLimitAccountCount` 個（1–12，預設 3）。provider 清單是 `SettingsView.supportedLimitProviders`，名稱用上游 `LIMIT_PROVIDER_CATALOG`（`limitCatalog.ts`）。
  - 點模組打開對應的視圖（模型 → 本機的模型拆分）並顯示「返回主頁」；換到其他視圖就收起來。
- 設定頁「主畫面」（`SettingsViews.tsx`，放在「顯示」之前）：視圖、主頁模組與主頁額度 provider 用同一個可拖曳清單（`ReorderList.tsx`，自己做、不引入拖放套件；把手可用鍵盤）。按下就 capture pointer（上游 rowDragController 過門檻才 capture，是怕把巢狀按鈕的 click 改送到整列；這裡按在按鈕上不會開始拖曳），放開一定回到那一列，沒按鍵的 pointermove 也會丟掉殘留的狀態。最後一個看得到的視圖或模組不能再隱藏（模組這道防護上游沒有）。主頁的「自訂主頁」先寫 localStorage `tm:settingsFocus` 再打開設定視窗，設定頁在掛上與 `storage` 事件時展開主頁模組並捲過去（兩個視窗同源，不需要 Rust）。
- 相容測試：`src/homeViews.compat.test.ts` 用隨機輸入把 viewPrefs.ts / homeOverview.ts 與上游的 viewDisplayPreferences.js、homeModulePreferences.js、limitProviderOrder.js、homeOverview.js、usageAttributionRows.js 逐一比對；找不到上游 checkout 時略過（`npm test` 與 `npm run test:compat` 都會跑）。

## 介面語言與主題

- 字串：繁中原文就是 key（`t("…")`），英文在 `src/locales/en.ts`；`src/i18n.test.ts` 掃所有原始碼，任何含中文的 `t()` key 沒有英文就失敗。tray 與 tooltip 的字在 `gui/i18n.rs`。
- 語言在模組載入時決定（`localStorage["tm:lang"]`，由設定 `language` 同步；「自動」看 `navigator.language`）。設定變了就重新載入視窗，不做執行中切換；載入後以 `ui_language` 指令告訴 Rust，tray 跟著換字。
- 色彩模式與介面主題：`theme`（色彩模式，Tauri 專有）只在 `themeColors.bg` 沒有覆寫時決定明暗；`themeColors`（上游 themePresets.js，`src/theme.ts`）的 accent / bg / text / muted 對應 `--c-accent` / `--c-app` / `--c-fg` / `--c-muted`，有背景覆寫時依 `isLightHex` 切 `.light`（上游 `themeCssVarEntries` 的 light flip）。深色 `:root` 的這四個色票 = 上游 DEFAULT_THEME、`:root.light` = 瓷白（Porcelain），`theme.test.ts` 守著；沒覆寫的鍵回到所解析明暗的底色（`basePalette`）。設定頁的色格、預設晶片與 TM1 代碼一律描述畫面上的配色（`effectiveThemeColors`），不是上游以 DEFAULT_THEME 為底的 `mergeThemeColors`：淺色模式沒有覆寫時亮的是「瓷白」、複製的是瓷白的代碼，選「預設」存整組四色（背景讓它變深色），選「瓷白」存 `{}`（`presetOverrides` 以色彩模式的底色為準）。這樣貼上複製出的代碼，兩邊畫面都與複製時相同。
- TM1 主題代碼與 Electron 版互通：欄位順序 accent-bg-text-muted 是格式的一部分，加欄位要換版本（TM2）；`tests/compat/theme-compat.test.mjs` 以上游 JavaScript 比對（常數、代碼、覆寫、CSS 對應、模型→廠商）。
- 廠商色（`vendorColors`、`src/vendorColors.ts`）：品牌表、`modelColor` 照抄上游 usageCharts.js；模型 id → 廠商只在 `src/modelVendor.ts` 一處（顏色與品牌圖示共用）。元件以 `useVendorColors()` 取合併好的表，取代上游直接改寫 `clientColors`。儀表板以 `displayColor` 提亮近黑色（上游 dashboard.js），widget 不提亮；前 N 名以外合成的「其他」固定灰色（`OTHER_BUCKET_COLOR`），不能覆寫。`kilocode`→`kilo`、`micode`→`mimo` 在 Rust `validate()` 遷移，壞的色碼直接清掉（上游留著、交給 renderer 忽略，畫面結果相同）；兩個鍵都寬鬆解析，型別錯了只當成空的，不會讓 settings.json 被當成壞檔。
- 套用：每個視窗的 store 在 `applySettings` 設 CSS 變數與 `.light`（明暗由 `resolveLight` 決定），並寫 `localStorage["tm:theme"]`、`["tm:themeVars"]` 給 `index.html` 的 pre-paint（同源共用，新開的儀表板或額度條也不會先閃預設配色）。pre-paint 不能 import，同一條規則另寫一份；`src/store.test.ts` 在假的 document 上比對兩者。系統匣圖示的墨色跟工作列、不跟主題（上游相同）。
- 趨勢圖、熱力圖用語意藍（`info`），自訂強調色不改圖表（上游 `--blue`）。
- 次要文字的 `muted` 色票（Tailwind `text-muted`，主題代碼的第四色）目前只有新寫的元件使用；既有檔案之後以一個腳本化的 commit 一次換掉，對應如下（`text-fg/70` 以上、邊框與 `bg-fg/*` 不動）：

  ```
  text-fg/40|45|50|55|60  →  text-muted
  text-fg/30|35           →  text-muted/70
  fill-fg/40              →  fill-muted
  ```
- 同一個中文字不要用在兩種意思（例如視窗模式改用「標準」，因為「一般」已是額度的標籤）。

## 動態效果（motion）

- 設定 `reduceMotion`（`system` / `on` / `off`，預設 `system`，上游 src/electron/motionPreference.js 同名）：`on` 一律減少、`off` 一律播放、`system` 跟著 Windows 的「動畫效果」（`prefers-reduced-motion`）。Rust 端和 `theme` 一樣是字串 + `validate()`：去掉前後空白、大小寫要相符，其他值回到 `system`。只影響畫面，不上傳；沒有環境變數或 CLI 旗標（上游相同）。設定頁在「一般」的「不透明度」後面。
- 總開關：`motionRuntime.applyReduceMotion()` 設 `<html data-reduce-motion>`（每個視窗在套用設定時），記進 `localStorage["tm:reduceMotion"]`，`index.html` 的 pre-paint 在第一幀就套上。`styles.css` 逐字用上游的規則：`@media (prefers-reduced-motion: reduce)` 裡 `:root:not([data-reduce-motion="off"])`，以及 `:root[data-reduce-motion="on"]`，把所有 CSS 動畫與過場縮到 0.01 ms（因此重新整理圖示的 `animate-spin` 在減少動態時不轉；按鈕在忙的時候本來就停用）。CSS 管不到 WAAPI（`element.animate`）與 rAF，所以每一個 JS 動畫開始前（rAF 每一幀也是）都問 `prefersReducedMotion()`；變成要減少時 `settleMotion()` 把 `document.getAnimations()` 全部 finish、rAF 的數字直接寫成目標值（上游 `settleMotionAnimations`）。
- 時間與判斷是純函式 `src/motion.ts`（`motion.test.ts`；`motion.compat.test.ts` 用上游的 motionPreference.js、limitResetMotion.js、breakdownRenderPolicy.js 比對），常數逐字對應上游 app.js、dashboard.js、breakdownRenderPolicy.js（40 列上限）與 limitResetMotion.js（額度重置，已移植、還沒接到畫面）。React 的部分在 `src/DataMotion.tsx`（不叫 Motion.tsx：Windows 的檔名不分大小寫，會和 motion.ts 撞名）。不用動畫套件：上游是手寫的 WAAPI + rAF、keyframe 與曲線都是固定值，`Element.animate()` 本身就是平台的慣例；framer-motion 的 layout FLIP 與 spring／tween 模型對不上這些時間與曲線。
- 動畫中的文字與長條比例一律在 `useLayoutEffect` 直接寫 DOM：數字是沒有子節點的 `<span data-motion-number>`，長條是 `.tm-bar-fill`（`transform: scaleX(var(--bar-scale))`，CSS 過場 420 ms），React 不設 `--bar-scale`，重繪不會蓋掉進行中的動畫。JS 自己動長條時暫時關掉那條的 CSS 過場（兩者同時動時 Chromium 的結果沒有定義），結束或取消時還原；超過 40 列或 `none` 時只剩 CSS 過場。
- 總數（`AnimatedNumber`，上游 app.js render 的 headline）：值變了從畫面上的值數到新的（easeOutQuart，1 秒，換期間 0.8 秒），這個視窗第一次從 0 數上來；已經在數向同一個值時讓它數完。記憶依 surface（本機總數、全公司總數）放在模組層級，主頁與本機視圖共用同一份（上游整個視窗只有一個總數），換視圖但數字沒變時不重數。泡泡展開時 widget 整個重建，一秒內掛上的總數直接顯示（上游 Windows 重建視窗時的 `suppressInitialNumberAnimation`）。成本不動畫。主頁模組的列不動畫（上游 renderHome 每次整個重建）。
- 清單（`useListMotion`，上游 `captureBreakdownMotion` / `animateBreakdownFrom` / `animateRowNumber` / `animateBarBetween` / `applyBarScale`）：surface 是同一個位置的清單（本機、全公司、儀表板的工具／模型），記憶跨元件保留每一列的值、比例與位置；這次怎麼動由 `listMotionKind` 決定：

  | 種類 | 什麼時候 | 既有的列 | 新出現的列 |
  |---|---|---|---|
  | `initial` | 視窗的第一次畫面就是這份清單（還沒換過視圖，例如冷啟動直接在本機視圖；≤ 40 列） | — | 淡入上移 240 ms（每列延遲 18 ms，最多 6 列）、長條與數字從 0，600 ms |
  | `live` / `period` | 同一個元件資料更新／換期間（前後都 ≤ 40 列） | 排名變了整列滑動 280 ms；長條與數字從畫面上的值動過去，600／800 ms | 同上 |
  | `view` | 換了拆分或視圖，包括換過視圖之後才第一次掛上的清單（不受 40 列限制） | 長條從零長出 420 ms，數字不動 | 同左 |
  | `range` | 換成範圍時換了元件（上游月份選單） | 長條從記住的長度動過去 420 ms，數字不動 | 直接顯示 |
  | `none` | 減少動態，或超過 40 列 | 只有 CSS 的 420 ms 長條過場 | 直接顯示 |

  儀表板的工具／模型清單只有長條動：第一次從 0、之後從畫面上的比例，一律 800 ms、沒有 CSS 過場，數字是一般文字（上游 dashboard.js renderBreakdown）。session 清單以期間當 key，換期間時整個重建（通常超過 40 列，上游一樣不動）；逐回合明細不動（上游相同）。

  「換過視圖」是視窗層級的旗標（`motionRuntime.noteViewChange()`，`store.setView` 在視圖真的換了時記下）：widget 預設打開主頁，本機與全公司清單幾乎都是從主頁換過去才第一次掛上，上游這時走 `renderBreakdownChange`（`animateBarsFromZero`，不拍快照、數字不動），不是第一次畫面的進場。第一次套用設定的視圖與目前視圖被隱藏時的修正帶 `quiet`，不算（上游直接 `setBreakdown`）。新掛上的長條在量版面之前先寫好 `--bar-scale`（`primeNewBars`，上游 `updateRow`），`none`、`range` 的新列才不會被 CSS 過場從零長出。
- 看不到的視窗不畫資料（上游 statsRenderScheduler.js）：`store.ts` 的 `deliver()` 在 `document.visibilityState === "hidden"` 時把 `local`、`company`、`limits` 先收著，看得到時一次套上，總數與清單從使用者上次看到的數字動到新的；系統匣模式啟動時看不到，第一次打開才從 0 數上來。設定、狀態、更新與幣別照常立即套用；即時速率的 tracker 照樣看每一筆（見「Token 速率」）。WebView2 在 Tauri 把視窗藏到系統匣時會不會把 `document.hidden` 設起來還沒實測；不會的話這道閘門不起作用（不影響功能），之後可由 `gui/window.rs` 在顯示／隱藏時送事件接到同一個閘門。
- 還沒做的（另一個工作負責的檔案）：額度分頁的重置補回動畫與切進額度時長條從零長出（`LimitsPanel.tsx`，motion.ts 的 limitResetMotion 移植與 `.tm-limit-completion` 樣式已備好），以及總數開始數時標題列狀態點的閃光（`motionRuntime.flareLiveDot()` 已經在送，`StatusDot` 還沒訂閱）。

## 分期

- **M1**：骨架、核心、`tm-agent`、相容與 E2E 測試、最小 widget 與設定視窗、`build-installer.ps1`（NSIS）。
- **M2（進行中）**：✅ Tauri updater（簽章、`latest.json`、打包腳本發佈到 hub；hub 要提供 `latest.json` 與安裝檔，本 repo 根目錄的 hub 目前沒有）。✅ watch（`--today` + 精確 delta）。✅ hub SSE 的全公司視圖。✅ limits（Claude、Codex）。
- **M3（進行中）**：✅ 英文介面、淺色主題、介面主題（TM1 主題代碼）與廠商色、工具圖示、hub 版本頁連結、工作列上方重新置頂（`gui/taskbar.rs`）、acrylic 與 DWM 圓角（`gui/chrome.rs`）、全域快捷鍵（`gui/shortcut.rs`）、縮放。
- **之後**：更多工具與 limits provider、WSL、Cursor 的手動帳號管理（貼 token、多帳號切換）。

## v1 與上游的已知差異

- 廠商圖示、遮罩與介面主題（`src/brandIcons.ts`、`src/theme.ts`、`src/vendorColors.ts`）照 2026-09-24 的上游 main 移植。上游 v0.63.1 把它們重構到 `vendorPresentation` 與 `renderer/rowIconMasks.js`，所以 `tests/compat/brand-icons.test.mjs`、`theme-compat.test.mjs` 裡對照這些的六項標成 todo：照常執行、列出差異，但不算失敗。移植跟上之後拿掉 todo。
- 只支援公司指定的七個工具（`settings::SUPPORTED_CLIENTS`）；上游其他工具的用量不會被統計。
- Cursor 只自動偵測桌面版的登入；只用 Cursor CLI、沒裝桌面版的人，要先用 `tokscale cursor login` 登入一次（上游的設定頁可以貼 token，v1 還沒有）。
- 不讀 client 的 transcript：session 的 context 佔用恆為 0、沒有標題；由 tokscale 的 `sessions[]` / `workspaces[]` 提供時間與專案。
- history 的今天那一列是 graph 掃描當下的數字，最多落後一個 `historyIntervalMs`（上游的 daily history archive 另外以即時的 today 補上，`liveDays`，v1 沒移植）。
- 全公司的本星期／最近 7、30 日：沒有可用每日歷史的裝置（不論即時數字是不是 0）不計入、在清單上標出來，底下註明台數（上游只要有一台缺歷史就整個範圍不顯示；裝置一多幾乎永遠會有這樣的一台）。裝置的日已過期時，上游以它的 IANA 時區（`periodWindows.timeZone`）算現在是哪一天，我們不帶時區資料庫，改由 `endsAt` 推出它的時差：固定時差的時區（例如 Asia/Taipei）完全相同，有日光節約的時區若在那之後切換過，只在午夜前後的那一小時可能差一天；沒有 `timeZone` 的裝置也算得出來（上游視為沒有歷史）。
- 同一台電腦不要同時跑 GUI 與 `tm-agent run`：兩者共用 deviceId，會輪流覆蓋對方的上傳。
- widget 沒有獨立的模型／專案／Session 視圖（是本機視圖的拆分），所以 `viewDisplayOrder` / `hiddenViews` 只有六個 id；目前的視圖存在 localStorage，不是上游的 `lastViewState` 設定。tray 的「開啟 ▸」子選單還沒有主頁與狀態（仍送舊的分頁 id）。
- 儀表板的熱力圖用主頁活動模組的元件，所以滑過時是聚光燈與格子上方的提示（上游儀表板是跟著滑鼠的提示）；進場動畫仍是儀表板的版本。
- 動態效果：非字串的 `reduceMotion`（null、數字）和 `theme` 一樣不收：修改時回錯，寫在 settings.json 裡會讓整個檔被當成壞檔改名（上游把它當成 `system`）。減少動態時重新整理圖示不轉（上游的是 SVG 動畫，照轉）。額度重置的補回動畫與標題列狀態點的閃光還沒接上（見「動態效果」）；狀態點之後以綠色（上傳正常）當作上游的「即時」。
- 主頁的額度重置時間用 Tauri 的「N 小時後重置」寫法；同一 provider 多個帳號時帳號名稱用信箱或方案名稱（上游依 provider 各有規則，等額度分頁的共用列移植後改用它）。關閉工具圖示時「多帳號顯示提供者名稱」固定開啟（上游相同）。
- 調色盤拖曳時只在設定視窗預覽，放開（change）才存檔並套到其他視窗（上游設定與 widget 同一個視窗，拖曳時 widget 即時變色）。
- 同一份 `themeColors` 複製出的主題代碼可能與上游不同：Tauri 編的是畫面上的配色，淺色（色彩模式或自訂淺色背景）時沒覆寫的鍵是瓷白；上游沒有色彩模式，一律以 DEFAULT_THEME 補（自訂淺色背景時文字仍是預設的淺色字）。貼上代碼存的是完整四色，兩邊畫面相同。
- 額度長條與邊緣額度條仍用嚴重度配色，不用廠商色（上游用品牌色；`vendorColors.ts` 已匯出 `limitProviderColor`、`colorWithAlpha`、`readableColor` 備用）。
- 「貼上並套用」用 `navigator.clipboard.readText()`，WebView2 不允許時顯示「無法存取剪貼簿。」；在輸入框按 Ctrl+V 再按 Enter 一定可以。
- `showLiveDot`、`titleIconOnly`、`settingsInTitlebar` 已照上游的名稱與預設（開、開、關）存在 settings.json，但 widget 標題列還沒照它們呈現，設定頁也還沒有開關；邊緣額度條與額度卡片標頭還沒有 provider 圖示（上游一律畫）。
