# Token Monitor 團隊版用戶端（Tauri + Rust）

員工電腦上的 AI 工具用量小工具。它讀取本機各 AI 工具（Claude Code、Codex、GitHub Copilot、Cursor…）的使用紀錄，算出 token 數與依 API 牌價換算的等值成本，並定時上傳到公司自架的 Token Monitor hub。

這個用戶端位在 open-token-monitor monorepo 的 `tauri/` 目錄。它是上游 [Javis603/token-monitor](https://github.com/Javis603/token-monitor) 員工端的重寫：

| | 上游 Electron widget | 本專案 |
|---|---|---|
| 殼 | Electron + 40k 行 vanilla JS | Tauri 2（WebView2）+ React |
| 收集器 | Node.js（`src/shared/`） | Rust（`tauri/src-tauri/src/`） |
| 掃描 | tokscale | 同一個 tokscale（相同 pin） |
| hub | 上游 hub + monorepo 根目錄的 overlay（`hub/`） | **不變**：wire record 與上游逐欄相容 |
| 安裝檔 | electron-builder NSIS | Tauri NSIS（currentUser，免管理員） |

monorepo 的配置：`upstream/` 是上游 token-monitor（git subtree），根目錄是 hub、資料庫、報表的 overlay（`hub/` 等），`tauri/`（本目錄）只負責員工端。

## 支援的工具

| 工具 | 資料來源 | 說明 |
|---|---|---|
| Claude Code | `~/.claude/projects/`、`~/.claude/transcripts/`（或 `$CLAUDE_CONFIG_DIR`） | tokscale 直接讀 |
| Codex | `~/.codex/sessions/`、`archived_sessions/`（或 `$CODEX_HOME`） | tokscale 直接讀 |
| OpenCode | `~/.local/share/opencode/`（或 `$XDG_DATA_HOME`） | tokscale 直接讀 |
| Hermes Agent | `~/.hermes/state.db`、`%LOCALAPPDATA%\hermes\state.db`（或 `$HERMES_HOME`） | tokscale 直接讀 |
| Cursor IDE / Cursor CLI | Cursor 帳號層級的用量匯出 → `~/.config/tokscale/cursor-cache/` | 每次掃描前（最多每 5 分鐘）自動偵測 Cursor 桌面版的登入並同步；IDE 與 CLI 都算得到。Cursor 的後台要幾分鐘才會出現剛結束的對話 |
| Antigravity | IDE：`~/.gemini/antigravity*/` → 同步進 tokscale 的 cache；CLI：`~/.gemini/antigravity-cli/conversations/` | IDE 的用量要在 Antigravity 執行中才同步得到；CLI 直接讀 |
| GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`、`~/.copilot/`（`otel/`、`data.db`、`session-store.db`） | tokscale 直接讀；自訂的 OTel 匯出檔用 `$COPILOT_OTEL_FILE_EXPORTER_PATH` |

Cursor 的同步會把桌面版的登入 token 寫進 tokscale 的帳號檔（`~/.config/tokscale/cursor-credentials.json`，與上游 Electron 版、`tokscale cursor login` 共用），只在本機使用，不會上傳到 hub。額度（limits）目前規劃 Claude Code 與 Codex。

## 開發

需要 Node 22+、Rust 1.88+（MSVC toolchain）、WebView2（Windows 11 內建）。

```powershell
npm install
npm run tauri dev          # 第一次會下載 tokscale 並編譯 Rust，約 3–5 分鐘
```

沒有內建公司 hub 的建置是「本機模式」：只統計、不上傳。要連測試 hub：

```powershell
$env:TOKEN_MONITOR_HUB_URL = "http://127.0.0.1:17321"
$env:TOKEN_MONITOR_SECRET  = "<client secret>"
npm run tauri dev
```

無頭代理程式 `tm-agent`（排程、伺服器、除錯用）：

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --bin tm-agent -- doctor
cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --bin tm-agent -- once --dry-run --json
```

## 打包

在 Windows 建置機上執行（需要 Node、Rust、MSVC Build Tools；會下載 tokscale、NSIS 與 WebView2 bootstrapper）：

```powershell
# 本機模式（不內建 hub，檔名帶 -local，不要發給員工）
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1

# 公司版：內建 hub 位置與 client secret（只從環境變數或檔案讀），附自動更新簽章，直接發佈到 hub
$env:TM_CLIENT_SECRET = "<client secret>"
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -HubUrl https://<hub> -SetVersion 0.2.0 `
    -SigningKeyFile D:\secure\tokenmonitor.key -ReleasesDir \\<hub-host>\releases
```

產出放在 `release\v<版本>\`：安裝檔、updater 簽章 `.sig` 與 `latest.json`。安裝好的電腦每小時向 hub 檢查一次新版，下載並驗章後等使用者按「重新啟動以更新」。金鑰的產生與保管、發佈順序與檢查見 [docs/release.md](docs/release.md)。安裝檔目前沒有程式碼簽章（第一次執行會有 SmartScreen 警告）。

**GitHub 發行**：推 `client-v*` tag 時，[client-release.yml](../.github/workflows/client-release.yml) 會用 `-GitHubRepo <owner>/<repo> -DownloadBase <Release 下載位置>` 打包 `Token-Monitor-Rust_<版本>_x64-setup.exe`，和 Electron 版放在同一個 Release。這種安裝檔不帶 hub 與金鑰，使用者在設定的「公司 hub」自己填；它從 repo 最新 Release 的 `latest.json` 自動更新。repo 要先設定 secret `TAURI_SIGNING_PRIVATE_KEY`（沒有密碼時 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 留空）與 variable `TM_UPDATER_PUBKEY`。Rust 版的版號和 tag 無關，有改 Rust 版時先改 `tauri.conf.json` 的版本（`-SetVersion`），否則已安裝的電腦不會更新。

## 驗證

```powershell
npm run verify             # 前端 build + vitest + secret 掃描 + Rust 單元測試 + clippy（離線）
npm run verify:shell       # GUI 的 clippy（需要先 npm run build）
npm run test:compat        # 與上游 token-monitor 及根目錄 overlay 的相容測試（用 monorepo 的 ../upstream 與根目錄的 hub/）
```

`test:compat` 把同一份 tokscale JSON 分別交給上游的 JavaScript 與 `tm-agent`，比對解析結果、hub 的 `normalizeDeviceRecord()`、上傳 payload，並在 overlay hub（含 PGlite 持久化，也就是行程內的 PostgreSQL）上實際上傳一次。`TM_COMPAT_LIVE=1` 另外用本機真的掃描結果再比一次。overlay hub 的測試要先在 monorepo 根目錄跑過 `npm ci`；上游與 overlay 的位置可用 `TOKEN_MONITOR_REPO`、`TOKEN_MONITOR_CUSTOM` 改。

## 設定與檔案位置

| 用途 | 位置 |
|---|---|
| 設定 | `%APPDATA%\io.github.markku636.tokenmonitor\settings.json`（不含 secret） |
| secret 覆寫（金鑰輪替） | Windows 認證管理員，`hub-client-secret.io.github.markku636.tokenmonitor` |
| 日誌 | `%LOCALAPPDATA%\io.github.markku636.tokenmonitor\logs\` |
| 程式 | 使用者自己的 AppData（NSIS currentUser，免管理員） |
| 設定目錄覆寫 | 環境變數 `TOKEN_MONITOR_CONFIG_DIR`（設定與日誌都搬過去；測試與演練用） |

deviceId 在第一次啟動時決定：沿用官方 Electron 版的 deviceId；裝過官方版但沒設定時用 hostname 規則；都沒有就產生 GUID。

## 文件

- [docs/architecture.md](docs/architecture.md)：分層、資料流、wire 相容性、各模組的規則與上游對應。
- [AGENTS.md](AGENTS.md)：給 coding agent 的指令與不能踩的線。
- [CHANGELOG.md](CHANGELOG.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
