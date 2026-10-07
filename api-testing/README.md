# API 測試

[Bruno](https://www.usebruno.com/) collection，用來確認 hub 連得到、client 金鑰對不對、有沒有裝置上傳。

## 設定

1. 把 `hub/.env.example` 複製成 `hub/.env`（不進版控），填入 hub `.env` 的 `TOKEN_MONITOR_CLIENT_SECRETS`（用戶端金鑰，不是管理員金鑰）。
2. hub 不在 `http://localhost`（Docker Compose 的預設，port 80）時，改 `hub/environments/local.bru` 的 `baseUrl`，例如 `npm run hub` 是 `http://127.0.0.1:17321`。

## 執行

- Bruno 桌面版：Open Collection 選 `api-testing/hub`，右上角環境選 `local`，對 collection 按 Run。
- CLI：`cd api-testing/hub && npx @usebruno/cli run --env local`

## 結果怎麼看

| 請求 | 通過代表 |
| --- | --- |
| Health | hub 連得到；`deviceCount > 0` 失敗表示還沒有任何裝置上傳成功 |
| Ingest - client key accepted | 回 400 `deviceId_required` 表示金鑰正確；401 表示金鑰不對 |
| Ingest - wrong key rejected | hub 有在檢查金鑰 |
| Stats / Devices | 用戶端金鑰可以讀取 |

Ingest 那兩個請求送空的 body，不會寫入用量，只會在 `token_monitor.ingest_events` 留下一筆 `rejected`。

## 模擬一筆 client 上傳

`hub/sample-upload/` 用用戶端金鑰，照桌面 client 的格式上傳一台假裝置 `bruno-test`（今天 12,345 tokens、$0.12，claude / claude-sonnet-4-5）。

- `Upload - bruno-test device`：寫入後 `deviceCount` 加 1，儀表板與 `token_monitor.device_daily_usage` 會出現 `bruno-test`。
- `Delete - bruno-test device`：刪掉它。測完記得跑，否則它會留在公司的用量裡。
- 只跑上傳：`npx @usebruno/cli run sample-upload/01-upload.bru --env local`。對整個 collection 按 Run 會上傳後馬上刪掉。
