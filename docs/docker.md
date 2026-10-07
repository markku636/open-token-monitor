# Docker

`docker/Dockerfile` 透過 overlay 入口建置 **Node hub**：映像裡的 `hub/server.js`，也就是上游的 `src/hub/server.js` 加上 overlay（資料庫、dashboard、報表）。這是把上游 README 的 [Multi-device sync](../upstream/README.md#multi-device-sync) 方案 B 放進容器。

widget 與 collector **不在**映像裡執行，映像裡也沒有用戶端安裝檔。每台裝置安裝上游的官方用戶端，手動設定 hub 網址與 client 金鑰後回報到這個 hub（[client-setup.zh-TW.md](client-setup.zh-TW.md)）；hub 只儲存並彙整它們送來的資料。

## 建映像

發行用的映像一律由 `npm run build:image` 建置：它只取已 commit 的檔案，打包時寫好這一版的文件，並且跑冒煙測試（[packaging.zh-TW.md](packaging.zh-TW.md)）。

build context 是本 repo 的根目錄，映像保留同樣的佈局：overlay 在 `/app`，上游在 `/app/upstream`。開發時也可以直接建置，但用的是 working tree，包括還沒 commit 的改動：

```bash
docker build -f docker/Dockerfile -t token-monitor-hub .
```

BuildKit 會自動採用 Dockerfile 旁邊的 `docker/Dockerfile.dockerignore`，所以 build context 只有映像用得到的檔案，不含 `.env` 與 `data/`。

## 啟動

在本 repo 的根目錄：

```bash
docker compose -f docker/compose.yml --env-file .env up -d
```

`.env` 放在本 repo 根目錄，把 `TOKEN_MONITOR_SECRET` 設成私密的值。Compose 檔不會自己建映像（`pull_policy: never`），用的是本機的 `token-monitor-hub:latest`。

兩個旗標都不能少，之後的 `docker compose … stop|logs|down` 也都要帶同樣兩個：

- `-f` 指定本 repo 的 Compose 檔。
- `--env-file .env` 讓 Compose 從 repo 的 `.env`（也就是 `npm run hub` 用的同一個檔案）讀 `${TOKEN_MONITOR_SECRET}`，而不是去 Compose 檔旁邊找。

專案名稱已在檔案內釘為 `token-monitor`，不會隨指令指到的目錄改變。

接著開 <http://localhost/>，按「管理員」貼上 admin 金鑰。每台裝置在上游用戶端的 Settings → Multi-device Sync 填 `http://<host-or-lan-ip>` 與 client 金鑰。

hub 發佈在主機的 **port 80**，所以網址不用帶 port。

- 容器裡的 hub 仍然聽 17321：它以無特權的使用者執行，不能綁 1024 以下的 port。由 Docker 把主機的 80 轉進去。
- 主機的 80 已經被佔用（IIS、其他網站）時，在 `.env` 設 `TOKEN_MONITOR_HOST_PORT=8080` 之類的其他 port，網址就要帶上它（`http://<host>:8080`）。
- 用 `TOKEN_MONITOR_HOST_PORT`，不要用 `TOKEN_MONITOR_PORT`：`npm run hub` 也讀同一份 `.env`，會把 `TOKEN_MONITOR_PORT` 當成自己要聽的 port。
- rootless Docker 預設不能發佈 1024 以下的 port，要先調整主機的 `net.ipv4.ip_unprivileged_port_start`，或改用其他 port。
- port 80 是明碼的 http，client 金鑰會以明碼傳送。正式環境請在前面放 TLS 反向代理（443），見下方「這裡的 secret 不是可選的」。

不用 Compose：

```bash
docker run -d --name token-monitor-hub --init \
  -p 80:17321 \
  -e TOKEN_MONITOR_SECRET=your-private-secret \
  -v token-monitor-data:/data \
  token-monitor-hub
```

## PostgreSQL

`compose.yml` 內含 PostgreSQL 18，hub 等它健康之後才啟動。`.env` 除了 `TOKEN_MONITOR_SECRET`，還需要：

```bash
# .env
POSTGRES_PASSWORD=…                 # 超級使用者 postgres，只給 IT
TOKEN_MONITOR_DB_PASSWORD=…         # hub 的帳號 token_monitor
TOKEN_MONITOR_DB_READONLY_PASSWORD=… # 選填：唯讀登入帳號 token_monitor_reader
```

- 第一次在空的 volume 上啟動時，`docker/postgres/initdb/10-token-monitor.sh` 建立 schema 與這些帳號，之後就不再執行。
- hub 用 `token_monitor` 連線，網址由 Compose 組出來；要改用 IT 的 PostgreSQL，就在 `.env` 設 `TOKEN_MONITOR_DATABASE_URL`，並且只啟動 hub：`docker compose -f docker/compose.yml --env-file .env up -d --no-deps hub`。
- 有資料庫時，上游的 JSON 檔只是開機時從資料庫重建的快取，所以放在 tmpfs（`/cache/devices.json`）。
- 5432 發佈在主機的 **loopback**（`127.0.0.1:5432`），給 Docker 主機上的資料庫工具與 PostgreSQL 測試用。hub 走 Compose 內部網路，不經過這個 port。主機上的 5432 已經被佔用時，在 `.env` 設 `POSTGRES_HOST_PORT=55432` 之類的其他 port。要從別台連時，走 SSH tunnel；要讓別台直接連，設 `POSTGRES_HOST_BIND=0.0.0.0`，但要先在主機上執行 `deploy/postgres-lan-firewall.sh` 限制來源，因為 ufw 管不到 Docker 發佈的 port（[postgres.zh-TW.md](postgres.zh-TW.md)「從其他電腦連線」）。
- 資料在具名 volume `postgres-data`。PostgreSQL 18 的映像把資料放在 `/var/lib/postgresql/18/docker`，所以 volume 掛在 `/var/lib/postgresql`。

帳號、權限、備份與監控見 [postgres.zh-TW.md](postgres.zh-TW.md)。

## 這裡的 secret 不是可選的

沒有 `TOKEN_MONITOR_SECRET` 的 hub 無法分辨自己的 widget 和任何其他呼叫者，所以會把綁定位址夾到 loopback，讓帳號身分不外流到網路。在容器裡那個 loopback 是**容器自己的**——對外發佈的 port 會接受連線但什麼都不回。缺少變數時 `docker compose up` 會立刻帶訊息失敗；手寫的 `docker run` 則會啟動然後看起來莫名其妙地沒反應。

secret 裡不要有 `$`：Compose 會把 `.env` 值裡的 `$` 當變數展開，而 hub 用的 dotenv 不會，兩邊就會拿到不同的值。若非用不可，在 `.env` 裡用單引號包起來（`TOKEN_MONITOR_SECRET='...'`，兩邊都會照字面讀），或直接用產生的 hex / base64url 字串。

公司版的金鑰（見 [hub.zh-TW.md](hub.zh-TW.md#設定) 的「設定」）：`TOKEN_MONITOR_SECRET` 是 admin 金鑰，`TOKEN_MONITOR_CLIENT_SECRETS` 發給每一位使用者在用戶端手動輸入；其他系統讀報表用管理員在 dashboard 建立的 API token。client 金鑰等於內網公開，所以**這個 hub 只能開放給內網**，不要把 port 發佈到網際網路。TLS 交給反向代理處理，反向代理設定好之後，再把 `TOKEN_MONITOR_TRUST_PROXY` 設為 `1`。

`TOKEN_MONITOR_PUBLIC_DASHBOARD=1` 讓 dashboard 不用金鑰就能看統計，代價是內網任何連得到 hub 的人都看得到全公司的用量（使用人數與活躍裝置的明細列出姓名、主機名稱與各自的用量，帳號排行列出每個 AI 帳號的 email 與用量；員工的 email、員工編號與個人用量檢視仍然只給管理員；只有一兩個人的單位，單位的數字實際上就是那個人的用量）。用量分析的計算比較重，同時最多算 2 個、排隊 16 個，再多時不帶 admin 金鑰的請求收到 503 `usage_busy`，頁面幾秒後自動重試。外部網站無法透過員工的瀏覽器讀取，因為跨站請求會被拒絕，回應也不帶 CORS。但 DNS rebinding 要靠 TLS 擋，所以開啟前先讓反向代理提供 https。

在反向代理後面，`GET /api/stats/stream` 是 Server-Sent Events：要對它關閉回應緩衝（nginx 會遵守 hub 已經送出的 `X-Accel-Buffering: no`；其他代理可能需要 `proxy_buffering off`），否則連上的 widget 會退回慢速輪詢。

## 資料

- **用 Compose**：所有資料都在 PostgreSQL，也就是具名 volume `postgres-data`。hub 的 JSON 檔只是快取，放在 tmpfs。
- **備份**：hub 每天以映像裡的 `pg_dump` 備份資料庫，放在另一個具名 volume `hub-backups`（容器裡的 `/backups`），管理員也可以在 dashboard 立即備份、下載與刪除。`3.deploy-ubuntu.ps1 -ResetDatabase` 只刪 `postgres-data`，備份會留下來；**`docker compose down -v` 會刪掉所有 volume，連備份一起**，要清空資料庫請用 `-ResetDatabase`。細節與還原見 [postgres.zh-TW.md](postgres.zh-TW.md)「備份與還原」。
- **只用 `docker run`、沒有資料庫**：裝置記錄寫在 `/data/devices.json`（`TOKEN_MONITOR_DATA_FILE` 的預設值是在映像裡設定的，不是 repo 預設的 `data/`）。要把 `/data` 放在 volume 上，否則重建映像後 hub 會是空的，每台裝置都得重新同步。這種 hub 沒有組織、報表與用量分析。

容器以無特權的 `node` 使用者（uid 1000）執行。**具名** volume 會從映像繼承正確的擁有權；bind mount（`-v /srv/token-monitor:/data`）帶的是主機的擁有權，所以若 hub 回報無法寫入儲存檔，先在主機上 `chown 1000:1000 /srv/token-monitor`。

## 設定

| 變數 | 映像內預設值 | 說明 |
|---|---|---|
| `TOKEN_MONITOR_SECRET` | *(無)* | 必填。必須和每台裝置與 agent 送出的相同。 |
| `TOKEN_MONITOR_PORT` | `17321` | 容器裡 hub 聽的 port。不要改：要換對外的 port，改 `TOKEN_MONITOR_HOST_PORT`。 |
| `TOKEN_MONITOR_HOST_PORT` | `80` | 只有 `compose.yml` 讀：hub 發佈在主機的哪個 port。 |
| `TOKEN_MONITOR_HOST` | `0.0.0.0` | 容器自己的介面，不是主機的。 |
| `TOKEN_MONITOR_DATA_FILE` | `/data/devices.json` | 沒有資料庫時必須留在 volume 內。`compose.yml` 有資料庫，所以改放 tmpfs 的 `/cache/devices.json`。 |
| `TOKEN_MONITOR_STALE_AFTER_MS` | *(hub 預設)* | 裝置多久沒回報就算 stale。 |
| `TOKEN_MONITOR_BACKUP_DIR` | `/backups` | hub 內建備份的資料夾，`compose.yml` 掛 volume `hub-backups`。 |

`compose.yml` 另外把 overlay 的變數從 `.env` 傳進容器，包括金鑰、`TOKEN_MONITOR_DATABASE_URL` 與串流時間窗等，完整清單與預設值見 [hub.zh-TW.md](hub.zh-TW.md#設定) 的「設定」。沒填的變數等於不使用那項功能。

overlay 入口讀的旗標與變數涵蓋 `npm run hub` 的全部；上游若新增了 overlay 沒讀的項目，`tests/hubOverlayBootstrap.test.js` 會失敗。

## 關於映像

- 基底 `node:22-alpine`，對應專案的 `engines.node`（≥ 22.15）。另外以 apk 裝 `postgresql18-client`，給 hub 的備份用；主版本和 `compose.yml` 的 `postgres:18-alpine` 相同，`pg_dump` 不能比資料庫舊。從 `upstream/` 只複製 `package.json`、`src/shared/`、`src/hub/`；從本 repo 只複製 `package.json`、`upstream.js` 與 `hub/`。
- 執行期相依依本 repo 的 `package-lock.json` 以 `npm ci --omit=dev` 安裝：上游 hub 的 `dotenv`（版本同上游的 lockfile）與資料庫 driver。上游自己的 `package.json` 不安裝，Electron 的 updater 與永遠不會載入的 koffi / tokscale 原生二進位都不會拉下來。
- `HEALTHCHECK` 輪詢 `/api/health`，不需要 secret 就會回應（overlay 加的 dashboard 路徑也不需要，但 health 才是為此設計的路由）。
- overlay 會處理 `SIGTERM`，所以 `docker stop` 立刻返回，而不是等完整個寬限期；以 PID 1 執行又沒有 handler 的程序會直接忽略它。`--init`（Compose 的 `init: true`）是另一回事：它多一個會回收孤兒程序並轉送訊號的 PID 1，就算沒有 handler 也能讓 `docker stop` 快速結束，但那是硬殺；overlay 的 handler 才是先關閉 SSE 串流、再以 exit 0 乾淨結束。
- 映像裡沒有任何東西依賴被修改過的上游檔案，所以更新 `upstream/` 不會改變建置方式，重建一次就能拿到新的 hub 程式碼。
