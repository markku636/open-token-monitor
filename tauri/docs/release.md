# 發佈手冊

讀者：打包與發佈公司版的維護者。流程：準備金鑰（一次）→ 打包 → 發佈到 hub → 確認更新。

## 一次性：更新簽章金鑰

```powershell
npm run tauri signer generate -- --ci -w D:\secure\tokenmonitor.key
```

- 產生 `tokenmonitor.key`（私鑰）與 `tokenmonitor.key.pub`（公鑰）。`--ci` 產生沒有密碼的金鑰；要密碼就拿掉 `--ci` 依提示輸入，打包前再設 `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 私鑰放進你的密碼管理工具（secret store）並備份。**遺失私鑰 = 已安裝的電腦再也無法自動更新**，只能逐台手動重裝一個用新金鑰打包的版本。
- 公鑰不用提交到 repo：打包時由 `-SigningKeyFile` 同目錄的 `.pub` 自動寫進安裝檔。
- 私鑰與 `.pub` 都不能放進 repo（`.gitignore` 與 `npm run check:secrets` 會擋 `*.key`、`*.key.pub`）。

## 打包與發佈

```powershell
$env:TM_CLIENT_SECRET = "<client secret>"      # 或用 -SecretFile
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 `
    -HubUrl https://tokens.example.internal `
    -SigningKeyFile D:\secure\tokenmonitor.key `
    -SetVersion 0.2.0 -NotesFile notes.md `
    -ReleasesDir \\hub-host\token-monitor\releases
```

- 版本號要比 hub 上現有的高（updater 不接受降版）。回滾 = 發一個更高的版本。
- 產出在 `release\v<版本>\`：`TokenMonitor_<版本>_x64-setup.exe`、`.sig`、`latest.json`。
- `-ReleasesDir` 是 hub 的 `TOKEN_MONITOR_RELEASES_DIR`。腳本依序複製安裝檔 → `.sig` → `latest.json`：用戶端絕不會看到安裝檔還不存在的 feed。hub 用 Docker 的具名 volume 時，建置機寫不進去，改用 `docker cp` 依同樣順序複製。
- 沒有簽章金鑰時腳本會停下來；確定這一版不要自動更新才加 `-NoUpdater`（之後每一版都要逐台手動重裝）。
- `-NotesFile` 是 widget 更新提示與設定頁顯示的版本說明（Markdown）。規則照上游：`### 標題` 開一組、`- 項目` 一條，最多 4 組 12 條；要分語言時用 `<!-- app-update-notes:zh-TW:start -->` … `<!-- app-update-notes:zh-TW:end -->`（另有 `en`），widget 依介面語言挑。沒有標題時每一行當一條。

## 發佈前後的檢查

1. 乾淨的 VM：人工安裝 → 首次啟動 → 在 hub 的 dashboard 出現 → 用上一版安裝後等自動更新 → 解除安裝。
2. `https://<hub>/updates/latest.json` 的 `version` 是新版，`https://<hub>/downloads/releases` 列出新版與說明。widget 更新提示與設定頁的「查看完整版本資訊」會開 `https://<hub>/downloads/releases#v<版本>`，捲到那一版的段落。
3. dashboard 的「用戶端版本」（`GET /api/custom/client-release`）：落後的裝置會在一小時左右（檢查間隔 ±5 分鐘）陸續下載新版，員工按「重新啟動以更新」後版本才會變。

## 本機演練（不碰真正的 hub）

用 monorepo 根目錄的 overlay 起一個測試 hub，打一個指向它的版本：

```powershell
# monorepo 根目錄（overlay；先跑過 npm ci）
$env:TOKEN_MONITOR_SECRET='admin-e2e-0123456789'; $env:TOKEN_MONITOR_CLIENT_SECRETS='client-e2e-0123456789'
$env:TOKEN_MONITOR_PORT='17399'; $env:TOKEN_MONITOR_RELEASES_DIR="$env:TEMP\tm-releases"; $env:TOKEN_MONITOR_STORE='none'
node hub/server.js

# tauri/（-AllowHttp 會讓 updater 接受 http 的 feed，只給測試）
powershell -File .\build-installer.ps1 -HubUrl http://127.0.0.1:17399 -AllowHttp -SecretFile <檔案> `
    -SigningKeyFile <測試金鑰> -ReleasesDir $env:TEMP\tm-releases -SkipVerify -NoPause
```

執行 `src-tauri\target\release\token-monitor.exe` 前設 `TOKEN_MONITOR_CONFIG_DIR` 指到暫存目錄，並在其中的 `settings.json` 寫 `{"autostart": false}`，就不會動到這台電腦的設定與開機啟動。再用 `npx tauri signer sign` 簽一個更高版本號的安裝檔、以 `scripts/make-latest-json.mjs` 產生 feed，就能看到 log 出現 `update downloaded and verified`。演練完刪掉 `release\` 裡內建測試 hub 的安裝檔。
