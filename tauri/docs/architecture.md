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
| `ranges.rs` | renderer 的 fixedPeriodRanges.js | 只給前端顯示；今天用即時的 today（不小於 history 時） |
| `export.rs` | src/shared/exporter.js、main.js `writeExportTo` | 欄位與檔名照抄；沒有 history 時不寫 |
| `session_detail.rs` | src/shared/sessionDetail.js、sessionFiles.js、providers/opencode/session.js | 只在本機讀；`tests/compat/session-detail.test.mjs` 逐欄比對 |
| `trends.rs` | renderer 的 homeOverview.js `patchDailyToday` | 只給前端顯示；今天用即時的 today |
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
- tray：左鍵切換視窗；選單有重新掃描、設定、日誌資料夾、檢查更新（下載好後變成「重新啟動以更新」）、結束。tooltip 顯示今日用量。
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

## 全公司視圖

- 串流（`hub/stream.rs`）：`GET /api/stats/stream`，帶 `x-token-monitor-stream: 2` 與 client secret。`snapshot` / `stats` 取代快取，`freshness` 只更新各裝置的時間戳與 stale（上游 `applyFreshnessEvent`）；`: hb` 是心跳，90 秒沒有任何位元組就重連。
- gzip：fork 的 hub 每個 frame 送一個獨立的 gzip member。reqwest 0.12 的自動解壓遇到第二個 member 會報錯，所以串流的 client 用 `no_gzip()`、自己送 `accept-encoding: gzip`，再以 `flate2::write::MultiGzDecoder` 邊收邊解。不要改回自動解壓（`gzip_members_are_decoded_one_frame_at_a_time` 守著）。
- 數百台裝置時一個 frame 約 16 MB：只反序列化畫面要的欄位（`HubStats`），session 與專案明細由 serde 略過。
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

## Token 速率

- `PeriodTotals` 帶上 tokscale 的速率計數（`timedTokens`、`timedOutputTokens`、`timedDurationMs`，只算有生成時間的回覆，時間是各回覆的生成時間加總）與 `throughput`。平均速度 = 輸出 × 1000 ÷ 時間（tok/s），消耗 = token × 60000 ÷ 時間（tok/min）；四捨五入是 0 或沒有速率（範圍）時不顯示（前端 `tokenRate.ts`，上游 tokenRatePresentation.js）。
- 即時速率在前端算：每次 `stats-updated` 取 today 計數與上一次的差，任何計數變小（換日）清掉，時間沒增加沿用上一個樣本；8 秒內是即時、之後變暗，3 分鐘後顯示「—」。tracker 在 `Rate.tsx` 的模組層級訂閱 store，底欄沒顯示時基準也保持最新。範圍只有「這部裝置」：hub 串流的瘦身快照沒有各裝置的速率計數，上游的「所有裝置」不提供。

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

## 幣別

- 成本一律以 USD 計（tokscale 的牌價），只有顯示換算：前端 `fmtUsd` 乘上 `currency-updated` 事件給的匯率、加上幣別符號。匯出的檔案與額度的金額不換算（上游相同）。
- 匯率（`currency.rs`，上游 currency.js / exchangeRates.js）：手動（`currencyRates`）> 每日匯率 > 內建值（TWD 31.5、HKD 7.8、CNY 6.8）。每日匯率來自 fawazahmed0 currency-api（jsDelivr，其次 Cloudflare Pages 鏡像，各 8 秒），回應要有所有支援的幣別才算數；快取在 `<config_dir>/exchange-rates.json`，來源日期不是今天（UTC）而且抓取超過 24 小時才重抓。
- 抓取在 `gui/currency.rs` 的背景工作：啟動 20 秒後、之後每 6 小時，只在選了非 USD 幣別時；設定的幣別或手動匯率改變時立刻重算並喚醒。公司網路擋外連時安靜地用快取或內建值。

## 本星期／最近 7 日／最近 30 日

- tokscale 只掃 today / month / allTime；其他範圍由 `ranges.rs`（上游 renderer fixedPeriodRanges.js 的 `dailyForRange`、`derivePeriod`、`summaryForDaily`）從本機 history 的每日列加總：兩端都含、以裝置本地的日期鍵、沒有用量的日子補 0；今天那一列在即時數字不小於 history 時換成即時的 today（`rowFromLivePeriod`，組成依序夾住）。推出的期間只有工具與模型（含 token 組成），沒有 session、專案與速率計數；`antigravity-cli` 併進 `antigravity`。
- `range_get(range, weekStart)` 回 `ready`（總數、明細、摘要）、`loading`（還沒有 history；掃描失敗時前端依 `status.historyError` 顯示暫時無法使用）或 `disabled`。`weekStart` 由前端依 `navigator.languages[0]` 的 `Intl.Locale` 週資訊決定（不是介面語言），取不到用星期一，與上游相同。
- 期間選擇存在 view 偏好（`period`、`monthMode`）；中間那格顯示本月或選中的範圍，再點一次開選單。
- 全公司的範圍（`company_range_get`）：hub 的 `GET /api/history`（client 金鑰可讀；hub 以 `aggregateHistory` 合併所有有每日歷史的裝置，快取 60 秒）+ 全公司即時的今日（`CompanyTotals`，沒有 token 組成）。上游改抓 `/api/devices` 的完整 record 逐台重算、並要求每台都有歷史；裝置一多那份就太大，我們用 hub 合併好的版本，沒上傳每日歷史的裝置不計入（畫面有註明）。範圍沒有逐台裝置的數字。

## 趨勢分頁

- 資料：`trends_get`（`gui/views.rs` → `trends.rs`）從本機 record 的 history 取每日（有用量的日子）、每月與 summary，只帶畫圖要的欄位（約 30 KB）；今天那一格換成即時的 today（上游 `patchDailyToday`），沒有就補上。打開分頁時拉，本機有新 record 時重拉。
- 畫法照上游 renderer 的 usageCharts.js 與 homeOverview.js（前端 `trendsFormat.ts`）：熱力圖從 11 個月前那個月的 1 號往前推到星期日、每欄一週，分級是相對最大值的線性四級（≥75% / ≥50% / ≥25% / >0），依 token 或成本（view 偏好 `heatMetric`，預設成本，與上游 `heatmapMetric` 相同）；趨勢線是最後 45 列（不補空白）的平滑面積圖；期間長條：今日 = 以今天結尾的 7 個日曆天、本月 = 這個月有用量的日子、全部 = 每月。活躍天數與連續天數一律取 summary，活躍時間與峰值單日跟著期間。
- history 關閉時不顯示分頁（上游同樣移除 Trends 視圖）。
- 儀表板的「每日用量」（`DashboardTrends.tsx` + `dashboardCharts.ts`，上游 dashboard.js `renderTrends`、usageCharts.js `dailyBarsChart` / `candleChart`）：資料是 `history_series_get`（每天依工具與模型的 token，今天用即時的 today），範圍取最後 N 列（有用量的日子，不補空白，與上游 `clampDaily` 相同）。K 線每根的天數：跨度 ≤ 10 天是 2 天，否則讓每根約 24 px 寬、至少 3 天，從最新的一天往回分組。

## 介面語言與主題

- 字串：繁中原文就是 key（`t("…")`），英文在 `src/locales/en.ts`；`src/i18n.test.ts` 掃所有原始碼，任何含中文的 `t()` key 沒有英文就失敗。tray 與 tooltip 的字在 `gui/i18n.rs`。
- 語言在模組載入時決定（`localStorage["tm:lang"]`，由設定 `language` 同步；「自動」看 `navigator.language`）。設定變了就重新載入視窗，不做執行中切換；載入後以 `ui_language` 指令告訴 Rust，tray 跟著換字。
- 主題：設定 `theme`（system／dark／light），`<html class="light">` 切換 `styles.css` 的 `:root.light` 色票；`index.html` 的 pre-paint script 讀 `localStorage["tm:theme"]`，避免載入時先閃深色。
- 同一個中文字不要用在兩種意思（例如視窗模式改用「標準」，因為「一般」已是額度的標籤）。

## 分期

- **M1**：骨架、核心、`tm-agent`、相容與 E2E 測試、最小 widget 與設定視窗、`build-installer.ps1`（NSIS）。
- **M2（進行中）**：✅ Tauri updater（簽章、`latest.json`、打包腳本發佈到 hub；hub 端 monorepo 根目錄 overlay 的 `hub/releases.js` 已支援）。✅ watch（`--today` + 精確 delta）。✅ hub SSE 的全公司視圖。✅ limits（Claude、Codex）。
- **M3（進行中）**：✅ 英文介面、淺色主題、工作列上方重新置頂（`gui/taskbar.rs`）、acrylic 與 DWM 圓角（`gui/chrome.rs`）、全域快捷鍵（`gui/shortcut.rs`）、縮放。
- **之後**：更多工具與 limits provider、WSL、Cursor 的手動帳號管理（貼 token、多帳號切換）。

## v1 與上游的已知差異

- 只支援公司指定的七個工具（`settings::SUPPORTED_CLIENTS`）；上游其他工具的用量不會被統計。
- Cursor 只自動偵測桌面版的登入；只用 Cursor CLI、沒裝桌面版的人，要先用 `tokscale cursor login` 登入一次（上游的設定頁可以貼 token，v1 還沒有）。
- 不讀 client 的 transcript：session 的 context 佔用恆為 0、沒有標題；由 tokscale 的 `sessions[]` / `workspaces[]` 提供時間與專案。
- history 的今天那一列是 graph 掃描當下的數字，最多落後一個 `historyIntervalMs`（上游的 daily history archive 另外以即時的 today 補上，`liveDays`，v1 沒移植）。
- 全公司的本星期／最近 7、30 日只計入有上傳每日歷史的裝置（上游在有裝置缺歷史時整個範圍不顯示）。
- 同一台電腦不要同時跑 GUI 與 `tm-agent run`：兩者共用 deviceId，會輪流覆蓋對方的上傳。
