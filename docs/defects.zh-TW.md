# Client／Server 缺陷盤點

| 項目 | 內容 |
|---|---|
| 日期 | 2026-09-23 |
| 對應上游版本 | v0.61.0；B1、B11 在 v0.63.1 仍然存在 |
| overlay 狀態 | overlay 自身的缺陷已全部修正；A6、A7、A9 由 ingest 驗證擋下 |
| 讀者 | 實作工程師、fork 維護者 |

相關文件：[資料流與儲存架構](data-flow.zh-TW.md)、[overlay 規則](hub.zh-TW.md)。

---

## 0. 摘要

1. **裝置 ID 取自 hostname（B1）。**
   - 改名或重灌會讓用量重複計算，也會打亂員工歸屬。
   - 使用上游官方用戶端時，請每台電腦手動填一個固定的裝置 ID（[client-setup.zh-TW.md](client-setup.zh-TW.md)）。
2. **hub 故障後會出現驚群（B2）。**
   - 上傳失敗後每個 tick 都重送。
   - 串流固定 3 秒重連，沒有 jitter，401 也照樣重連。
3. **中文路徑可能變亂碼（B5）。** tokscale 的 stdout 是逐塊解碼的，專案 ID 會因此浮動。

---

## 1. 範圍與讀法

- **範圍**：只列程式碼層級的缺陷。
  - 架構層級的問題見 [data-flow](data-flow.zh-TW.md) §5，這裡不重複。例如整份重寫 JSON、history 不累積、每次全量彙總、SSE 不壓縮、共用 secret。
- **位置**：只寫檔案與函式，不寫行號，因為上游每天都在變動。
- **✅**：已在記憶體中重現，或逐行讀碼確認。沒有標記的是讀碼推論，實作前要再確認一次。
- **嚴重度**：

  | 等級 | 意思 |
  |---|---|
  | 高 | 不需要惡意也會發生的資料錯誤或服務中斷 |
  | 中 | 特定情境下的資料錯誤或資源浪費 |
  | 低 | 強健度與防禦深度 |

- **維護**：某一項修掉，或確認不存在之後，就從本文刪掉，不保留歷史。overlay 擋下、但上游程式碼仍然有問題的項目，要等上游修正並同步進來之後才刪。

---

## 2. 伺服器端（上游 hub）

以下缺陷都在上游程式碼裡，單獨執行上游 hub 時全部存在。本 repo 的 hub 跑的是 overlay 入口，差別見「overlay」欄：

- **擋下**：ingest 驗證（`hub/ingestGuard.js`）在呼叫 `hub.ingest()` 之前拒絕或夾住這類輸入，重現案例在 `tests/defects.test.js`。有沒有 store 都一樣。
- 有 store 時，裝置狀態由 `hub/core.js` 持有，但它沿用 `src/shared/usage.js` 與 `src/shared/history.js` 的同一組函式，包括 `mergeDeviceRecord`、`aggregateDevices`、`aggregateHistory`，所以能擋下的只有輸入。

| # | 嚴重度 | 缺陷 | 位置 | overlay |
|---|---|---|---|---|
| A4 | 中 | 沒設 secret 時，任何網站都能讀寫 | `src/shared/http.js` `corsHeaders`、`isAuthorized` | 有設 secret 的 hub 不受影響 |
| A5 | 中 | 載入與存檔不可靠 | `src/shared/config.js` `readJson`、`writeJsonAtomic`；`src/hub/server.js` `deleteDevice()` | 有 store 時不適用 |
| A6 | 中 | 舊快照可以蓋掉新資料 | `src/hub/server.js` `ingest()` | 擋下 |
| A7 | 中 | 信任裝置時鐘 | `src/shared/usage.js` `isPeriodExpired`；`src/shared/limits/core.js` `isProviderStale`、`betterProvider` | 擋下 |
| A8 | 中 | 上游 SSE 的資源管理 | `src/hub/server.js` `writeSse()` 與 stream 路由 | 不適用，串流由 `stream.js` 處理 |
| A9 | 低 | 輸入上限與伺服器預設值 | `src/hub/server.js` `ingest()`、DELETE 路由 | 擋下 |

### A4–A9

- **A4 沒設 secret 時，任何網站都能讀寫。**
  - `isAuthorized` 在沒有 secret 時一律放行，每個回應都帶 `Access-Control-Allow-Origin: *`。`readJsonBody` 不檢查 Content-Type，所以 `text/plain` 的 POST 不需要 preflight。
  - hub 只綁在 loopback，但不檢查 Host，所以 DNS rebinding 也可行。
  - 有設 secret 的 hub 不受影響。受影響的是個人 host 模式的 widget。
- **A5 載入與存檔不可靠。**
  - `readJson` 遇到 EBUSY、EACCES 或 parse 失敗，會退回空的 store。下一次 ingest 就把真正的檔案蓋掉，只存在這個檔案裡的訂閱清單會消失。
  - `writeJsonAtomic` 的 temp 檔名固定，也沒有 fsync。在 Windows 上，rename 撞到防毒或索引程式時會 EPERM。
  - 磁碟錯誤一律回 `400 bad_request`，訊息裡帶有絕對路徑。
  - `deleteDevice()` 先改記憶體才存檔。
  - 有 store 時，裝置狀態由 `core.js` 持有，上游的 JSON 存檔不會執行，所以這一項不適用。`TOKEN_MONITOR_STORE=none` 時仍然存在。
- **A6 舊快照可以蓋掉新資料。**
  - `ingest()` 不比較 `updatedAt`，重送或排隊中的舊快照會蓋掉新的，還會拿到新的 `receivedAt`。
  - overlay：ingest 驗證比較新舊記錄的 `updatedAt`，較舊的快照回 200 但不套用，稽核記為 `rejected`。
- **A7 信任裝置時鐘。**
  - `periodWindows.endsAt` 沒有上限。設成未來時間，離線裝置的 today／month 就永遠留在總計裡。
  - limits 的 `updatedAt` 設成未來，或 `refreshMs` 設得極大，那個帳號就永遠不會 stale；多台裝置回報同一個帳號時，它永遠勝出。
  - overlay：以 hub 收到的時間為準夾住。`updatedAt` 與 limits 的時間最多超前 10 分鐘，today 的 `endsAt` 最多 2 天，month 最多 33 天，`refreshMs` 夾在 60 秒到 24 小時。
- **A8 上游 SSE 的資源管理。**
  - 沒有連線上限，每條連線各做一次 `JSON.stringify`，也忽略 `res.write` 的 backpressure。
  - 寫入失敗時只把連線移出集合，socket 與 heartbeat 仍然開著，那個用戶端永遠收不到 stats，也不會重連。
  - overlay 模式改由 `stream.js` 處理串流：每個 frame 只序列化與壓縮一次，連線積壓超過 64 MB 就斷開。
- **A9 輸入上限與伺服器預設值。**
  - `deviceId` 沒有型別、長度與格式限制：物件會變成 `"[object Object]"`，`__proto__` 會被靜默丟棄。
  - DELETE 路徑帶不合法的 `%` 時，`decodeURIComponent` 丟出例外，回 500。
  - Node 預設的 300 秒 requestTimeout 容許慢速上傳，也沒有 `maxConnections`。
  - overlay：`deviceId` 必須符合 `^[\w.-]{1,128}$`；DELETE 解碼失敗回 400；requestTimeout 60 秒、headersTimeout 20 秒、連線上限 2000。

---

## 3. 用戶端（widget／agent／collector）

用戶端的程式都在 `src/`，fork 不能修改，只能向上游提 PR，或在打包時緩解。

使用上游官方用戶端的裝置都受這些缺陷影響。能在 hub 端緩解的，已經寫在各項的處置裡。

| # | 嚴重度 | 缺陷 | 位置 |
|---|---|---|---|
| B1 | 高 | 裝置 ID 取自 hostname | `src/shared/config.js` `defaultDeviceId`；`src/electron/main.js` `postToHub` 的舊 ID 清理 |
| B2 ✅ | 中（裝置數百台時為高） | 失敗後沒有退避與 jitter | `src/electron/syncUploadScheduler.js` `uploadNow`；`src/electron/main.js` `scheduleStreamRetry`、`startStatsStream`；`src/agent/agent.js` `postUsage` |
| B3 | 中 | 午夜競態會扣掉前一天的用量 | `src/shared/collector.js` `performTick`、`collectUsageOnce` |
| B4 | 中 | payload 過大時永遠卡在 413 | `src/shared/syncPayload.js` `serializeSyncPayload`、`postSyncPayload` |
| B5 ✅ | 中 | tokscale stdout 逐塊解碼 | `src/shared/collector.js` `spawnTokscaleJson` 與 capability probe |
| B6 | 中 | 上傳失敗在 UI 上看不出來 | `src/electron/main.js` `startSyncCollector` |
| B7 | 中 | `agent:once` 失敗仍回傳 exit 0 | `src/shared/orderedSink.js` `flush`；`src/agent/runtime.js` `runAgentOnce` |
| B8 | 低 | PID 檔協調脆弱 | `src/agent/agent.js`；`src/electron/main.js` `isExternalAgentActive` |
| B9 | 低 | 串流解析沒有 idle 偵測與上限 | `src/electron/main.js` `startStatsStream` |
| B10 | 低 | 設定與本機檔案 | `src/agent/agent.js`；`src/shared/collector.js` `configFingerprint`；`src/shared/dailyHistoryArchive.js` `readDailyHistoryArchive` |
| B11 | 中 | secret 可能以明文傳送 | `src/agent/agent.js`；`src/electron/main.js` `postToHub` |

### B1 裝置 ID 取自 hostname

- **成因**：`defaultDeviceId` 取 `os.hostname()`，轉小寫後把 `[a-z0-9_-]` 以外的字元換成 `-`。
- **影響**：
  - 改名或重灌會產生第二筆記錄。hub 從不讓 `allTime` 過期，所以舊記錄會被永久重複計算。
  - hub 的 `device_owners` 歸屬也會斷掉。
  - hostname 全是非 ASCII 字元的機器，ID 都會變成 `device`。hostname 相同的複製 VM 會互相覆蓋。
  - widget 會用 `lastPostedDeviceId` 刪掉舊 ID，但 DELETE 失敗時只記 log，之後不會重試。headless agent 則完全沒有清理舊 ID 的機制。
- **處置**：
  - 每台電腦在「多裝置同步」的「裝置 ID」手動填一個固定、不重複的值，例如財產編號，而且要在第一次連上 hub 之前填好（[client-setup.zh-TW.md](client-setup.zh-TW.md)）。widget 讀的是 `settings.deviceId || defaultDeviceId()`，所以填了就不會再用 hostname。
  - 沒填的電腦仍然用 hostname。改名之後，新 ID 會把 370 天的 history 重送一次，而 hub 沒有合併裝置的功能：管理員刪除舊裝置只會軟刪除，它的用量仍然算在報表與 dashboard 裡。
  - widget 用 `lastPostedDeviceId` 刪除舊 ID 的請求，拿 client 金鑰會被 hub 以 403 拒絕。

### B2 失敗後沒有退避與 jitter ✅

- **上傳**：`uploadNow` 只在成功時更新 `lastUploadAt`。
  - 從未成功過的裝置，每次 `enqueue` 都立刻上傳。
  - 成功過的裝置，失敗之後 `elapsedMs` 一直大於間隔，10 分鐘的節流因此變成每個 tick 都送。
- **串流**：`scheduleStreamRetry` 固定 3 秒重連，沒有 jitter，401 也照樣重連。
- **agent**：`postUsage` 沒有 timeout，最多會卡在 Node 預設的 300 秒。
- **裝置多時的影響**（以 300 台為例）：hub 一重啟，300 個 widget 會在同一刻重連，各拉一份 snapshot（loadgen 模擬 300 台時約 16.6 MB，壓縮後約 0.7 MB）。hub 故障期間，每台都會一直重送最多 1 MB 的上傳。
- **處置**：
  - 提上游 PR：統一使用指數退避加 full jitter（上限約 5 分鐘），401／403 不重試，hub 請求加上 `AbortSignal.timeout`。
  - 在那之前，overlay 的 stats 快取讓重連不會重算 stats，但流量照樣增加；重送的上傳每台每分鐘最多套用一次（ingest 合併），但 hub 仍要逐次收下與驗證。pilot 期間要量測重啟後 60 秒內的連線數與出口流量。

### B5 tokscale stdout 逐塊解碼 ✅

- **成因**：`spawnTokscaleJson` 用 `stdout += chunk.toString()`。一個多位元組字元剛好被切在兩個 chunk 之間時，會變成 U+FFFD。
- **影響**：
  - 中文的專案路徑或標籤偶爾會出現亂碼。專案 ID 是路徑的 hash，所以同一個專案在不同 tick 可能對應到不同 ID，DB 的 `device_*_project_usage` 就會拆成多列。
  - stdout 也沒有大小上限。
- **處置**：
  - 提上游 PR，改成 `child.stdout.setEncoding('utf8')`，或先收集 Buffer 再 `Buffer.concat`。一行的修正，但價值很高。
  - pilot 期間觀察同一台裝置的 `project_key` 是否浮動。

### B3、B4、B6–B11

- **B3 午夜競態。**
  - anchored watch tick 在開始時就判定日期，tokscale 的 `--today` 卻要等 cursor／antigravity self-sync 之後才跑。
  - 如果 tokscale 那邊已經跨日，新的 today 約為 0，delta 會把前一整天的用量從 month／allTime 扣掉，並以前一天的日期送出。
  - 處置：提 PR，改為明確傳入 `--since`／`--until`，或掃描後再檢查一次日期。pilot 期間觀察跨日時 month／allTime 是否下降。
- **B4 payload 過大時永遠卡在 413。**
  - 除了剝掉 30 天前的 component 明細之外，history 從不裁切。
  - 收到 413 後重新序列化的結果與原本相同，所以重送會被跳過。重度使用者從此不再同步，只留一行 log。
  - 處置：提 PR，最後手段是丟掉最舊的 `history.daily`。hub 端的 413 會以 `outcome='rejected'` 寫進 `ingest_events`。body 沒有解析，所以那一列沒有 `device_id`，要以 `source_ip` 辨識是哪台機器。
- **B6 上傳失敗在 UI 上看不出來。** 本機記錄在上傳前就蓋上 `receivedAt`，UI 顯示為最新狀態，錯誤只寫進 console。
- **B7 `agent:once` 失敗仍回傳 exit 0。** `flush()` 吞掉送出錯誤，cron 或 launchd 無法察覺 401 或連不上 hub。
- **B8 PID 檔協調脆弱。**
  - agent 刪 PID 檔時不確認是不是自己的。widget 只用 `kill(pid, 0)` 判斷。
  - 程序被強制結束後 PID 檔會留著。Windows 若重用了那個 PID，widget 會以為 agent 還在跑，因而停止上傳。
- **B9 串流解析。**
  - 不檢查 heartbeat。休眠或換網路之後，widget 會顯示「Live」，資料卻是凍結的。
  - 只以 `\n\n` 切分事件，CRLF 的串流永遠解析不出來，而且 buffer 沒有上限。
- **B10 設定與本機檔案。**
  - `commandTimeoutMs` 沒有範圍限制，非數字或大於 2³¹ 時，timer 會在 1 ms 後觸發，每次掃描都逾時。
  - anchor 檔不是原子寫入，widget 與 agent 都會寫它。`configFingerprint` 沒有涵蓋 `customScanPaths`。
  - daily history archive 損毀後，每個 tick 都會失敗，不會重建。
- **B11 secret 可能以明文傳送。**
  - 遠端的 `http://` 不會警告，也沒有設定 `redirect` 政策。
  - 使用者自己輸入網址時可能填 http。Docker Compose 預設把 hub 發佈在 port 80，也就是 http：client 金鑰與用量在網路上都是明碼。
  - 處置：hub 只在內網使用，主機防火牆只開放內部的網段；要加密時，在 hub 前面放 HTTPS 反向代理，用戶端改填 `https://…`（[client-setup.zh-TW.md](client-setup.zh-TW.md)）。

另外，hubMode migration 會讓 `TOKEN_MONITOR_HUB_URL` 在全新安裝時無法開啟同步。

---

## 4. 處置總覽

| 類別 | 項目 | 做法 |
|---|---|---|
| 上游 PR | B2、B3、B4、B5、B6、B7、B9 | B5 最小、價值最高，優先 |
| pilot 觀測 | B2、B3、B4、B5 | 重啟後的連線數與流量、跨日時 month／allTime 下降、413 次數、`project_key` 浮動 |
