# PostgreSQL（維運說明）

hub 的資料存在 PostgreSQL。這份文件寫給維運資料庫的 IT：要準備什麼、帳號與權限怎麼分、怎麼備份與監控。schema 以 [`hub/persistence/sql/`](../hub/persistence/sql/) 為準。

## 為什麼是 PostgreSQL

- 資料庫由 IT 維護，PostgreSQL 的角色與權限可以細到 schema、資料表、欄位與列（row-level security），報表工具可以拿到一個只能讀的帳號。
- 擴充性：全文檢索、向量（pgvector）、IP 位址型別與地理位置、快取等都有成熟的做法，見最後的「擴充方向」。
- 一律全新安裝 PostgreSQL，不提供從 MySQL 遷移資料的工具。MySQL 與 SQLite 的支援已經移除。

## 需求

- PostgreSQL 15 以上，已在 18 上測過。不需要任何 extension。
- 一個資料庫、一個 schema（預設 `token_monitor`）與以下三種角色：

| 角色 | 用途 | 權限 |
|---|---|---|
| 超級使用者（例如 `postgres`） | 只給 IT | 全部。hub 絕不使用這個帳號。 |
| `token_monitor` | hub 自己 | 擁有 schema `token_monitor` 與其中所有物件。開機時執行 migration，所以需要在這個 schema 裡建立資料表的權限；其他 schema 一律沒有權限。 |
| `token_monitor_readonly` | 報表工具、BI、IT 查詢 | 這個 schema 的 `USAGE` 與所有資料表、view 的 `SELECT`。hub 之後新增的資料表也自動可讀（default privileges）。登入帳號 `token_monitor_reader` 是它的成員，而且每個連線預設唯讀。 |

### Docker 內建的 PostgreSQL

`docker/compose.yml` 已經內含 `postgres:18-alpine`。第一次在空的 volume 上啟動時，[`docker/postgres/initdb/10-token-monitor.sh`](../docker/postgres/initdb/10-token-monitor.sh) 會建立上面三種角色與 schema。`.env` 需要：

| 變數 | 說明 |
|---|---|
| `POSTGRES_PASSWORD` | 超級使用者 `postgres` 的密碼。 |
| `TOKEN_MONITOR_DB_PASSWORD` | hub 的帳號 `token_monitor` 的密碼。Compose 會用它組出 hub 的 `TOKEN_MONITOR_DATABASE_URL`。 |
| `TOKEN_MONITOR_DB_READONLY_PASSWORD` | 選填。有設才建立唯讀登入帳號 `token_monitor_reader`。 |
| `POSTGRES_HOST_PORT` | 選填，預設 `5432`。 |
| `POSTGRES_HOST_BIND` | 選填，預設 `127.0.0.1`。設成 `0.0.0.0` 讓其他電腦直接連線，見下方「從其他電腦連線」。 |

- 密碼請用 hex 之類不含 `@ : / ? #` 的字串，否則要先做 URL 編碼才能放進連線網址。
- 這三個密碼只在**第一次建立 volume 時**生效。之後要改密碼，請用 `ALTER ROLE … PASSWORD`，再同步改 `.env`。
- 5432 預設只發佈在主機的 **loopback**（`127.0.0.1`），給 Docker 主機上的資料庫工具與 PostgreSQL 測試用；hub 走 Compose 內部網路。從別台連時，走 SSH tunnel 最簡單，伺服器不用改：

  ```bash
  ssh -N -L 15432:127.0.0.1:5432 <帳號>@<hub 主機>
  # 另開一個視窗：postgres://token_monitor_reader:<密碼>@127.0.0.1:15432/token_monitor
  ```

### 從其他電腦連線

要讓報表工具或其他電腦不經 SSH 直接連 `<hub 主機>:5432` 時：

1. **唯讀帳號**：volume 建立時沒設 `TOKEN_MONITOR_DB_READONLY_PASSWORD` 的話，`token_monitor_reader` 不存在。用超級使用者執行下方「IT 自己的 PostgreSQL」最後三行 SQL 建立，再把密碼寫進 `.env.ubuntu` 的 `TOKEN_MONITOR_DB_READONLY_PASSWORD` 留存。
2. **防火牆**：ufw 管不到 Docker 發佈的 port（Docker 自己在 FORWARD 的規則排在 ufw 前面），所以 [`deploy/postgres-lan-firewall.sh`](../deploy/postgres-lan-firewall.sh) 把規則放在 Docker 留給管理者的 `DOCKER-USER` chain，只讓指定的網段連到發佈的 port，並裝一個 systemd 服務，重開機後在 Docker 啟動前放回去。**先做這一步再開 port**：

   ```bash
   scp deploy/postgres-lan-firewall.sh <帳號>@<hub 主機>:
   ssh -t <帳號>@<hub 主機> "sudo bash postgres-lan-firewall.sh"   # 預設 192.168.0.0/16、5432
   # 其他網段或 port：sudo bash postgres-lan-firewall.sh 192.0.2.0/24,198.51.100.0/24 5432
   ```

3. **開 port**：`.env.ubuntu` 加 `POSTGRES_HOST_BIND=0.0.0.0`，GitLab 的 `TM_HUB_ENV` 也換成新的全文，再部署 hub（[hub.zh-TW.md](hub.zh-TW.md#部署)「部署」）。兩邊都要改：部署時上傳的 `.env` 會換掉伺服器的，只改一邊的話，用另一邊部署就會關回 loopback。
4. **連線**：`postgres://token_monitor_reader:<密碼>@<hub 主機>:5432/token_monitor`。

- 只有 IPv4；連線沒有 TLS 加密，只在公司內網使用。
- PostgreSQL 本身不分來源，`postgres` 與 `token_monitor` 從同樣的網段也連得到。這兩個密碼不要給報表工具。
- 關閉：`.env.ubuntu` 與 `TM_HUB_ENV` 拿掉 `POSTGRES_HOST_BIND` 再部署，然後在主機上執行 `sudo bash postgres-lan-firewall.sh --remove`。

### IT 自己的 PostgreSQL

用超級使用者在目標資料庫執行下列 SQL，再把 hub 的 `TOKEN_MONITOR_DATABASE_URL` 指過去，並且只啟動 hub（`docker compose … up -d --no-deps hub`）：

```sql
CREATE ROLE token_monitor LOGIN PASSWORD '請換成密碼';
CREATE SCHEMA token_monitor AUTHORIZATION token_monitor;
ALTER ROLE token_monitor SET search_path = token_monitor;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE token_monitor_readonly NOLOGIN;
GRANT USAGE ON SCHEMA token_monitor TO token_monitor_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE token_monitor IN SCHEMA token_monitor
  GRANT SELECT ON TABLES TO token_monitor_readonly;
GRANT CONNECT ON DATABASE token_monitor TO token_monitor, token_monitor_readonly;

-- 選填：報表工具的登入帳號
CREATE ROLE token_monitor_reader LOGIN PASSWORD '請換成密碼' IN ROLE token_monitor_readonly;
ALTER ROLE token_monitor_reader SET search_path = token_monitor;
ALTER ROLE token_monitor_reader SET default_transaction_read_only = on;
```

- 連線要加密時，在網址加上 `?sslmode=require`（或 `verify-full`，搭配伺服器憑證）。
- hub 找不到 schema 時會自己建立，但只有在帳號有權限時才會成功。上面的 SQL 已經先建好，所以 hub 的帳號不需要資料庫層級的 `CREATE`。

## 設定

| 變數 | 預設值 | 說明 |
|---|---|---|
| `TOKEN_MONITOR_DATABASE_URL` | — | `postgres://token_monitor:密碼@host:5432/token_monitor`。沒有設定時，hub 只用上游的 JSON 檔（沒有組織、報表與用量分析）。 |
| `TOKEN_MONITOR_DATABASE_SCHEMA` | `token_monitor` | hub 的 schema。小寫字母、數字與底線。 |
| `TOKEN_MONITOR_DATABASE_POOL_SIZE` | `4` | 連線池大小。另外還有一條常駐連線持有寫入鎖。 |
| `TOKEN_MONITOR_STORE_REQUIRED` | `1` | 開機時連不上資料庫就結束。設為 `0` 則改用 JSON 檔降級執行。 |
| `TOKEN_MONITOR_SESSION_RETENTION_MONTHS` | `24` | session 明細的保留月數。 |
| `TOKEN_MONITOR_AUDIT_RETENTION_DAYS` | `90` | `ingest_events` 的保留天數。 |
| `TOKEN_MONITOR_BACKUP_DIR` | 映像裡 `/backups`，`npm run hub` 是 `data/backups` | hub 內建備份的資料夾，見下方「備份與還原」。 |
| `TOKEN_MONITOR_BACKUP_KEEP` | `14` | 保留幾份每日備份；`0` 是不做每日備份。 |
| `TOKEN_MONITOR_BACKUP_HOUR` | `19` | 每日備份在 UTC 的幾點之後做（19 是台北 03:00）。 |
| `TOKEN_MONITOR_PG_DUMP` | `pg_dump` | `pg_dump` 的路徑，給 PATH 裡沒有它的開發機用。 |

## 啟動

開機時依序：

1. 連上資料庫。資料庫還沒好時（剛開機、重啟中），最多重試 30 秒。帳號密碼錯誤之類的錯誤不重試。
2. 取得寫入鎖（見下方「寫入鎖」）。
3. 缺少 schema 就建立，再執行還沒套用的 migration。每個 migration 在一個 transaction 裡整份執行，並記在 `schema_migrations`。
4. 把資料庫的內容寫進上游的 JSON 快取。
5. 啟動 hub。

log 會出現：

```
[persistence] postgres store ready (schema token_monitor): 287 device(s) rehydrated
```

資料庫的 schema 版本比 hub 認得的新時，hub 不會啟動：請升級 hub，不要降 schema。

## 命名慣例

schema 採用 PostgreSQL 的慣例，不用 MySQL 的慣例。`tests/persistenceStore.test.js` 會檢查這些規則：

- 資料表 snake_case、複數（例外：`*_usage` 這類不可數的名稱）；欄位 snake_case、單數。
- 字串用 `text`，不用 `varchar(n)`。固定的幾個值用 `text` 加上 `CHECK`，不用 enum。
- 旗標用 `boolean`，例如 `is_active`、`had_history`、`has_token_components`。
- 時間點用 `timestamptz`，欄位名稱是 `*_at`；日期用 `date`，例如 `usage_date`、`valid_from`。月份是 `text`，格式 `YYYY-MM`。
- token 數用 `bigint`，並以 `CHECK (… >= 0)` 保證不為負；金額用 `numeric(18,8)`；結構化資料用 `jsonb`；IP 位址用 `inet`。
- 沒有自然鍵的資料表用 `id bigint GENERATED ALWAYS AS IDENTITY`。
- 約束與索引沿用 PostgreSQL 的預設命名：`<表>_pkey`、`<表>_<欄>_fkey`、`<表>_<欄>_key`、`<表>_<欄>_check`、`<表>_<欄…>_idx`。
- email 一律存小寫。
- 裝置、工具、模型、session 與專案的 ID 區分大小寫，因為上游以 JavaScript 物件的 key 區分它們。PostgreSQL 的文字比較本來就區分大小寫。

兩個欄位刻意用 `text` 而不用 `jsonb`：`devices.record_json`（hub 開機時原樣回灌的整份裝置記錄）與 `hub_subscriptions.document`。它們從不被查詢，`jsonb` 會重新排序與正規化內容。

組織相關的資料表：

| 資料表 | 內容 |
|---|---|
| `org_units` | 公司 → BU → 部門 → 團隊，一棵樹。`unit_id` 是名稱路徑，`level` 是層級，`parent_unit_id` 指向上一層。 |
| `employees` | 組織名單上的員工。 |
| `employee_placements` | 每位員工目前所在的單位，每次匯入都覆寫；`effective_from` 是新進或換單位的生效日。 |
| `device_owners` | 每台裝置在一段日期歸哪位員工、算給哪個單位（`valid_from` 起，不含 `valid_to`）。依部門或團隊規則歸屬時 `employee_id` 是 NULL。 |
| `device_claims` | 用戶端回報的公司信箱。 |
| `email_assignments` | 管理員替名單上沒有的 email 寫的歸類規則：歸到部門或團隊（`unit_id`）、歸給員工，或「其他」，三者恰好一個。 |
| `org_imports` | 每次匯入名單（xlsx 或網頁編輯）：公司、檔名（網頁編輯是 NULL）、檔案日期、生效日、匯入者與變動摘要（`summary`，jsonb，只有筆數、員工編號、單位 ID 與層級）。 |
| `admin_sessions` | dashboard 管理員的登入 session，只存 token 的 SHA-256 與 admin 金鑰的指紋。 |
| `api_tokens` | 其他系統讀報表用的 API token，只存 SHA-256。`scopes` 是 `reports:read`、`analytics:read` 的一或兩個。 |

## 資料的流向

- 每次上傳先經過 `ingestGuard.js` 驗證，再由 overlay 的 core 合併；回應之後才排進寫入佇列，資料庫的延遲不會卡住裝置。
- 佇列每台裝置只保留最新的一筆。寫入失敗時以 1–30 秒退避重試。被資料庫判定為資料錯誤的記錄（SQLSTATE 22／23）會丟棄並記錄，不會卡住佇列。
- 文字裡的 NUL 字元（PostgreSQL 的 `text` 存不下）會被拿掉；無法解析的來源 IP 存成 `NULL`。一筆怪資料不會讓整台裝置寫不進去。
- 刪除裝置與寫入訂閱清單會先寫資料庫再回應。資料庫無法寫入時回 `503 storage_unavailable`，記憶體的狀態不會改變。
- 有資料庫時，上游的 JSON 檔只在開機時寫一次，當作資料庫不可用時的降級備援（`TOKEN_MONITOR_STORE_REQUIRED=0`）。資料庫才是唯一的資料來源：既有的 JSON 檔不會被匯入。

## 保留期

| 資料 | 保留 |
|---|---|
| 裝置、組織資料 | 永久 |
| 每日與每月用量 | 永久，除非管理員刪除歷史資料（見下方） |
| `device_session_monthly_usage` | `TOKEN_MONITOR_SESSION_RETENTION_MONTHS`，預設 24 個月 |
| `ingest_events` | `TOKEN_MONITOR_AUDIT_RETENTION_DAYS`，預設 90 天 |

清理在開機時與之後每 24 小時執行一次。

## 備份與還原

所有資料都在 schema `token_monitor` 裡。hub 自己會備份，也可以用 `pg_dump` 或公司既有的 PostgreSQL 備份流程。

### hub 內建的備份

hub 用映像裡的 `pg_dump`（PostgreSQL 18 的 client）備份自己的 schema，以 hub 自己的帳號 `token_monitor` 連線（`TOKEN_MONITOR_DATABASE_URL`）。檔案和部署前的備份是同一種格式（`pg_dump --format=custom --schema=token_monitor`），所以都用下面同一套還原步驟。

- **每日備份**：每天 `TOKEN_MONITOR_BACKUP_HOUR`（UTC，預設 19，也就是台北 03:00）之後做一次，保留最近 `TOKEN_MONITOR_BACKUP_KEEP` 份（預設 14，`0` 是不做每日備份）。hub 在那個時間沒有在跑時，當天稍後啟動後補做；失敗時一小時後再試。
- **手動備份**：管理員在 dashboard 的管理頁 `/admin`「資料庫備份」按「立即備份」，或 `POST /api/admin/backups`。
- **刪除前的備份**：「刪除歷史資料」一定先做一份（見下方「刪除歷史資料」）。
- 手動與刪除前的備份**不會自動刪除**，只會被管理員刪掉；刪除前的備份是被刪掉的那段歷史唯一的一份。
- 檔名：`token-monitor-<UTC 時間>-<daily|manual|purge>.dump`，例如 `token-monitor-20261002T190000Z-daily.dump`。權限 0600。
- 位置：容器裡的 `/backups`（`TOKEN_MONITOR_BACKUP_DIR`），compose 掛的是具名 volume `hub-backups`（主機上叫 `token-monitor_hub-backups`）。它和資料庫的 volume 分開，所以 `3.deploy-ubuntu.ps1 -ResetDatabase` 不會刪到備份；**`docker compose down -v` 會把它一起刪掉**。`npm run hub` 寫在 repo 的 `data/backups/`。
- dashboard 的清單可以下載與刪除每一份。下載只給管理員，不帶 CORS，hub 的 log 會記下是誰下載的。備份含所有用量、組織、姓名與 email，下載後請依公司的個資規定保管。
- 備份資料夾的剩餘空間少於 64 MB 或最新一份的兩倍時，不做備份（507 `insufficient_storage`）。
- 找不到 `pg_dump`、它的主版本比資料庫舊（例如 IT 的 PostgreSQL 19），或沒有資料庫網址時，dashboard 寫出原因，不能備份，也不能刪除歷史資料。在 Windows 上 `npm run hub` 時，用 `TOKEN_MONITOR_PG_DUMP` 指定 `pg_dump.exe` 的路徑。
- 部署腳本在部署前另外做一份，放在 release 資料夾的 `backups/`（[hub.zh-TW.md](hub.zh-TW.md#部署)「部署」）。

| 路由（admin） | 說明 |
|---|---|
| `GET /api/admin/backups` | 是否能備份與原因、每日備份的時間與保留份數、下一次的時間、剩餘空間、正在做的備份、上次的錯誤，以及每一份備份（名稱、種類、大小、時間）。 |
| `POST /api/admin/backups` | 立即備份，回 201 與那一份。已經有一份在做時 409 `backup_running`；不能備份時 503 `backup_unavailable`（附 `reason`）；空間不足 507；`pg_dump` 失敗 500 `backup_failed`。 |
| `GET /api/admin/backups/:name` | 下載那一份。 |
| `DELETE /api/admin/backups/:name` | 刪除那一份。 |

### 還原

還原一律手動做，網頁上不提供，以免一按就蓋掉現有的資料。下面的指令在 PowerShell 與 Linux 的 bash 都能照打；Windows 的 Git Bash 會改寫 `/tmp/…` 這種路徑，要先 `export MSYS_NO_PATHCONV=1`。備份檔先寫在容器裡再複製出來，因為 Windows PowerShell 的 `>` 會把二進位的輸出重新編碼：

```bash
# 手動備份（不經過 hub）
docker exec token-monitor-postgres pg_dump -U postgres -d token_monitor -n token_monitor -Fc -f /tmp/backup.dump
docker cp token-monitor-postgres:/tmp/backup.dump token-monitor-2026-10-01.dump

# 要還原 hub 的備份時，先把它拿出來：從 dashboard 下載，或直接從 volume 複製
docker cp token-monitor-hub:/backups/token-monitor-20261002T190000Z-daily.dump token-monitor-2026-10-01.dump

# 還原（先停 hub；整個 schema 刪掉再還原，備份之後才建立的資料表才不會留下來）
docker compose -f docker/compose.yml --env-file .env stop hub
docker cp token-monitor-2026-10-01.dump token-monitor-postgres:/tmp/restore.dump
docker exec token-monitor-postgres psql -U postgres -d token_monitor -c "DROP SCHEMA IF EXISTS token_monitor CASCADE"
docker exec token-monitor-postgres pg_restore -U postgres -d token_monitor /tmp/restore.dump
docker compose -f docker/compose.yml --env-file .env up -d
```

- 還原到全新的資料庫 volume 時，先讓它啟動一次，由 initdb 建好 `token_monitor` 等帳號，再照上面還原。
- 還原後重啟 hub，它會從資料庫回灌。
- 裝置每次上傳的都是完整快照，而且用戶端保留 370 天的 history，所以還原到較舊的備份之後，各裝置下一次上傳就會補回之後的日期。
- **升級 hub 之前先備份**。migration 只會往前，換回舊映像時不會把 schema 改回去；舊版 hub 看到比它新的 schema 會拒絕啟動。每一版的發行文件（`docs/releases/<版本>.md`）寫著它有沒有新的 migration，以及怎麼回滾（[packaging.zh-TW.md](packaging.zh-TW.md)）。

## 刪除歷史資料

管理員在 dashboard 的管理頁 `/admin`「刪除歷史資料」選一個月份，刪掉**所有裝置**在那個月 1 日以前的用量。只能以整個月為單位，所以每個月不是全留就是全刪。

- **刪除的資料表**：`device_daily_usage`、`device_daily_client_usage`、`device_daily_model_usage`、`device_daily_project_usage`（`usage_date` 早於那天），`device_monthly_usage`、`device_monthly_client_usage`、`device_monthly_model_usage`、`device_monthly_project_usage` 與 `device_session_monthly_usage`（`usage_month` 早於那個月）。日期是裝置的本地日期。
- **不刪的**：裝置（`devices`）、AI 帳號（`device_limits`）、組織與歸屬（`org_units`、`employees`、`device_owners` 等）、`ingest_events`（有自己的保留期）、API token 與 session。
- **步驟**：先預覽每張表會刪掉幾列、最早的日期與 tokens；輸入月份確認；hub 先做一份備份（`…-purge.dump`），備份成功才在一個 transaction 裡刪除，並記一筆 `usage_purges`。備份不能做或失敗時，什麼都不刪，也沒有跳過備份的選項。
- **刪除下限**：最新一筆 `usage_purges.before_date` 是下限。用戶端每次上傳都帶著自己 370 天的每日歷史與所有月份的合計，換了裝置 ID 或被刪除後重傳的裝置也會帶，所以 hub 寫入時一律濾掉下限以前的列（`persistence.purge.belowFloorSkipped` 是濾掉的筆數），刪掉的資料不會再回來。下限只能往上；要往回調，只能還原刪除之前的備份（那份備份裡的 `usage_purges` 也會一起回到當時）。
- 刪除後用量分析的快取立刻作廢；比較的期間早於下限時，dashboard 會寫出那段已經刪除，不是沒有用量。報表在那些月份是空的。
- **上游的畫面不受影響**：hub 記憶體與 `devices.record_json` 裡的裝置記錄仍然帶著用戶端自己的歷史，所以 `/api/stats`、`/api/history` 與用戶端 app 的多裝置畫面照樣顯示最多 370 天；被刪除的只有資料庫的用量表，也就是用量分析、報表與 SQL view 讀的資料。
- 刪掉的空間由 PostgreSQL 重複使用，不會還給磁碟；要縮小檔案得另外 `VACUUM FULL`，那段期間會鎖住資料表。

| 路由（admin） | 說明 |
|---|---|
| `GET /api/admin/usage-purge` | 目前的下限（`floor`）、最早有用量的日期與月份、本月、最近 50 次刪除的紀錄。 |
| `GET /api/admin/usage-purge/preview?month=YYYY-MM` | 刪除 `month` 以前的用量會刪掉什麼：每張表的列數，日與月的最早日期、裝置數、tokens 與成本。 |
| `POST /api/admin/usage-purge` | body `{ "month": "YYYY-MM", "confirm": "YYYY-MM" }`，`confirm` 要和 `month` 相同。月份不對或在本月之後 400 `bad_month`；`confirm` 不同 400 `confirm_mismatch`；不高於下限 409 `already_purged`；另一個刪除正在跑 409 `purge_running`；備份的錯誤同 `POST /api/admin/backups`。成功時回刪掉的列數、合計與那一份備份。 |

## 監控

`GET /api/custom/health`（admin 金鑰）回傳：

| 欄位 | 看什麼 |
|---|---|
| `persistence.queueDepth`、`retrying`、`lastError` | 資料庫是否跟得上；`retrying: true` 持續出現代表資料庫不可用 |
| `persistence.dropped` | 被丟棄的記錄數，應為 0 |
| `persistence.audit.buffered`、`dropped` | 稽核緩衝 |
| `persistence.purge.floor`、`belowFloorSkipped` | 刪除歷史資料的下限，以及上傳裡因為早於下限而沒有寫入的筆數 |
| `backups.available`、`reason`、`lastBackupAt`、`lastError` | hub 能不能備份、最後一次成功的時間與失敗的原因；`lastBackupAt` 超過一天沒更新代表每日備份停了 |
| `ingest.ingestMsP95` | 每次套用上傳的耗時，門檻 150 ms |
| `eventLoop.p99Ms` | 門檻 250 ms |
| `stream.clients`、`gzipClients`、`bytesWritten`、`slowClientsCut` | 串流連線數與流量 |

`ingest.ingestMsP95`、`eventLoop.p99Ms` 與 JSON 快取檔的大小（`cacheFile.bytes`，門檻 60 MB）是架構的升級門檻（回應的 `thresholds`）：超過任何一個，代表 overlay 現在疊在上游 hub 上的做法撐不住了，要改成在上游的儲存開接縫，或改寫路由層。超過時，hub 每 10 分鐘在 log 寫一次警告：`[overlay] past the scaling thresholds: …`，列出超過的是哪幾個。

在資料庫這一邊，hub 的連線的 `application_name` 是 `token-monitor-hub`，可以在 `pg_stat_activity` 看到。

## 用量查詢的時間上限

hub 只有一條讀寫的序列：用量分析、報表與管理的查詢，和上傳的寫入排在同一個佇列（`store.query`）。一個很慢的查詢會讓後面的上傳都等著寫入（上傳本身照樣成功，資料留在佇列）。所以 dashboard 的用量分析（`/api/custom/usage`）每一個查詢最多 15 秒：

- 在連線池的一條連線上開一個唯讀的 transaction，以 `SET LOCAL statement_timeout` 設上限，查完就結束；設定不會留在連線上，不影響上傳的寫入與 migration。
- 超過時 PostgreSQL 取消那個查詢（SQLSTATE 57014），API 回 503 `usage_slow`，不快取、也不帶 `Retry-After`，因為同樣的問題再問一次一樣慢。dashboard 請使用者縮短區間、選比較小的單位或只看一個工具。
- 上限是每一個查詢，不是整個回答；一個回答有好幾個查詢。
- 報表 API 與管理的查詢沒有這個上限。PGlite（測試）沒有 `statement_timeout`，照一般的查詢執行。

## 寫入鎖

- 一個 schema 只能有一個 hub 在寫，因為 hub 把裝置狀態放在記憶體裡，兩個 hub 同時寫會各自分岔。
- 鎖是 session 層級的 advisory lock（`pg_try_advisory_lock`），放在一條專用連線上；那條連線一斷，PostgreSQL 就會釋放鎖。
- 第二個 hub 會在開機時失敗：`another hub already holds the writer lock for schema token_monitor`。
- 持有鎖的連線中斷時，hub 會暫停寫入（上傳仍然成功，資料留在佇列），每 30 秒嘗試取回鎖。log：`writes paused`、`writes resume`。
- 同一個資料庫裡的不同 schema 互不影響。

## 直接查詢

報表 API 見 [reports-api.zh-TW.md](reports-api.zh-TW.md)。用唯讀帳號直接以 SQL 查詢時，從這三個 view 開始：

| view | 內容 |
|---|---|
| `v_daily_usage_by_owner` | 每台裝置每天的 token 與成本，加上當天的員工與單位 |
| `v_daily_client_usage_by_owner` | 同上，再依工具細分 |
| `v_monthly_cost_by_unit` | 每月依單位加總 |

- `usage_date` 是裝置的本地日期。
- `cost_usd` 是依 API 牌價換算的等值成本，不是實際帳單。

## 測試

- `npm test` 用 PGlite（編譯成 WebAssembly、在 Node 行程裡跑的 PostgreSQL），不需要資料庫伺服器。
- 寫入鎖與斷線這類需要多條連線的測試，要設 `TOKEN_MONITOR_TEST_DATABASE_URL`，指向一個可以建立 schema 的帳號才會跑。每次測試用自己的 schema，結束後刪除。例如 Docker 內建的 PostgreSQL：

  ```bash
  TOKEN_MONITOR_TEST_DATABASE_URL='postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/token_monitor' npm test
  ```

## 擴充方向

目前都**沒有用到**，只列出之後可以怎麼延伸：

- **全文檢索**：`tsvector` 加 GIN 索引，或 `pg_trgm` 做模糊比對，例如搜尋專案、session 標題或員工姓名。
- **向量**：`pgvector`，例如依使用內容做語意分群或相似度搜尋。
- **IP 位址與地理位置**：`devices.last_source_ip` 與 `ingest_events.source_ip` 已經是 `inet`，可以直接用 `<<=` 比對網段；要換算地理位置，再加一張 IP 範圍對照表或 extension。
- **快取與彙總**：materialized view 或彙總表（例如每日每單位），由排程 `REFRESH`；`UNLOGGED` 表可以當可重建的快取。
- **更細的權限**：row-level security，讓各公司的報表帳號只看得到自己的資料。
