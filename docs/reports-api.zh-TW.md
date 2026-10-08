# 報表 API（v1）

讀者：要從 hub 拉用量的外部系統（例如成本報表或 BI）的串接工程師。這是對外的契約：v1 只會增加欄位與端點，不相容的變動會改用 `/api/reports/v2/`。認不得的欄位請忽略。

## 連線與認證

- 網址：`https://<hub 內部網址>/api/reports/v1/…`，只限內網。
- 標頭：`Authorization: Bearer <API token>`。API token 由 hub 的管理員在 dashboard 建立，一個系統一把，格式是 `tmk_<8 碼>_<40 碼>`。它只能讀下面的端點，不能讀寫其他資料。
- token 只會在建立時給你一次，請存進你的系統的密碼保管處。弄丟、外洩或不再需要時，請管理員撤銷；撤銷與到期立刻生效，之後的請求回 `401`。
- 每把 token 有一或多個 **scope**，管理員建立時勾選。沒有那個端點的 scope 時回 `403`：

  | scope | 端點 |
  |---|---|
  | `reports:read` | `usage/monthly`、`usage/daily`、`usage/weekly`、`devices`、`accounts` |
  | `analytics:read` | `units`、`employees`、`limits`、`usage/analysis` |

  沒有勾選時只有 `reports:read`，所以之前建立的 token 讀不到 `analytics:read` 的端點，要的話請管理員另外建一把。
- 回應預設是 JSON。加上 `format=csv`（或送 `Accept: text/csv`）改回傳 CSV（`usage/analysis` 除外）。CSV 帶 UTF-8 BOM，Excel 可以直接開。

## 給程式與 AI agent 的文件

hub 上有三份英文文件，不需要 token，任何連得到 hub 的人都能讀，內容和這份文件相同：

| 網址 | 內容 |
|---|---|
| `/llms.txt` | 目錄（[llmstxt.org](https://llmstxt.org/) 的格式），給 AI agent 先讀 |
| `/llms-full.txt` | 完整的說明：每個端點、參數、欄位、錯誤與範例，一個 Markdown 檔 |
| `/api/reports/v1/openapi.json` | OpenAPI 3.1，可以匯入 Postman、Bruno，或產生各語言的 client |

文件裡的網址是你連到 hub 時用的網址（`Host`；hub 設了 `TOKEN_MONITOR_TRUST_PROXY` 時用反向代理的 `X-Forwarded-Proto` 與 `X-Forwarded-Host`）。用 AI agent 串接時，把 `https://<hub>/llms.txt` 給它即可。

## 成本的意義

- `costUsd` 是依各家 API **牌價**換算的等值成本，單位 USD，**不是實際帳單**。
- 使用訂閱方案（例如 Claude Max、ChatGPT Plus）的人，實際付的是月費。授權與訂閱費用以外部成本系統自己的資料為準。
- 每個回應都帶 `"costBasis": "api-list-price-equivalent"` 與 `"currency": "USD"`。

## 日期與歸屬

- 日期是**裝置的本地日期**。
- 裝置歸屬會保留歷史。月報逐日套用當天的歸屬，所以月中換人或換部門時，各自只算自己的那幾天。
- hub 開始累積資料之前的舊月份沒有日資料，改用月資料，依該月 1 日當時的歸屬分攤。
- 管理員「刪除歷史資料」之後，那個月以前的日資料與月資料都不在了，這些月份的報表是空的（[postgres.zh-TW.md](postgres.zh-TW.md)「刪除歷史資料」）。
- 組織是一棵樹：公司 → BU → 部門 → 團隊。依某一層分組時，每天的用量先算給當天的歸屬單位，再往上找到那一層的單位。
- 不在任何一個該層單位裡的用量（例如依 BU 分組時沒有 BU 的部門），以及沒有歸屬的裝置，合成一列「其他」：`key` 是 `null`，`label` 是 `其他`，`other` 是 `true`。這一列排在最後。
- 員工姓名：`reports:read` 的端點給人事名單上的完整姓名；`analytics:read` 的端點只給英文名，沒有英文名時用 email 在 @ 前面的部分。

## 端點

### `GET /api/reports/v1/usage/monthly`

| 參數 | 必填 | 說明 |
|---|---|---|
| `month` | 否 | `YYYY-MM`，預設是本月（UTC） |
| `groupBy` | 否 | 組織的層級：`company`、`bu`、`department`（預設）、`team`；`unit`（歸屬的單位本身，不往上合併）；或 `employee`、`client`、`model`、`device` |
| `unitId` | 否 | 只算這個單位與其下所有單位 |
| `employeeId`、`deviceId` | 否 | 篩選條件 |

```json
{
  "ok": true,
  "month": "2026-09",
  "groupBy": "department",
  "currency": "USD",
  "costBasis": "api-list-price-equivalent",
  "generatedAt": "2026-10-01T01:00:00.000Z",
  "totals": { "tokens": 870000, "costUsd": 94.2 },
  "rows": [
    { "key": "ACME/Games/RND", "label": "研發部", "path": "ACME/Games/研發部", "costCenter": "CC-200", "other": false, "tokens": 798000, "costUsd": 85.8, "devices": 2 },
    { "key": null, "label": "其他", "path": null, "costCenter": null, "other": true, "tokens": 72000, "costUsd": 8.4, "devices": 1 }
  ]
}
```

- `groupBy=employee` 的列多一個 `email`；依組織分組（含 `unit`）的列多 `path`（從公司開始的名稱路徑）與 `costCenter`。
- `devices` 是這一列裡有用量的裝置數；同一台裝置在期間內換過單位時，在每一列各算一次。
- `client` 與 `model` 的 `key` 是工具或模型的 ID，例如 `claude`、`claude-sonnet-4-5`。

### `GET /api/reports/v1/usage/daily`

- 參數：`from`、`to`，格式 `YYYY-MM-DD`，包含兩端。預設是最近 30 天。一次最多 400 天。其餘參數同月報。
- 每一列多一個 `date`。

### `GET /api/reports/v1/usage/weekly`

- 參數：`from`、`to`，格式 `YYYY-MM-DD`。範圍會擴大成完整的 ISO 週（週一到週日），回應的 `from`、`to` 是擴大後的日期。預設是最近 12 週。一次最多 400 天。其餘參數同月報。
- 每一列多一個 `week`：那一週的週一。
- `devices` 是那一週有用量的裝置數，每台裝置只算一次。

### `GET /api/reports/v1/devices`

回傳裝置清單，包含每台裝置目前的歸屬：

- 裝置：`deviceId`、`hostname`、`platform`、`agentVersion`、`lastSeenAt`。
- 員工：`employeeId`、`employeeName`、`employeeEmail`。
- 單位：`unitId`、`unitName`、`costCenter`。

### `GET /api/reports/v1/accounts`

回傳各裝置回報的 AI 帳號與方案，可以用來和授權清單對帳：

- 帳號：`provider`、`accountEmail`、`planLabel`、`status`、`updatedAt`。
- 所在裝置與歸屬：`deviceId`、`hostname`、`employeeId`、`employeeName`、`unitId`、`unitName`。

### `GET /api/reports/v1/units`

scope `analytics:read`。組織樹：每個單位，包含已停用的。

| 參數 | 必填 | 說明 |
|---|---|---|
| `active` | 否 | `true` 只要最新名單上的單位，`false` 只要已停用的；預設兩種都給 |

```json
{
  "ok": true,
  "generatedAt": "2026-10-05T08:00:00.000Z",
  "units": [
    { "unitId": "CO/BU1/RND", "name": "RND", "level": "department", "parentUnitId": "CO/BU1", "path": "CO/BU1/RND", "costCenter": "CC-200", "active": true,
      "headcount": 18, "ownHeadcount": 12, "devices": 16, "tokensLast30Days": 9800000, "costUsdLast30Days": 1204.25 }
  ]
}
```

- `level` 是 `company`、`bu`、`department` 或 `team`；公司的 `parentUnitId` 是 `null`。
- `headcount` 是這個單位與其下所有單位的在職人數，`ownHeadcount` 只算直屬。`devices` 是今天算給這個單位與其下所有單位的裝置數。
- `tokensLast30Days`、`costUsdLast30Days`：這個單位與其下所有單位最近 30 天的用量，每天依當天的歸屬計算。
- `active: false` 是最新的人事名單已經沒有這個單位；舊的用量仍可能算在它身上，所以它還會出現。

### `GET /api/reports/v1/employees`

scope `analytics:read`。人事名單上出現過的每一位員工。

| 參數 | 必填 | 說明 |
|---|---|---|
| `unitId` | 否 | 只要人事名單把他放在這個單位或其下的人；單位不存在時回 `404 unknown_unit` |
| `active` | 否 | `true` 只要最新名單上的人，`false` 只要已不在名單上的人 |

每一位：`employeeId`（員工編號）、`name`（英文名）、`email`（小寫）、`active`、`companyId`；`unitId`、`path`（最新名單上的單位）與 `effectiveFrom`（生效日）；`devices`（今天算給他的裝置數）；`tokensLast30Days`、`costUsdLast30Days`；`updatedAt`。

### `GET /api/reports/v1/limits`

scope `analytics:read`。每台裝置最後回報的每個 AI 帳號，與它的額度視窗。裝置上沒有設定的供應商（`status` 是 `notConfigured` 或 `disabled`）不列出。

| 參數 | 必填 | 說明 |
|---|---|---|
| `provider` | 否 | 例如 `claude`、`codex` |
| `deviceId`、`employeeId` | 否 | 篩選條件（歸屬以今天為準） |
| `unitId` | 否 | 今天的歸屬單位是它或其下的單位 |

- 帳號：`provider`、`accountEmail`、`accountName`、`accountLabel`、`planLabel`、`workspaceKind`、`status`（`ok`、`unauthorized`、`rateLimited`、`sourceRateLimited`、`unavailable`、`error`）、`source`、`balanceUsd`（預付餘額，供應商有回報時才有）、`updatedAt`（供應商最後回應的時間）、`receivedAt`（裝置最後上傳的時間）。
- `windows`：每個額度視窗，`kind`（`session`，例如 Claude 的 5 小時；`daily`、`weekly`、`billing`）、`label`、`usedPercent` 與 `remainingPercent`（0–100，沒有百分比時是 `null`）、`used`、`limit`、`remaining`、`currency`、`resetsAt`（重置時間）、`windowMinutes`。
- 所在裝置與歸屬：`deviceId`、`hostname`、`employeeId`、`employeeName`、`unitId`、`unitName`。
- 同一個帳號可能出現在好幾台裝置上，各自是那台裝置看到的狀態。要每個帳號一筆時，以 `provider` 加 `accountEmail` 分組，取 `updatedAt` 最新的那筆。
- CSV 是每個視窗一行（`windowKind`、`windowLabel`、`usedPercent`、`remainingPercent`、`used`、`limit`、`remaining`、`resetsAt`、`windowMinutes`），沒有視窗的帳號一行、這些欄位留空。

### `GET /api/reports/v1/usage/analysis`

scope `analytics:read`。dashboard 上的用量分析：一個單位（或全部公司、或一位員工）在區間內切成一段段的趨勢，把「焦點」和「比較期間」對照，加上底下各單位、「其他」、模型、工具、token 組成、人、裝置與 AI 帳號。只有 JSON。

| 參數 | 預設 | 說明 |
|---|---|---|
| `from`、`to` | 到今天（UTC）為止的 7 天 | 區間，最多 400 天 |
| `granularity` | `day` | `day`、`week`（ISO 週）或 `month`：區間怎麼切成 `periods` |
| `focus` | `last` | `last` 看最後一段，`range` 看整個區間 |
| `compare` | `previous` | `previous`：`focus=last` 和前一期的同一段比（日和上週同一天比；還沒過完的一期比前一期同樣的天數），`focus=range` 和緊接在前、一樣長的天數比；`year`：去年同期（日與週往前 52 週，月與整個區間用去年的同一個日期）；`custom`：`compareFrom`–`compareTo` |
| `compareFrom`、`compareTo` | — | `compare=custom` 的比較期間：最多 400 天、不能晚於今天、不能和焦點重疊 |
| `unitId` | 全部公司 | 範圍：這個單位與其下所有單位 |
| `level` | 範圍底下第一個有單位的公司或部門層級 | `units` 是哪一層的單位，必須在範圍之下（否則 `400 bad_level`）。和 dashboard 一樣只預設公司與部門；`bu`、`team` 要明確指定 |
| `employeeId` | — | 一位員工的用量，不論算在哪個單位；`unitId` 與 `level` 不看 |
| `client` | — | 只算這個工具，例如 `claude`；這時 `models` 是空的（模型的用量沒有記錄是哪個工具） |

和 dashboard 一樣只分公司與部門：人與裝置的 `unit` 是他所在的部門（沒有部門時是公司），`path` 不含 BU。其他端點（`units`、`employees` 與 `reports:read` 的報表）照舊保留四層。

回應的主要欄位（完整的欄位見 `/llms-full.txt` 與 OpenAPI）：

- `periods`：`[{ period, from, to, days }]`，`period` 是日（`YYYY-MM-DD`）、週（那一週的週一）或月（`YYYY-MM`）；頭尾可能被區間截短。
- `focus`：焦點，`focus=range` 時 `period` 是 `range`。`comparison`：`{ mode, from, to, days, partial }`。
- `scope`（範圍的單位，全部公司時是 `null`）、`employee`（只在單一員工的檢視）、`client`、`level`、`levels`、`headcount`。
- `totals`（整個區間）、`focusTotals`（焦點，另有 `unownedDevices`）、`comparisonTotals`（比較期間）：`{ tokens, costUsd, devices, employees, activeDays }`。
- `trend`：每一段一列 `{ period, tokens, costUsd, devices, employees }`。
- `units`：`level` 那一層的每個單位，焦點、比較期間、趨勢與各工具的用量；`other`：範圍裡不在任何一個該層單位的用量。
- `models`、`clients`：依模型、依工具，焦點有用量的在前，只在區間其他時候或比較期間用過的在後（焦點是 0）。
- `composition`：焦點的 token 組成（`input`、`output`、`cacheRead`、`cacheWrite`、`unclassified`；只有 `covered` 的部分知道組成）。
- `employees`：區間或比較期間有用量的每個人，加上一列 `other: true`（沒有算給任何人的用量）；`unownedDevices`（範圍的檢視：沒有算給任何人的裝置）或 `devices`（單一員工的檢視：他的裝置）；`accounts`：每個 AI 帳號的用量；`active`：焦點裡有用量的人與裝置。單一員工的檢視沒有 `units`、`accounts` 與 `active`。

答案大約快取一分鐘。hub 忙碌時回 `503 usage_busy` 並帶 `Retry-After`（秒），單一查詢超過 15 秒回 `503 usage_slow`，請縮短區間或縮小單位。大量匯出請用 `usage/daily`。

## 錯誤

| 狀態 | `error` | 說明 |
|---|---|---|
| 400 | `bad_month`、`bad_range`、`range_too_long`、`bad_group`、`bad_active` | 參數錯誤，`message` 說明原因 |
| 400 | `bad_granularity`、`bad_focus`、`bad_compare`、`bad_level`、`bad_employee`、`bad_client` | `usage/analysis` 的參數錯誤 |
| 401 | `unauthorized` | 沒有 token、token 錯誤、已撤銷或已到期 |
| 403 | `forbidden` | token 沒有這個端點的 scope |
| 404 | `unknown_unit`、`unknown_employee` | `unitId` 指的單位、`employeeId` 指的員工不存在 |
| 404 | `not_found` | 沒有這個端點 |
| 503 | `store_unavailable` | hub 沒有設定資料庫 |
| 503 | `usage_busy`（帶 `Retry-After`）、`usage_slow` | 只有 `usage/analysis`：hub 忙碌，或查詢超過 15 秒 |

## 建議的拉取方式

- 每天凌晨拉前一天的 `usage/daily`；每週一拉上一週的 `usage/weekly`；每月 1 日拉上個月的 `usage/monthly`，各個 `groupBy` 各拉一次。
- 裝置可能晚幾天才上線補傳，所以結算上個月時，建議在月初第 3–5 天再拉一次，以最後一次為準。
- `units` 與 `employees` 在每月匯入人事公告時才會變，一天拉一次就夠；`limits` 跟著裝置的上傳（每 30 分鐘）更新。
