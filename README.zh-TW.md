# Open Token Monitor

[English](README.md)

[Token Monitor](https://github.com/Javis603/token-monitor) 的自架團隊版，給組織使用。它把每位員工電腦上 AI coding 工具（Claude Code、Codex、Cursor、Copilot 等）的用量，集中到同一個 hub。hub 有資料庫、組織架構、dashboard 與報表。

上游 Token Monitor 是桌面小工具，hub 是選用的。這個 repo 不改上游，只在上面加上公司部署需要的部分：

- **hub overlay**（`hub/`）：
  - PostgreSQL 儲存。
  - 管理員、client、API token 三種權限。
  - 從人事公告 xlsx 匯入組織（公司 → BU → 部門 → 團隊），並自動判定裝置的主人。
  - 用量 dashboard、報表 API、備份與刪除歷史資料。
  - 它疊在上游的 hub 前面執行。
- **Electron 用戶端打包**（`client/`、`packaging/`）：上游的桌面 app，打包時預填你的 hub 網址與 client 金鑰。第一次開啟就會連上 hub、每 30 分鐘上傳一次，並設定開機自動啟動。
- **Rust/Tauri 用戶端**（`tauri/`）：用 Rust 寫的輕量用戶端。它上傳的內容和上游用戶端逐欄相同，另外提供不需要畫面的 `tm-agent`。

## 畫面

hub 的用量 dashboard、管理頁與安裝說明。資料是 `npm run smoke:hub` 產生的假資料。

**用量 dashboard**：總量與上期比較、趨勢、模型分布與各公司用量，可以依期間、工具與組織單位篩選。

![用量 dashboard](docs/images/dashboard-overview.zh-TW.png)

| 帳號排行 | 裝置與 AI 工具額度 |
|---|---|
| ![帳號排行](docs/images/dashboard-accounts.zh-TW.png) | ![裝置](docs/images/dashboard-devices.zh-TW.png) |

| 管理：匯入人事公告 | 安裝說明（`/install`） |
|---|---|
| ![管理](docs/images/admin.zh-TW.png) | ![安裝說明](docs/images/install.zh-TW.png) |

## 快速開始

需要 Node.js 22.15 以上；用容器跑 hub 時另外需要 Docker。

```bash
git clone https://github.com/markku636/open-token-monitor.git
cd open-token-monitor
npm ci
cp .env.example .env          # 填 TOKEN_MONITOR_SECRET、TOKEN_MONITOR_CLIENT_SECRETS、POSTGRES_PASSWORD、TOKEN_MONITOR_DB_PASSWORD
docker build -f docker/Dockerfile -t token-monitor-hub .     # Compose 不會自己拉 hub 映像
docker compose -f docker/compose.yml --env-file .env up -d   # hub + PostgreSQL，port 80
# 開發時也可以用 JSON 檔：npm run hub
# 不用 Docker、先用假資料看看：npm run smoke:hub
```

金鑰與密碼都用長的隨機 hex：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`。接著開 <http://localhost/>，按「管理員」貼上 `TOKEN_MONITOR_SECRET`。port 80 被佔用時，在 `.env` 設 `TOKEN_MONITOR_HOST_PORT`。

接下來看你要做什麼：

| 要做的事 | 文件 |
|---|---|
| 設定與執行 hub | [docs/hub.zh-TW.md](docs/hub.zh-TW.md)、[docs/docker.md](docs/docker.md)、[docs/postgres.zh-TW.md](docs/postgres.zh-TW.md) |
| 替自己的組織打包 Electron 用戶端 | [docs/client-build.zh-TW.md](docs/client-build.zh-TW.md)、[docs/client-setup.zh-TW.md](docs/client-setup.zh-TW.md) |
| 打包或開發 Rust 用戶端 | [tauri/README.md](tauri/README.md) |
| 讓其他系統讀 hub 的資料 | [docs/reports-api.zh-TW.md](docs/reports-api.zh-TW.md) |
| 換成自己的 logo | [client/README.md](client/README.md) |

安裝檔帶著 hub 網址與 client 金鑰，所以每個組織要自己打包用戶端。

## 跟上上游

`upstream/` 是 [Javis603/token-monitor](https://github.com/Javis603/token-monitor) 的 git subtree（`--squash`），本 repo 從不修改它；有人改了，`npm run verify` 就會失敗。本 repo 每一處複製、修補或移植上游程式的地方，不是有測試守著，就是列在 [upstream-touchpoints.json](upstream-touchpoints.json)。所以升級上游可以照固定步驟做，很適合交給 AI。

```bash
npm run upstream:status              # 目前釘住的版本與上游最新版
npm run upstream:update -- latest    # 拉最新版、跑 verify、寫出 tmp/upstream-impact.md
npm run upstream:impact              # 這次更新碰到的接縫、overlay 檔案與 tauri/ 檔案清單
```

- **手動步驟**：寫在 [AGENTS.md](AGENTS.md)「升級上游」。Claude Code、Codex 等 coding agent 都會照這份檔案做。
- **Claude Code**：repo 附了 [`/upstream-update`](.claude/skills/upstream-update/SKILL.md) skill，一次跑完整個流程。
- **GitHub**：
  - [upstream-watch](.github/workflows/upstream-watch.yml) 每週一檢查上游，有新版就開 PR，內文附檢查清單。
  - 在那個 PR 留言 `@claude`，Claude 就會接手完成升級（[claude.yml](.github/workflows/claude.yml)）。這需要在 repo 設定 `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY` secret。

## 開發

```bash
npm run verify                         # 上游檢查 + lint + 測試（hub overlay）
cd tauri && npm ci && npm run verify   # Rust 用戶端：前端 build、vitest、cargo test、clippy
npm --prefix tauri run test:compat     # Rust 用戶端與上游 JavaScript、overlay hub 的相容測試
```

慣例與測試會檢查的規則見 [AGENTS.md](AGENTS.md)。

## 授權

[MIT](LICENSE)。上游 Token Monitor 為 © Javis，MIT 授權（[upstream/LICENSE](upstream/LICENSE)），見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本專案與上游作者沒有隸屬或背書關係。
