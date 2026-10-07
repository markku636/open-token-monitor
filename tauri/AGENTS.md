# AGENTS.md

給所有 coding agent 的入口。架構細節在 [docs/architecture.md](docs/architecture.md)；這裡只放指令、會被無關改動弄壞的規則，以及慣例。

## 指令

```bash
npm run tauri dev        # 開發（會先 ensure:tokscale）
npm run verify           # 前端 build + vitest + 腳本測試 + check-secrets + cargo test（核心）+ clippy（核心）；離線
npm run verify:shell     # GUI 的 clippy（generate_context! 要先有 dist/，先跑 npm run build）
npm run test:compat      # 與上游 token-monitor 及 overlay 的相容測試；用 monorepo 的 ../upstream 與 monorepo 根目錄的 overlay（可用 TOKEN_MONITOR_REPO / TOKEN_MONITOR_CUSTOM 覆寫；overlay hub 測試需要先在根目錄 npm ci）
npm run ensure:tokscale  # 下載並驗證 tokscale 到 src-tauri/binaries/
```

核心測試：`cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib --bins`（`npm run test:rust`）。

## 不能踩的線

- **wire record 必須與 hub 相容。** 上傳內容由上游 `normalizeDeviceRecord()` 解讀，欄位 camelCase、形狀以上游 `docs/API.md` 為準。改動 `src-tauri/src/wire/`、`usage/`、`hub/payload.rs` 之後一定要跑 `npm run test:compat`；它用上游自己的 JavaScript 比對。
- **核心不得依賴 Tauri。** `gui/` 以外的模組不能 `use tauri`，只能透過 `EventSink` callback 對外。`cargo test --no-default-features --lib` 必須不編 Tauri 就過。
- **secret 與簽章私鑰絕不進版控。** client secret 只在編譯時由 `TM_CLIENT_SECRET` 打進 binary，或存在 OS 認證管理員；不進 `settings.json`、不進 `tauri.conf.json`、不進前端。`scripts/check-secrets.mjs` 是 verify 的一部分。
- **只用 rustls。** 不開 reqwest 的 default-tls / native-tls；`cargo tree -i aws-lc-sys` 與 `-i openssl-sys` 必須沒有結果（Windows 建置不需要 NASM / OpenSSL）。
- **完整掃描一律序列；anchored tick 用精確 delta。** today → month → allTime 依序跑，不要平行（上游 issue #15：三個 tokscale 同時跑會把 CPU 推到 500%）。anchored tick 只掃 `--today`，month / allTime 一律 `usage/delta.rs` 推出，不要改成估算；改動後跑 `npm run test:compat`（有上游對照的 watch tick 測試）。
- **不要 watch tokscale 自己寫的 cache 目錄。** Cursor、Antigravity 在 `collector/watch.rs` 的 `SELF_SYNCED`，從不交給 watcher，會自我觸發無限重掃。新增自我同步的工具要一起加進去。
- **watch 沒有冷卻時間。** 產品承諾 3–5 秒內更新：防抖到點時有 tick 在跑就重新計時，不要加 cooldown，也不要讓 watch tick 推遲定時 tick。
- **本機用量絕不觸發額度探測。** limits 只由啟動、`limitsRefreshMs` 定時與使用者手動觸發（上游同一條規則）；每幾秒就動的用量若牽動額度 API，會被 Anthropic / OpenAI 限流。
- **額度的 accountKey 與上游位元相同。** `limits/claude.rs`、`limits/codex.rs` 的雜湊輸入不能改，hub 靠它合併 Electron 與 Tauri 裝置上的同一個帳號；改動 `limits/` 或 `wire/limits.rs` 後跑 `npm run test:compat`。
- **額度探測不碰測試以外的憑證。** 固定 JSON 來源（`--tokscale-json-dir`）不探測額度；測試用 `limits --replay` 與假的 `ClaudeEnv`。Claude 的 token 只寫回它原本所在的憑證檔。
- **client id 是分區鍵。** `settings::SUPPORTED_CLIENTS` 每個 id 都必須是 `normalize_client_name` 的不動點，每個 tokscale scan id 都要正規化回原本的 id；`client_name.rs` 的測試守著。
- **`syncUploadIntervalMs` 只能是 0 / 600000 / 1200000 / 1800000。** hub 用它算 stale 門檻，其他值會被當成 0。
- **`ensure:tokscale` 只在 app 與打包入口執行**（`beforeDevCommand`、`beforeBuildCommand`、build-installer.ps1）；install、test、lint、verify 必須離線。
- **版本單一事實來源是 `src-tauri/tauri.conf.json`**；打包腳本同步 package.json 與 Cargo.toml。
- **updater 公鑰只在打包時注入。** `tauri.conf.json` 的 `plugins.updater.pubkey` 保持空字串（plugin 要求這個欄位存在，空字串讓沒有金鑰的建置自動停用更新）；公鑰與 `createUpdaterArtifacts` 由 build-installer.ps1 以 `--config` 疊上。`tauri build` 要帶 `--ci`，否則沒設 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 時會停下來等密碼。見 [docs/release.md](docs/release.md)。
- **發佈順序是安裝檔 → `.sig` → `latest.json`。** 用戶端絕不能看到安裝檔還不存在的 feed。
- **設定鍵、環境變數、CLI 旗標是對外介面**（IT 的腳本與排程會用）。改名要當 breaking change 處理。

## 慣例

- 文件、註解、UI 字串用繁體中文；識別字與 commit 訊息用英文。UI 字串的繁中原文就是 i18n key（`t("…")`）。
- 註解寫「為什麼」，並標出對應的上游檔案與函式，方便上游改版時比對。
- commit：`<type>(<scope>): <subject>`（conventional commits），例如 `feat(collector): …`、`fix(hub): …`。
- 新增相依套件前先在 PR 說明理由（優先用生態系慣例，而不是為了少一個相依而手刻）。
- 公司版 hub 的改動（例如 `hub/releases.js`）在 monorepo 根目錄的 hub/ 做，照根目錄 AGENTS.md 的規則，不要在 tauri/ 裡複製 hub 程式。
