# 公司版用戶端：打包與發行

讀者：負責打包、發行用戶端安裝檔的人（IT、維護本 repo 的工程師）。員工怎麼安裝與設定見 [client-setup.zh-TW.md](client-setup.zh-TW.md)。

公司版用戶端就是上游的 Token Monitor Electron app，只多了一層入口（[client/electron/main.js](../client/electron/main.js)），並在打包用的複本裡改了上游的幾行（見「改動上游程式的地方」）。`upstream/` 一行都不改。

| 項目 | 公司版 | 上游官方版 |
|---|---|---|
| 開機自動啟動 | 第一次安裝後開啟 | 關閉 |
| 開機自動啟動時 | widget 縮小到工作列，見「運作方式」第 4 步 | 顯示 widget |
| 保持在工作列上方（Windows，實驗性） | 每台電腦開啟一次 | 關閉 |
| 系統匣（Windows）與選單列（macOS）圖示 | 兩邊都只有單色的公司 logo（托盤文字「自訂…」），每台電腦設定一次 | Windows 是彩色圖示；macOS 是圖示加今日 Tokens 數字 |
| 同步上傳頻率 | 每 30 分鐘（`1800000`） | 即時 |
| 多裝置同步 | 已選「連接到 Hub」，填好 hub URL 與 client 金鑰。GitHub 發行的安裝檔不帶 hub，使用者自己填（見「從 GitHub 發行」） | 本機模式 |
| widget 顯示的用量 | 只有這台電腦，見「只顯示這台電腦」 | 連接到 Hub 時是 hub 上全部裝置的加總 |
| 裝置 ID | 每台電腦第一次開啟時產生一組隨機 UUID | 主機名稱 |
| 裝置列表的名稱 | 主機名稱，沒有才顯示裝置 ID | 裝置 ID |
| 檢查更新 | 公司 GitLab Release 或本 repo GitHub Release 的最新版（Windows、macOS、Linux；見「自動更新」） | GitHub 官方 release |
| 自動下載更新 | 關閉：有新版時提示，使用者按了才下載安裝 | 關閉 |
| 安裝檔 | Windows NSIS x64、macOS dmg arm64、Linux AppImage x64。Windows 與 Linux 不簽章，macOS 只有 ad-hoc 簽章、沒有公證 | 有簽章 |
| 圖示 | 預設和上游相同；放了自己的 logo 就換成它，見「圖示」 | 藍底 Σ |

## 運作方式

1. `npm run build:client` 把 `upstream/` 複製到 `tmp/client-build/app`，有 `client/assets/` 時用裡面的 logo 蓋掉上游的圖示，改掉 `UPSTREAM_PATCHES` 列的上游程式，放進 `client/electron/`（公司版入口 `corp/main.js`、`ownDeviceView.js`，以及可選的 `title-logo.png`）與 `corp/corp-defaults.json`（hub URL、金鑰、上傳頻率、開機啟動、開機時縮小、只顯示這台電腦），再用 electron-builder 打包。`upstream/` 保持原樣，`check:upstream` 照樣通過。
2. 使用者第一次開啟 app 時，入口檢查 `%APPDATA%\Token Monitor\settings.json`（macOS 是 `~/Library/Application Support/Token Monitor/`，Linux 是 `~/.config/Token Monitor/`）：
   - **不存在**：寫入 `hubMode: client`、hub URL、金鑰、上傳頻率、隨機的裝置 ID。金鑰在下一次讀設定時會被上游搬到 `credentials.json`。
   - **已存在**（升級、重裝、以前裝過官方版）：每台電腦只做一次：把 `hubMode` 改成 `client`，填入 hub URL 和上傳頻率，settings.json 的其他設定都不動；金鑰直接寫進 `credentials.json` 的 `hub.clientSecret`。因為上游只搬一次 settings.json 裡的金鑰，而且 `credentials.json` 優先，寫在 settings.json 的金鑰會被丟掉。設成「在這台電腦架 hub」（`hubMode: host`）的電腦不動。做過後記在 `corp-state.json`（`hubApplied: true`），使用者之後自己改的設定（換 hub 等）都會保留。
   - **開機啟動**（`TM_CLIENT_START_AT_LOGIN=1`）：不論 settings.json 在不在，每台電腦只打開一次，並記在同資料夾的 `corp-state.json`（`startAtLoginApplied: true`）。使用者之後自己關掉就保持關閉；刪掉 `corp-state.json` 則下次開啟會再打開一次。
   - **顯示設定**（`SETTINGS_ONCE`）：下面兩項每台電腦只做一次（新裝的與已經裝過的都一樣），改 settings.json，並各自記在 `corp-state.json`。使用者之後自己改回去就保持那樣。以後新增的項目，已經做過其他項目的電腦也會在下一次開啟時補做一次。
     - **保持在工作列上方**（`keepAboveTaskbarApplied`）：設定「視窗」裡的「保持在工作列上方（實驗性）」，寫入 `keepAboveTaskbar: true`。上游只在 Windows、顯示模式是「浮在其他 app 上方」時照這個設定做，其他系統與模式不受影響；它在某些切換 app 的過程可能會短暫閃爍。
     - **系統匣只顯示 logo**（`trayLogoApplied`）：「托盤文字」原本是上游預設的「今日 Tokens」時，改成「自訂…」（`trayContent: custom`）。上游自訂版面的預設只有 app 標記，所以 Windows 系統匣從橘色的 `icon-win.png` 換成單色 logo，macOS 選單列拿掉 logo 旁的今日 Tokens 數字；數字仍在滑鼠移上去的提示裡。logo 的顏色跟著系統：Windows 深色工作列是白色、淺色是深色，macOS 由選單列上色。使用者已經選了別的托盤文字就不動。
3. 入口把上游讀 hub 資料的幾個函式換成只留這台電腦的版本（見「只顯示這台電腦」）。
4. **開機自動啟動時縮小到工作列**（`TM_CLIENT_START_MINIMIZED=1`）：
   - 上游註冊開機啟動時不帶參數，Windows 上分不出是開機啟動還是手動打開。所以入口讓開機啟動的 Run key（`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`）帶上 `--launched-at-login`：上游設定和讀回開機啟動時，入口都替它補上這個參數，設定裡的「開機啟動」勾選照常運作。不論這個選項是 `1` 還是 `0` 都會帶參數，選項只決定要不要縮小。
   - 已經裝過的電腦，Run key 是不帶參數的舊值，入口在更新後第一次開啟時改寫一次。在工作管理員「啟動應用程式」裡停用的，改寫後仍是停用。
   - 帶著這個參數啟動時，上游一顯示 widget，入口就把它縮到工作列；點工作列按鈕或系統匣圖示就回來。從開始功能表或桌面捷徑手動打開時照常顯示。
   - 顯示模式是「托盤彈出視窗」時不動：上游本來就不在啟動時顯示 widget。勾了「隱藏工作列／Dock 圖示」時工作列上沒有按鈕，縮小後要從系統匣圖示叫回。
   - macOS 用 Electron 的 `wasOpenedAtLogin` 判斷，縮到 Dock（還沒在 Mac 上驗證過）。Linux 上游的開機啟動項目不帶參數，不會縮小。
5. 設定了更新來源時，入口把更新的「查看 release」改開 GitLab 的 Release 頁。settings.json 記著的最新版不是公司版（`X.Y.Z-corp.N`）時，入口會把它清掉（見「自動更新」）。Linux 上開機啟動指向的 AppImage 不見了（更新換了檔名）時，改指向正在執行的這一個。
6. 接著執行上游原本的主程式。

> 為什麼不只在 settings.json 寫 `startAtLogin: true`：上游每次開啟時都會用作業系統的實際狀態覆蓋這個值，所以入口必須自己呼叫 `app.setLoginItemSettings`。Linux 上這個呼叫沒有作用，入口改用上游的做法，寫入 `~/.config/autostart/token-monitor.desktop`，而且只有以 AppImage 執行時才寫得了。為什麼不只設環境變數：settings.json 沒有 `hubMode` 時，上游一律退回本機模式。這些接縫由 `tests/clientBuild.test.js` 檢查，上游更新後一旦改動，`npm run verify` 會失敗。

## 只顯示這台電腦

上游連接到 Hub 時，widget 顯示的是 hub 合併全部上傳裝置的結果：總量、費用、模型、活動、趨勢、裝置列表，以及每個登入帳號的用量限制（LIMITS），所以會看到同事的 Claude 帳號與用量。公司版預設只顯示這台電腦（`TM_CLIENT_OWN_DEVICE_ONLY=1`）；設成 `0` 重新打包，就恢復上游的行為。

- **哪台算這台電腦**：上游上傳時用的裝置 ID，也就是 `settings.json` 的 `deviceId`，沒有時是主機名稱。使用者改了裝置 ID，widget 跟著換。
- **怎麼做**：上游主程式載入時才取用這幾個函式，入口在那之前把它們換成 [ownDeviceView.js](../client/electron/ownDeviceView.js) 的版本，`upstream/` 不改。
  - `composeLocalSyncSummary`：hub 送來的裝置只留這台，總量與用量限制由上游照原本的方式從這台算出來。
  - `resolveCompleteHistory`、`resolveCompleteHistoryWithDevices`：活動與趨勢用本機收集的歷史。本機還沒有時，從 hub 的 `/api/devices` 取這台的那一份，不再讀全部裝置合併的 `/api/history`。
  - `macWidgetHistorySourceKey`：macOS widget 存在磁碟上的歷史換一個名字，之前存的全部裝置的歷史不會再顯示。
  - 系統匣、macOS widget 與匯出都用同一份資料。
- **上傳不變**：這台電腦照樣上傳到 hub，hub 與 dashboard 照樣看得到每一台。
- **剛開啟時**：本機第一次收集完成之前（通常幾十秒），數字是 hub 上這台的那一份，最多晚一個上傳週期，趨勢是空的。
- **只在「連接到 Hub」時有作用**：本機模式本來就只有這台；「在這台電腦架 hub」不受影響。照 [client-setup.zh-TW.md](client-setup.zh-TW.md) 手動安裝的官方版也不受影響。
- **不是存取控制**：client 金鑰每個人都有，等於公開。拿它直接呼叫 hub 的 `/api/stats`、`/api/devices`，仍然讀得到全部裝置；widget 收到的串流也仍是全部裝置的資料，只是不顯示，流量不變。要讓員工彼此看不到，得改 hub 的權限（例如每人一把金鑰或登入），不在這個功能的範圍。
- **上游更新**：`tests/ownDeviceView.test.js` 檢查三件事：上游 `main.js` 仍在載入時取用這幾個函式、沒有其他上游模組用到它們、hub `/api/stats` 的每個欄位都已分類。測試失敗時，先讀上游的新版本，再改 `ownDeviceView.js`。入口換不上去時只會在 log 寫一行 `[corp] could not limit the widget to this device`，widget 就退回顯示全部裝置，所以發行前一定要跑 `npm run verify`。

## 圖示

本 repo 不附任何 logo：下面的檔案都不存在時，用戶端沿用上游的圖示。要換成自己組織的 logo，照下面的規格產生檔案、放在對應的位置（[client/README.md](../client/README.md)）；這些檔案屬於你的組織，放在自己的 fork 或打包機上，不要送回公開的 repo。

`client/assets/` 底下的每個檔案，打包時會蓋掉上游 `assets/` 同一路徑的檔案。上游的程式與 electron-builder 設定不用改，就會用你的 logo。上游沒有的路徑放進來也沒人會用，所以打包會直接失敗。

| 檔案 | 用在哪裡 | 規格 |
|---|---|---|
| `icon-win.png` | Windows 的系統匣，托盤文字不是「自訂…」時（公司版預設是「自訂…」，見「運作方式」） | 1024×1024 透明背景，logo 高度 1000 px 置中（Windows 希望圖示填滿） |
| `icon.png` | macOS 的 Dock 與 dmg、Linux 的 AppImage 與系統匣 | 1024×1024 透明背景，logo 高度 824 px 置中（macOS 圖示格線） |
| `icons/tray-token-monitor.png` | macOS 選單列；app 自己畫的系統匣圖示裡的 app 標記（公司版預設的 Windows 系統匣就是它，依系統主題畫成白色或深色） | 44×44，黑色加透明度（template image，系統會重新上色），logo 高度 36 px |
| `icons/token-monitor.svg` | app 內認不出廠商的模型、未分類用量那一列的小圖示（CSS mask，只看透明度） | 24×24 viewBox，內嵌 128 px 的黑色 logo PNG |

另外兩個檔案不是蓋掉上游的檔案：

| 檔案 | 用在哪裡 | 規格 |
|---|---|---|
| `client/build/icon-win.ico` | Windows 的安裝檔、程式與工作列圖示（`createBuilderConfig()` 的 `win.icon`；沒有這個檔案時用上游的 `assets/icon-win.png`） | 16、20、24、30、32、36、40、48、60、64、72、80、96、128、256 px，每個尺寸都從 logo 直接縮；48 px 以下把邊緣的半透明過渡收窄，小圖才不糊。electron-builder 從 PNG 自己轉的 .ico 只有 16、24、32、48、64、128、256，螢幕縮放 125%、150% 時 Windows 會把 48 px 再縮小，工作列圖示就糊了 |
| `client/electron/title-logo.png` | 視窗左上角的標記（上游的 Σ）。入口在 app 的頁面載入時注入 CSS，把 Σ 改成透明，用這張圖當背景；滑鼠移上去、點擊仍是上游原本的行為 | 白色、透明背景的 `logo-white.png` 裁到 logo 邊緣，高 128 px |

一般做法是從一張透明背景的 logo 產生前兩張表的圖示，左上角的標記則從白色版本產生；檔名照表上的寫法。每個檔案都可以單獨放，沒放的就用上游的。

## 改動上游程式的地方

打包時，[packaging/build-client.js](../packaging/build-client.js) 的 `UPSTREAM_PATCHES` 會在複製出來的上游程式裡，把列出的那一行換掉。每一行出現的次數都必須和設定的一樣（`count`，沒寫就是一次），不一樣時打包直接失敗，`tests/clientBuild.test.js` 也會失敗。這時先讀上游的新版本，再改 `UPSTREAM_PATCHES`，不要拿掉那一項了事。

| 檔案 | 改了什麼 | 原因 |
|---|---|---|
| `src/electron/renderer/app.js` 的 `deviceLabel()` | 裝置列表的名稱改成主機名稱優先，沒有主機名稱才顯示裝置 ID | 公司版的裝置 ID 是隨機 UUID，上游用裝置 ID 當名稱，整排都會是 UUID |
| `src/electron/renderer/index.html`、`i18n.js`（5 個語系）的 `settings.appUpdate.source` | 「應用程式更新」標題右邊的「GitHub releases」改成「GitLab releases」；從 GitHub 更新的安裝檔維持「GitHub releases」（`upstreamPatches('GitHub')`） | 公司版從 GitLab Release 更新（見「自動更新」） |
| `src/electron/renderer/index.html`、`app.js` 的 `settings.appUpdate.source` | 「GitLab releases」改成連結，點了開 GitLab 的 Releases 頁（`/-/releases`） | 使用者直接找得到公司版的每一版。連結開的是上游 GitHub 的 Releases 頁（main.js 的白名單只放行它），入口在最後一步換成 GitLab（見「自動更新」） |

## 安全：金鑰會跟著安裝檔走

- **任何拿到安裝檔的人都能解出 client 金鑰**（它在 `app.asar` 裡）。
- 只能放 client 金鑰（hub 的 `TOKEN_MONITOR_CLIENT_SECRETS` 其中一把），**絕不可以**放 admin 金鑰 `TOKEN_MONITOR_SECRET`。
- 安裝檔放在 GitLab Release。自動更新要求專案的 Release 與 Package Registry 不用登入就能下載（見「自動更新」），所以連得到這台 GitLab 的人都拿得到 client 金鑰。GitLab 若對外開放，要把這把金鑰當成公開的。
- 本 repo 在 GitHub 上是公開的，所以 GitHub Release 的安裝檔**一律不帶 hub URL 與金鑰**（`TM_CLIENT_NO_HUB=1`）。更新來源是 GitHub（`TM_CLIENT_UPDATE_GITHUB_REPO`）又帶了 hub 或金鑰時，打包直接失敗。
- 換金鑰：
  1. 在 hub 的 `TOKEN_MONITOR_CLIENT_SECRETS` 加上新金鑰，新舊並列，重啟 hub。
  2. 用新金鑰打一版新的安裝檔。
  3. 已經連過 hub 的電腦（`corp-state.json` 有 `hubApplied`）不會被新安裝檔改設定，要請使用者在「多裝置同步」手動貼上新金鑰。
  4. 確認沒有裝置在用舊金鑰後，再從 hub 移除它（[client-setup.zh-TW.md](client-setup.zh-TW.md)「輪替 client 金鑰」）。

## 設定值

地端讀 repo 根目錄的 `.env.client`，GitLab 讀 CI/CD 變數；兩邊都有時，環境變數優先。

| 變數 | 預設值 | 說明 |
|---|---|---|
| `TM_CLIENT_NO_HUB` | `0` | `1`：打出不帶 hub 的安裝檔，`TM_CLIENT_HUB_URL` 與 `TM_CLIENT_SECRET` 都要留空。第一次開啟時寫入其他設定（上傳頻率、隨機裝置 ID、開機啟動），hub URL 與金鑰由使用者在「多裝置同步」自己填。GitHub 發行用的就是這種（見「從 GitHub 發行」）。要明確設定，CI 變數漏設時才會失敗，而不是默默打出連不到 hub 的安裝檔。 |
| `TM_CLIENT_HUB_URL` | 必填（`TM_CLIENT_NO_HUB=1` 時留空） | 例如 `https://tokens.example.com` 或 `http://192.0.2.10`。不可以帶帳密、query。CI 發行時，Release 說明的安裝步驟連到這台 hub 的 `/install`。 |
| `TM_CLIENT_ALLOW_HTTP` | `0` | hub 是 http 時要設為 `1`，例如直接用 Docker Compose 預設的 port 80（http）；前面有 https 反向代理時，填 `https://…` 並維持 `0`。 |
| `TM_CLIENT_SECRET` | 必填（`TM_CLIENT_NO_HUB=1` 時留空） | client 金鑰，16～256 字元，`A-Z a-z 0-9 . _ ~ + = / -`。 |
| `TM_CLIENT_SYNC_UPLOAD_INTERVAL_MS` | `1800000` | 只接受 `0`（即時）、`600000`、`1200000`、`1800000`。 |
| `TM_CLIENT_START_AT_LOGIN` | `1` | 每台電腦第一次開啟時打開開機啟動（已裝過的電腦也會補開一次）；`0` 則不動。 |
| `TM_CLIENT_START_MINIMIZED` | `1` | 開機自動啟動時把 widget 縮到工作列；`0` 則和上游一樣顯示。手動打開不受影響。見「運作方式」第 4 步。 |
| `TM_CLIENT_OWN_DEVICE_ONLY` | `1` | widget 只顯示這台電腦的用量；`0` 則和上游一樣顯示 hub 上全部裝置。不論哪一個，上傳都一樣。見「只顯示這台電腦」。 |
| `TM_CLIENT_UPDATE_PROJECT_URL` | 空白 | 更新來源：GitLab 專案的網址，例如 `https://gitlab.example.com/<group>/<project>`。要 https，不能帶帳密、query。CI 自動帶 `$CI_PROJECT_URL`，不用設。和下一個一起設，或一起留空（不檢查更新）。 |
| `TM_CLIENT_UPDATE_PROJECT_ID` | 空白 | 同一個專案的數字 ID（**Settings → General** 的 Project ID，例如 `123`）。CI 自動帶 `$CI_PROJECT_ID`。用數字 ID，專案改名或搬家後已安裝的 app 一樣找得到。 |
| `TM_CLIENT_UPDATE_GITHUB_REPO` | 空白 | 另一種更新來源：公開的 GitHub repo，寫成 `owner/repo`，app 從它最新的 Release 更新。和上面兩個只能擇一。只能搭配 `TM_CLIENT_NO_HUB=1`。GitHub Actions 自動帶 `${{ github.repository }}`。 |
| `TM_CLIENT_VERSION` | `<上游版本>-corp.0` | `X.Y.Z-corp.N`，X.Y.Z 必須等於 `upstream/package.json` 的版本。CI 從 tag 取得，不用設。`build-client.ps1` 在這裡留空時會自動跳號（見下方）。 |

## 地端打包（Windows）

需要：Windows、Node.js ≥ 22.15、可以連到 npm registry 與 GitHub（下載 Electron 與固定版本的 tokscale）。

### 一鍵打包

```powershell
.\packaging\build-client.ps1                                  # 自動跳到下一個 <上游版本>-corp.N
.\packaging\build-client.ps1 -Version 0.63.1-corp.2 -Pull -Open
```

腳本依序做這些事，任何一步失敗就停下並印出原因：

1. 檢查 Windows、git、Node.js ≥ 22.15（`node` 不在 PATH 時會找 WinGet 或 `C:\Program Files\nodejs` 裝的 Node.js）。
2. `-Pull`：先 `git pull --ff-only`（有未 commit 的修改時拒絕）。
3. 從 hub 的 `.env.ubuntu` 取 hub URL（`TOKEN_MONITOR_HUB_URL`）與 client 金鑰（`TOKEN_MONITOR_CLIENT_SECRETS` 的第一把）。URL 是 `127.0.0.1`／`localhost` 時停下，因為其他電腦連不到；金鑰等於 admin 金鑰 `TOKEN_MONITOR_SECRET` 時也停下。其他值（上傳頻率、開機啟動、更新來源、版本）仍讀 `.env.client`，沒有就從 `.env.client.example` 複製一份。`.env.client` 完全沒有 `TM_CLIENT_UPDATE_PROJECT_URL`／`_ID`（多半是這兩個設定加入前建立的舊檔）時，從 `.env.client.example` 補上；刻意留空則保留，但會警告這個安裝檔裝了之後不會自己更新。hub URL 或金鑰到處都沒有時，在視窗裡問（金鑰輸入時不顯示）。優先順序：腳本參數 > 環境變數 > `.env.ubuntu` > `.env.client`。
4. `node_modules` 不存在或比 `package-lock.json` 舊時執行 `npm ci`。
5. 檢查設定值（同下方第 2 步的試跑），再執行 `npm run verify`（`-SkipVerify` 可略過）。
6. 打包，產出複製到 `release\client\<版本>\`：安裝檔、`SHA256SUMS.txt`、`BUILD-INFO.txt`（版本、commit、上游版本、hub URL、設定來源，不含金鑰）與 `build.log`。`release/` 已在 `.gitignore`。

| 參數 | 說明 |
|---|---|
| `-Version X.Y.Z-corp.N` | 版本（X.Y.Z 必須等於上游版本）；省略時用 `.env.client` 的 `TM_CLIENT_VERSION`，再沒有就自動跳號：取 `release\client\` 資料夾與 `client-v*` git tag 中同一個上游版本最大的 N 再加 1（新的上游版本從 `corp.0` 開始）。指定的版本資料夾已存在時會提醒 |
| `-HubEnvFile <檔案>` | 讀 hub URL 與金鑰的 hub 設定檔（預設 `.env.ubuntu`）；`-HubEnvFile ''` 只用 `.env.client` |
| `-HubUrl <網址>` | 指定 hub URL，蓋過其他來源（http 會自動允許） |
| `-StartAtLogin 1\|0` | 開機啟動；省略時用 `TM_CLIENT_START_AT_LOGIN`，預設 `1` |
| `-Pull` | 打包前先更新這個分支 |
| `-SkipVerify` | 不跑 `npm run verify` |
| `-Output <資料夾>` | 產出放哪裡（預設 `release\client`） |
| `-DryRun` | 只檢查環境與設定值，不打包 |
| `-KeepWork` | 保留 `tmp/client-build/` 除錯（含金鑰的檔案一樣會刪掉） |
| `-Open` | 完成後開啟產出資料夾 |

有未 commit 的修改時照樣可以打包（試用），但會在畫面與 `BUILD-INFO.txt` 標明，這種安裝檔不要拿去發行。

### 手動步驟

1. 準備設定檔：

   ```powershell
   
   Copy-Item .env.client.example .env.client
   notepad .env.client        # 填 TM_CLIENT_HUB_URL、TM_CLIENT_SECRET，http 的 hub 加 TM_CLIENT_ALLOW_HTTP=1
   ```

   `.env.client` 已在 `.gitignore`，不要 commit、不要複製到別處。

2. 先試跑，確認設定正確（金鑰顯示成 `***`）：

   ```powershell
   npm run build:client -- --platform win --dry-run
   ```

3. 打包：

   ```powershell
   npm run build:client -- --platform win
   ```

   產出 `dist/client/Token-Monitor_<版本>_x64-setup.exe`。第一次要下載 Electron，約 5～10 分鐘。

   - `--keep-work` 保留 `tmp/client-build/`（除錯用；含金鑰的 `corp-defaults.json` 一樣會刪掉）。

## GitLab 設定（第一次）

下面以自架的 GitLab 為例：把本 repo 推到你們組織的 GitLab（例如 `https://gitlab.example.com/<group>/<project>`），CI 設定是根目錄的 [.gitlab-ci.yml](../.gitlab-ci.yml)。需要兩台 runner：一台 Ubuntu（Docker executor，tag `ubuntu`）與一台 Mac（shell executor，tag `macos`）；部署 hub 用的 `hub-deploy` runner 見 [hub.zh-TW.md](hub.zh-TW.md#從-gitlab-部署)「從 GitLab 部署」。

| Job | Runner tag | 何時執行 | 做什麼 |
|---|---|---|---|
| `verify` | `ubuntu` | MR、`corp/v*` tag、main 上手動 Run pipeline | `npm ci && npm run verify` |
| `build:client:windows` | `ubuntu` | 推 `client-v*` tag；main 上手動 Run pipeline 後可按 | Linux Docker（`electronuserland/builder:22-wine-05.26`）打 Windows 安裝檔 |
| `build:client:macos` | `macos` | 推 `client-v*` tag；main 上手動 Run pipeline 後可按 | Mac shell runner 打 macOS dmg |
| `build:client:linux` | `ubuntu` | 推 `client-v*` tag；main 上手動 Run pipeline 後可按 | Linux Docker（同一個 image）打 Linux AppImage |
| `release:client` | `ubuntu` | 推 `client-v*` tag，三個打包 job 都成功後 | 檢查 `latest.yml`、`latest-linux.yml` 的版本與檔名，和 exe、dmg、AppImage 一起上傳到 Package Registry，建立 GitLab Release |

推到 main 不會跑 pipeline，只有推 tag 與 MR 會。要在 main 上手動打包或部署，到 **Build → Pipelines → Run pipeline**，分支選 `main`，再按要的 job。

每個 job 都指定了 runner tag，兩台 runner 都**不要**勾 Run untagged jobs，job 就不會跑錯台。

### 1. 設定 Environment 與變數

1. 專案左側 **Operate → Environments → New environment**，名稱填 `client/production`，儲存。（第一次跑 job 也會自動建立，先建好比較方便設定變數範圍。）要有測試用的 hub，可以另建 `client/staging`。
2. **Settings → CI/CD → Variables → Add variable**，逐一新增：

   | Key | Value | Visibility | Flags | Environments |
   |---|---|---|---|---|
   | `TM_CLIENT_SECRET` | client 金鑰 | **Masked and hidden** | Protect variable；取消 Expand variable reference | `client/production` |
   | `TM_CLIENT_HUB_URL` | hub URL | Visible | Protect variable | `client/production` |
   | `TM_CLIENT_ALLOW_HTTP` | `1`（http 的 hub 才需要） | Visible | Protect variable | `client/production` |

   - **Masked and hidden**：job log 裡顯示成 `[MASKED]`，儲存後在設定頁面也看不到值，只能覆寫。GitLab 要求 masked 的值是單行、至少 8 個字元；用 `openssl rand -hex 32` 產生的金鑰符合。
   - **Protect variable**：只有 protected 的分支與 tag 拿得到，所以下一步要把 tag 設為 protected。
   - **Environments**：只有宣告 `environment: client/production` 的 job（打包 job）拿得到，`verify` 等其他 job 看不到。
   - `TM_CLIENT_SYNC_UPLOAD_INTERVAL_MS`、`TM_CLIENT_START_AT_LOGIN`、`TM_CLIENT_START_MINIMIZED`、`TM_CLIENT_OWN_DEVICE_ONLY` 用預設值就不用設。

3. **Settings → Repository → Protected tags**：Tag 填 `client-v*`，Allowed to create 選 Maintainers。
4. **Settings → Repository → Protected branches**：確認 `main` 是 protected（手動在 main 打包時才拿得到變數）。

### 2. 註冊 Ubuntu runner（Docker）

1. **Settings → CI/CD → Runners → New project runner**：Tags 填 `ubuntu`，**不要**勾 Run untagged jobs，也不要勾 Protected（MR 的 `verify` 要能跑）。建立後把 `glrt-…` token 填進 repo 根目錄 `.env.runner` 的 `TM_RUNNER_TOKEN_UBUNTU`。`.env.runner` 從 [.env.runner.example](../.env.runner.example) 複製，已在 `.gitignore` 裡，**不要** commit：拿到 token 的人都能架 runner 接走打包 job。
2. 在 Windows 上執行：

   ```powershell
   .\deploy\install-runner-ubuntu.ps1                              # 預設 192.0.2.10，執行時輸入 SSH 帳號與密碼
   .\deploy\install-runner-ubuntu.ps1 -Server <IP> -Token glrt-xxxxxxxx
   ```

   腳本經 SSH 在主機上：
   - 沒有 Docker 就用 get.docker.com 安裝。
   - 沒有 gitlab-runner 就從 GitLab 的 apt 套件庫安裝；`-UpgradeRunner` 升級到最新版。
   - `/etc/gitlab-runner/config.toml` 已經有這個 GitLab 的 runner 就保留，否則用 token 註冊（executor `docker`，預設 image `node:22`）。`-Reregister` 才會重新註冊，舊設定改名留著。
   - 啟用 systemd 服務，開機自動啟動。

   重複執行是安全的：已經裝好的會保留，也不會中斷正在跑的 job（除非剛升級 gitlab-runner）。手動安裝的話，腳本做的事等於：

   ```bash
   docker --version || curl -fsSL https://get.docker.com | sudo sh
   curl -L "https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh" | sudo bash
   sudo apt-get install -y gitlab-runner
   sudo gitlab-runner register --non-interactive \
     --url https://gitlab.example.com \
     --token glrt-xxxxxxxx \
     --description token-monitor-ubuntu \
     --executor docker \
     --docker-image node:22
   sudo gitlab-runner verify
   ```

   apt 安裝時已經把 runner 裝成 systemd 服務，開機會自動啟動。

3. 這台主機要能連到 Docker Hub、npm registry 與 GitHub。Windows 打包 job 一次約用 3 GB 磁碟；Linux 打包 job 用同一個 image。

### 3. 註冊 Mac runner

推 tag 時 `build:client:macos` 會自動執行，`release:client` 要等它成功才會建立 Release，所以發行之前一定要有 Mac runner。

1. **Settings → CI/CD → Runners → New project runner**：Tags 填 `macos`，**不要**勾 Run untagged jobs。建議勾 Protected：這是 shell runner，job 直接在 Mac 上執行指令；`build:client:macos` 只在 protected 的 `main` 與 `client-v*` tag 上跑，勾了之後其他分支的 job 就進不了這台 Mac。建立後把 `glrt-…` token 填進 `.env.runner` 的 `TM_RUNNER_TOKEN_MACOS`。
2. Mac 上打開 **系統設定 → 一般 → 共享 → 遠端登入**，再在 Windows 上執行：

   ```powershell
   .\deploy\install-runner-macos.ps1                               # 預設 192.0.2.20，輸入 Mac 的帳號與密碼（要是管理者）
   .\deploy\install-runner-macos.ps1 -Server <IP> -Token glrt-xxxxxxxx
   ```

   腳本經 SSH，以這個帳號在 Mac 上：
   - 沒有 Xcode Command Line Tools 就用 `softwareupdate` 安裝（git 與 python3，約 1 GB，不會跳出對話框）。
   - 沒有 Node 22（>= 22.15）就安裝 nodejs.org 的官方 pkg。它放在 `/usr/local/bin`，每個 shell 的 PATH 都有，不用另外設定。
   - 沒有 gitlab-runner 就下載到 `/usr/local/bin`；`-UpgradeRunner` 換成最新版。
   - `~/.gitlab-runner/config.toml` 已經有 runner 就保留，否則用 token 註冊（executor `shell`，description 預設 `mac-<主機名稱>`）。`-Reregister` 才會重新註冊，舊設定改名留著。
   - 把 runner 裝成 LaunchDaemon `/Library/LaunchDaemons/gitlab-runner.plist`，以這個帳號執行：**開機就啟動，不用登入**，停掉會自動重啟。log 在 `~/Library/Logs/gitlab-runner.log`。之前用 `gitlab-runner install` 或 `brew services` 建的登入項目會停用，免得同一台跑兩份。
   - 接電源時不睡眠（`pmset -c sleep 0`）；加 `-AllowSleep` 就不改。睡著的 Mac 不會接 job。

   重複執行是安全的，已經裝好的會保留，但會重新啟動 runner，正在跑的 job 會中斷。

   - 只拿得到舊式的 registration token（`GR1348941…`）時，一樣填進 `.env.runner`，腳本會在註冊時帶上 tag `macos`。註冊完到 **Settings → CI/CD → Runners** 重設 registration token，拿到它的人都能註冊 runner 並接走打包 job（含 client 金鑰）。
   - 註冊只是讓 GitLab 認得這台 runner，要有服務在跑才會去拿 job。job 一直 pending、Runners 頁面的 Last contact 停在很久以前時，在 Mac 上看 `sudo launchctl print system/gitlab-runner` 與 log，或重新執行腳本。重新啟動：`sudo launchctl kickstart -k system/gitlab-runner`。
3. 在 main 上 Run pipeline，手動執行 `build:client:macos`，確認產出 `dist/client/Token-Monitor_<版本>_aarch64.dmg`。
4. 這台 Mac 要開機、接著電源，而且要能連到 npm registry 與 GitHub。MacBook 闔上螢幕就會睡眠，除非接著外接螢幕；開了 FileVault 的話，重開機後要有人在登入畫面解鎖磁碟，runner 才會啟動。Mac runner 離線時，tag 的 pipeline 會停在 `build:client:macos` 等待，Release 也不會建立。
5. 目前 app 只有 ad-hoc 簽章（`packaging/build-client.js` 的 `mac.identity: '-'`），沒有 Apple 公證。
   - 不需要憑證：electron-builder 在 Mac runner 上用 `codesign --sign -` 簽整個 app，包括 tokscale 等內附的執行檔。hardened runtime 關掉（`hardenedRuntime: false`）：它只有公證才用得到，配上 ad-hoc 簽章時，library validation 可能讓 app 載入不了自己的 framework。
   - 為什麼一定要簽：完全沒有簽章的 app 從瀏覽器下載後，macOS 會說「已損毀，應丟到垃圾桶」，而且沒有按鈕可以繞過。有了 ad-hoc 簽章，第一次打開只會說無法確認是否含有惡意軟體，使用者到「系統設定 → 隱私權與安全性」按「強制打開」一次就好，或在終端機執行 `xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"`。給使用者的步驟寫在 hub 的安裝說明頁 `hub/install.html`，Release 說明連到它。
   - 簽完後再簽一次 app 本身，換掉指定需求（designated requirement）：[packaging/macAfterSign.js](../packaging/macAfterSign.js)（electron-builder 的 `afterSign`）。ad-hoc 簽章預設的指定需求是這一份 app 自己的 cdhash，別的版本都不可能符合；Squirrel.Mac 只安裝符合「正在執行的 app 的指定需求」的新版，所以預設下每次更新都會被拒絕。改成 `identifier "com.javis.tokenmonitor"` 之後，之後每一版都符合（見「自動更新」）。只簽 app 本身，不加 `--deep`：裡面的 helper 與 framework 各有自己的 identifier。
   - 在 Mac 上確認簽章：`codesign -dv "/Applications/Token Monitor.app"` 要顯示 `Signature=adhoc`，`codesign --verify --deep --strict` 不能有錯誤，`codesign -d -r- "/Applications/Token Monitor.app"` 要顯示 `designated => identifier "com.javis.tokenmonitor"`（顯示 `# designated => cdhash …` 就不會自動更新）。`spctl --assess` 會是 `rejected`，因為沒有公證，這是預期中的。
   - 要正式派送時需要 Apple Developer ID：在 CI 變數加 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`（masked、protected、限 `client/production`），拿掉 `identity: '-'`、`hardenedRuntime: false` 與 `afterSign`（公證需要 hardened runtime 與 Electron 的 entitlements；有 Developer ID 時指定需求本來就含 Team ID），再把 `forceCodeSigning` 打開。換成 Developer ID 的第一版，已經裝好的 Mac 會更新失敗（新版的指定需求不同），要手動裝一次。

## 發行

1. 確認要發行的 commit 通過 `npm run verify`（本機，或在 main 上 Run pipeline 跑 `verify`；推 `client-v*` tag 的 pipeline 不跑 verify）。
2. 打 tag 並推送，版本號是 `<上游版本>-corp.<N>`，N 從 1 起算，同一個上游版本每發一次加 1：

   ```bash
   git tag client-v0.63.1-corp.1
   git push origin client-v0.63.1-corp.1
   ```

3. Pipeline 跑完後：
   - **Deploy → Releases** 出現 `Token Monitor 0.63.1-corp.1`：說明寫著哪種電腦下載哪個檔案、怎麼更新，最後附 SHA256；安裝步驟不寫在這裡，連到 hub 的安裝說明頁 `/install` 各平台的分頁（`hub/install.html`），中文連 `?lang=zh-TW`、英文連 `?lang=en`。說明的內容在 [packaging/client-release-notes.md](../packaging/client-release-notes.md)，`@VERSION@`、`@DOWNLOADS@` 與 `@INSTALL@` 由 `release:client` 代入；`@INSTALL@` 是 `TM_CLIENT_HUB_URL` 加上 `/install`，由打包的 job 寫進 `client.env` 傳過來，沒有它或說明裡還留著沒代入的 `@…@` 時，`release:client` 會失敗。要改說明文字就改這個檔案。說明先寫中文，`# English` 之後是同樣內容的英文，第一行連到英文版。中英文要一起改，`tests/clientBuild.test.js` 會檢查兩邊的連結與版本號相同。
   - 下載連結的名稱就是檔名。Mac 更新用的 `Token-Monitor_<版本>_aarch64.zip` 與 `latest.yml`、`latest-mac.yml`、`latest-linux.yml` 列在「Other」，使用者不用下載。名稱不能改：已安裝的 app 靠連結名稱找檔案（見「自動更新」）。哪種電腦下載哪個檔案寫在說明裡。
   - 檔名照 GitHub 上 Tauri app 的 Release 慣例 `<名稱>_<版本>_<CPU>`，CPU 用各平台自己的叫法：

     | 平台 | 檔名 |
     |---|---|
     | Windows | `Token-Monitor_<版本>_x64-setup.exe` |
     | macOS（Apple 晶片） | `Token-Monitor_<版本>_aarch64.dmg` |
     | Linux（x64） | `Token-Monitor_<版本>_amd64.AppImage` |

     名稱定在 [packaging/build-client.js](../packaging/build-client.js) 的 `TARGETS`。要改的話，`.gitlab-ci.yml` 的 Release 連結與 `latest*.yml` 檢查、`packaging/client-release-notes.md` 與 hub 的安裝說明頁 `hub/install.html` 要一起改，`tests/clientBuild.test.js` 會檢查它們一致。安裝步驟只寫在 `hub/install.html`，release notes 連到它各平台的分頁。
   - 下載連結有固定網址，公告時可以直接貼：`/-/releases/<tag>/downloads/windows`、`/macos`、`/linux`；最新一版是 `<專案網址>/-/releases/permalink/latest/downloads/windows`（`macos`、`linux` 同理），例如 `https://gitlab.example.com/<group>/<project>/-/releases/permalink/latest/downloads/windows`。
   - dashboard 的「下載 Token Monitor」連到 hub 的 `TOKEN_MONITOR_CLIENT_DOWNLOAD_URL`（[hub.zh-TW.md](hub.zh-TW.md#設定)「設定」），設成 Releases 頁就不用隨每一版修改。hub 的安裝說明頁 `/install` 從同一個網址推出上面三個最新一版的固定網址。
   - GitLab 一定會列出 Source code 與 Evidence collection，無法隱藏；沒有程式碼權限的人（例如 Guest）看不到 Source code。Assets 與 Evidence 固定排在說明上面，也沒有設定可以調整。
   - 檔案本身在 **Deploy → Package Registry → token-monitor-client**。
   - Job 的 artifacts 也有安裝檔，保留 30 天。
4. 在一台乾淨的測試電腦上驗證（見下方「驗證」）後，再公告員工下載。已經裝了可以自動更新的版本的電腦，會在一天內自己提示新版；使用者按「檢查更新」則馬上看到。

不發版、只想拿一份安裝檔試用：在 main 上 Run pipeline，手動按 `build:client:windows`、`build:client:macos` 或 `build:client:linux`，版本是 `<上游版本>-corp.0`，從 job 的 artifacts 下載。打包 job 不等 `verify`，pipeline 一出來就可以按。

## 從 GitHub 發行

本 repo 在 GitHub 上是公開的。把 `client-v*` tag 推到 GitHub，[.github/workflows/client-release.yml](../.github/workflows/client-release.yml) 會打包並建立 GitHub Release。

- **安裝檔不帶 hub URL 與金鑰**（`TM_CLIENT_NO_HUB=1`）：公開的 Release 誰都下載得到，帶著金鑰就等於把金鑰公開。使用者裝好後，向管理者拿 hub 網址與 client 金鑰，在 ⚙ →「多裝置同步」→「連接到 Hub」自己填一次。其他設定和公司版一樣：每 30 分鐘上傳、隨機裝置 ID、開機啟動、只顯示這台電腦。
- **流程**：`verify`（`npm run verify`）通過後，Windows（`windows-latest`）、macOS（`macos-latest`，Apple 晶片）、Linux（`ubuntu-latest`）同時打包，三個都成功才由 `release` job 建立 Release。它會檢查 `latest*.yml` 的版本與檔名，附上 SHA256，並標成 latest。
- **Release 說明**：[packaging/client-release-notes.github.md](../packaging/client-release-notes.github.md)，`@VERSION@` 與 `@DOWNLOADS@` 由 workflow 代入。內容是哪種電腦下載哪個檔案、怎麼打開沒有簽章的安裝檔、怎麼連上 hub。中英文要一起改，`tests/clientBuild.test.js` 會檢查。
- **自動更新**：app 從本 repo **最新的 GitHub Release** 更新（`TM_CLIENT_UPDATE_GITHUB_REPO`，見「自動更新」）。
- **發行步驟**：和「發行」一樣打 `client-vX.Y.Z-corp.N` tag，推到 GitHub：

  ```bash
  git tag client-v0.63.1-corp.1
  git push origin client-v0.63.1-corp.1
  ```

  workflow 在 GitHub 的 **Actions → Client release**，完成後在 **Releases** 看得到。
- 同一個 tag 也推到 GitLab 時，GitLab 另外打出帶金鑰的公司版。兩邊的版本號共用同一組 N。

## 自動更新

Windows、macOS 與 Linux 的 app 會檢查本 repo 所在 GitLab 專案**最新的 Release**，有新版時在 app 裡提示，使用者按「下載更新」、「重啟更新」就完成。「自動下載更新」維持關閉，不會自己在背景下載。

- **怎麼找到新版**：上游用的 electron-updater 內建 GitLab provider。
  - 打包時，[packaging/build-client.js](../packaging/build-client.js) 寫入 `resources/app-update.yml`（`provider: gitlab`、專案 ID、`channel: latest`），同時產生 `latest.yml`（Windows）、`latest-mac.yml`（macOS）或 `latest-linux.yml`（Linux）：裡面有版本、檔名與 sha512。
  - app 在背景最多一天檢查一次（開啟時與之後每小時看一次，距離上次檢查不到 24 小時就略過），按「檢查更新」則馬上檢查。檢查時呼叫 `/api/v4/projects/<id>/releases/permalink/latest`，在 Release 的連結裡找名稱是 `latest.yml` 的那一個，版本比自己新就提示。下載時用檔名找安裝檔的連結，並核對 sha512。
  - 不需要 token：Release 與 Package Registry 不用登入就讀得到。專案改成需要登入（private 或 internal）時，更新檢查會失敗。
- **「查看 release」**：上游只會組出 GitHub 的網址（`…/Javis603/token-monitor/releases/tag/v<版本>`），GitHub 上沒有公司版的 tag。入口在最後一步把它換成 GitLab 的 `/-/releases/client-v<版本>`。「應用程式更新」標題右邊的來源也改標成「GitLab releases」，點了開 GitLab 的 Releases 頁：它開的是上游的 `…/Javis603/token-monitor/releases`，入口同樣在最後一步換成 GitLab 的 `/-/releases`（見「改動上游程式的地方」）。沒有設定更新來源的安裝檔不換，會開到 GitHub。
- **不顯示上游的版本**：上游把最後找到的最新版記在 settings.json 的 `appUpdate.lastKnownLatest`，只有檢查成功時才換掉。這台電腦以前跑過上游官方版或從原始碼執行時，這裡可能記著 GitHub 的版本（例如 `0.64.0`）。公司版裝不了這個版本，但檢查失敗時（沒有更新來源的安裝檔永遠失敗）它會一直顯示成最新版。所以入口開啟時，若記著的版本或略過的版本（`dismissedVersion`）不是 `X.Y.Z-corp.N`，就清掉它，連同上次檢查的時間一起清，讓 app 開啟後馬上重新檢查。
- **Linux 更新後換檔名**：electron-updater 把新版存成 `Token-Monitor_<新版本>_amd64.AppImage`，刪掉舊檔。開機啟動的 `token-monitor.desktop` 還指著舊檔，上游就會把「開機時啟動」讀成關閉；入口在開啟時發現舊檔不在了，就改指向新的檔案。舊檔還在（使用者兩個都留著）時不動。
- **macOS 沒有 Apple 憑證也能更新**：
  - electron-updater 在 Mac 上不裝 dmg，裝 zip，所以 Mac 打包同時產生 `Token-Monitor_<版本>_aarch64.zip`，`latest-mac.yml` 的 `files:` 列出它。dmg 仍然是給人安裝的。
  - 下載完、按「重啟更新」後，由 Electron 內建的 Squirrel.Mac 換掉 app。它只接受符合「正在執行的 app 的指定需求」的新版。ad-hoc 簽章預設的指定需求是那一份 app 自己的 cdhash，所以打包時改成 `identifier "com.javis.tokenmonitor"`（見「3. 註冊 Mac runner」第 5 步）。
  - Squirrel 會清掉新版的隔離標示，更新後打開不會再被 Gatekeeper 擋，不用再按「強制打開」。
  - app 要放在「應用程式」資料夾，帳號要能寫入那裡（一般是管理者）。直接從 dmg 打開、或放在「下載項目」裡沒拖過的 app 會被 macOS 移到唯讀的暫存位置（App Translocation），更新會失敗。
  - macOS 13 起若跳出「已阻止『Token Monitor』修改你 Mac 上的 App」：到「系統設定 → 隱私權與安全性 → App 管理」打開 Token Monitor，再按一次「重啟更新」。
- **從 GitHub 更新**（`TM_CLIENT_UPDATE_GITHUB_REPO`）：`app-update.yml` 是 `provider: generic`，網址是 `https://github.com/<owner>/<repo>/releases/latest/download`。app 從那裡讀 `latest*.yml`，安裝檔也從同一個位置下載，GitHub 會轉到最新 Release 的檔案。
  - 不用 electron-updater 的 github provider：版本有預發行部分（`-corp.N`）時，它只接受 tag 本身是 semver 的 Release，`client-v…` 不是，所以永遠找不到新版。
  - GitHub 的「最新」是最晚建立、不是 draft 也不是 prerelease 的 Release。本 repo 只有 `client-v*` 會建 Release，hub 的 `corp/v*` 不建。
  - 「查看 release」換成 `https://github.com/<owner>/<repo>/releases/tag/client-v<版本>`，標題旁的來源標成「GitHub releases」。
- **沒有更新來源的安裝檔**：用沒有 `TM_CLIENT_UPDATE_*` 的 `.env.client` 在本機打包的版本，安裝目錄的 `resources\`（Mac 是 `Token Monitor.app/Contents/Resources/`）底下沒有 `app-update.yml`。這些電腦要手動裝一次新版，之後才會自動提示。
- **安裝檔沒有簽章**：Windows 不核對發行者（`verifyUpdateCodeSignature: false`），Mac 只要求同一個 identifier，兩者都只靠 sha512 確認檔案和 `latest.yml`／`latest-mac.yml` 一致。能改 Release 的人就能推送任何安裝檔給所有人，Maintainer 權限要控管好。

### Tag 與版本

- tag 一律是 `client-vX.Y.Z-corp.N`。tag 的版本就是 app 的版本，也是 `latest.yml` 的 `version`；`release:client` 會檢查兩者一致，否則不建立 Release。
- app 用 semver 比較版本，**不會降版**，所以版本只能往上加：同一個上游版本 N 加 1，上游升版後從 `corp.1` 重新算（`0.64.0-corp.1` 比 `0.63.1-corp.9` 新）。
- 「最新」是 GitLab 上**最晚建立的 Release**，不是版本最大的 tag：
  - 這個專案只有 `client-v*` tag 會建立 Release。hub 的 `corp/v*` 與上游的 `v*` tag 不要建 Release：最新的 Release 沒有 `latest.yml` 時，所有 app 的更新檢查都會失敗。
  - 不要在新版之後才替舊版補建 Release；那段期間 app 會看不到真正的最新版。
  - 要修正就打下一個 N，不要刪掉 tag 重打。
- Release 要等 Windows、macOS、Linux 都打包完才建立，所以 app 不會看到檔案還不齊的 Release；Mac runner 離線時，Windows 與 Linux 也看不到新版。
- main 上手動打包的 `X.Y.Z-corp.0` 不建 Release。裝了 corp.0 的電腦會提示任何 `corp.N`，可以拿來測試更新。

## 上游更新之後

完整步驟在 [upstream-upgrade.zh-TW.md](upstream-upgrade.zh-TW.md)（上游升級 SOP）。和用戶端有關的重點：

1. `npm run upstream:update -- next`。`tests/clientBuild.test.js` 或 `tests/ownDeviceView.test.js` 失敗，代表上游動到了公司版入口依賴的地方（包括圖示的路徑、`UPSTREAM_PATCHES` 要改的那幾行、只顯示這台電腦換掉的函式）。先修 `client/` 或 `packaging/`，不改 `upstream/`。
2. 測試會過不代表每個客製都還在：上游新增語系時，`UPSTREAM_PATCHES` 的次數不會變，但新語系仍寫著 GitHub。影響報告的 `settings.appUpdate.source` 次數變化會提醒這件事。
3. 打一個不發行的 `<新版本>-corp.0` 測試版，在測試電腦上做完 SOP 的「用戶端冒煙」。用戶端不能降版，沒做完不發行。
4. 打新的 tag `client-vX.Y.Z-corp.1`。用戶端要和 hub 同一個上游版本，hub 也要一起發行（[packaging.zh-TW.md](packaging.zh-TW.md)），先 hub 後用戶端。

## repo 位置與同步上游

- 本 repo（hub 客製、公司版用戶端、CI）放在你們組織的 GitLab，例如 `https://gitlab.example.com/<group>/<project>`。用戶端的更新來源（`TM_CLIENT_UPDATE_PROJECT_URL`、`TM_CLIENT_UPDATE_PROJECT_ID`）就是這個專案。
- 上游直接從 GitHub 的 [Javis603/token-monitor](https://github.com/Javis603/token-monitor) 拉，不需要另外架鏡像：`npm run upstream:update -- next` 拉下一個 release（一版一版升），`npm run upstream:update -- vX.Y.Z` 拉指定的 release tag，跳過中間的版本要加 `--allow-skip`。細節見 [hub.zh-TW.md](hub.zh-TW.md#同步上游)「同步上游」。
- 執行 `upstream:update` 的電腦要能連到 GitHub；連不到時，設環境變數 `UPSTREAM_URL` 改從鏡像拉。

## 驗證

在一台**沒裝過 Token Monitor** 的測試電腦（或刪掉 `%APPDATA%\Token Monitor`）：

1. 執行安裝檔。沒有簽章，Windows 會顯示「Windows 已保護您的電腦」：按「其他資訊」→「仍要執行」。
2. 安裝完成後 app 自動開啟。檢查 `%APPDATA%\Token Monitor\settings.json`：`hubMode` 是 `client`、`hubUrl` 正確、`syncUploadIntervalMs` 是 `1800000`、`deviceId` 是 UUID；`secret` 已經不在這裡，改在 `credentials.json`。
3. ⚙ →「多裝置同步」：已連接到 Hub、同步上傳頻率每 30 分鐘；「一般」：開機時啟動已開啟。
4. 開機啟動的登錄：

   ```powershell
   Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run | Select-Object com.javis.tokenmonitor
   ```

5. 重新開機，app 自己啟動；30 分鐘內 dashboard 的「裝置歸屬」出現這台電腦。widget 的 LIMITS 只有這台電腦登入的帳號，裝置列表只有這一台，總量和 dashboard 上這台的數字相近（widget 的比較新）。
6. 再執行一次安裝檔（升級情境），設定不變。
7. 自動更新：裝一份比最新 Release 舊的版本（例如在本機打包的 `corp.0`，`.env.client` 設好 `TM_CLIENT_UPDATE_*`），打開 ⚙ →「一般」→「應用程式更新」按「檢查更新」，應該提示最新版；按「下載更新」、「重啟更新」後，app 重新開啟成新版本，設定不變。「查看 release」開到 GitLab 的那一版 Release。

Linux（Ubuntu）上：

1. `chmod +x Token-Monitor_<版本>_amd64.AppImage`，再執行它。AppImage 不用安裝，放在固定的位置再開，開機啟動記的是這個路徑。
2. 設定檔在 `~/.config/Token Monitor/`，檢查項目同上面第 2、3 步。
3. 開機啟動：`~/.config/autostart/token-monitor.desktop` 存在，`Exec=` 指向這個 AppImage。在 app 裡更新後，`Exec=` 改指向新版本的 AppImage，「開機時啟動」仍是開啟。

## 疑難排解

| 狀況 | 原因與處理 |
|---|---|
| `TM_CLIENT_HUB_URL must use https` | hub 是 http：設 `TM_CLIENT_ALLOW_HTTP=1`。 |
| `TM_CLIENT_VERSION … must be based on the upstream version` | tag 的 X.Y.Z 和 `upstream/package.json` 不同，改用正確的版本打 tag。 |
| CI 打包 job 說 `TM_CLIENT_HUB_URL is required` | 變數沒帶進 job：tag 不是 protected、變數的 Environments 不是 `client/production`，或在非 protected 分支手動執行。 |
| `release:client` 失敗，log 有 `curl: (6) Could not resolve host` | runner 一時查不到 GitLab 的 DNS。上傳的 curl 每個檔案會隔 10 秒再試，最多 5 次，都失敗才停下來。程式沒有問題，在 job 頁面按 Retry，不用發下一號；已經上傳的檔案會再傳一次，下載的連結拿到的是最後傳的那一份。`build:hub`、`deploy:hub` 同理。 |
| 裝好後還是本機模式、沒有預填 | 這台電腦原本就有 `settings.json`（裝過官方版），入口不會覆蓋。請使用者手動設定，或先刪掉 `%APPDATA%\Token Monitor` 再開 app（本機歷史會跟著刪除）。 |
| 一直顯示 Wrong or missing secret | hub 前面的反向代理把 http 轉址到 https 時會丟掉 `Authorization`；hub URL 直接填 `https://…`。 |
| 打包 job 失敗，log 有 `getaddrinfo ENOTFOUND github.com` | runner 查不到 GitHub 的 DNS，electron-builder 拿不到 Electron。打包時已經會等 30、60、120 秒各再試一次，三次都失敗才停下來，所以是斷線超過三分多鐘。程式沒有問題：網路恢復後在 job 頁面按 Retry，不用發下一號。一直發生時請 IT 查那台 runner 的 DNS。 |
| `ensure-vendored-tokscale` 下載失敗 | 打包主機連不到 GitHub（`github.com/Javis603/tokscale` 的 release）。 |
| Ubuntu 上 AppImage 打不開，說缺 `libfuse.so.2` | Ubuntu 22.04 起預設沒有 FUSE 2：`sudo apt install libfuse2`（24.04 是 `libfuse2t64`）。 |
| Ubuntu 24.04 上 AppImage 一開就結束，log 提到 sandbox | 系統限制了 Electron 的 sandbox；先用 `./Token-Monitor_<版本>_amd64.AppImage --no-sandbox` 開啟。 |
| 「檢查更新」說 `Cannot find latest.yml in the latest release assets` | 最新的 Release 沒有 `latest.yml`（Mac 是 `latest-mac.yml`，Linux 是 `latest-linux.yml`）：不是 `release:client` 建立的 Release，或手動刪了連結。打下一個 `client-v*` tag。 |
| `Cannot find asset "Token-Monitor_…_x64-setup.exe" in GitLab release assets` | Release 連結的名稱被改成不是檔名。在 Release 頁編輯連結，名稱改回檔名。 |
| macOS 的「檢查更新」顯示錯誤 | 沒有更新來源的 Mac 版（打包時沒有 `TM_CLIENT_UPDATE_*`），到 Release 下載新的 dmg 手動裝一次。 |
| macOS 按「重啟更新」後 app 關了又打開，版本沒變 | Squirrel.Mac 拒絕了新版。在終端機看 `log show --last 10m --predicate 'process == "ShipIt"'`：說 `did not pass validation: code failed to satisfy specified code requirement(s)` 時，用 `codesign -d -r-` 看舊版與新版的指定需求，兩者都要是 `identifier "com.javis.tokenmonitor"`；說沒有權限時，app 不在「應用程式」裡，或這個帳號不能寫入那裡。手動裝 dmg 一次。 |
| macOS 說 app「已損毀，無法打開，應丟到垃圾桶」 | app 沒有有效的簽章（ad-hoc 簽章之前打包的 dmg），下載時加上的隔離標示讓 Gatekeeper 直接拒絕。在終端機執行 `xattr -cr "/Applications/Token Monitor.app"` 再打開；新打包的 dmg 還是這樣時，在 Mac 上用 `codesign -dv` 確認有沒有 `Signature=adhoc`。 |
| macOS 的「隱私權與安全性」找不到「強制打開」 | 按鈕只在 app 剛被擋下後約一小時內出現。再打開一次 app，馬上回到「隱私權與安全性」；或改用 `xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"`。 |
| Windows／Linux 的「最新版本」後面標著 last known，按「下載更新」說 Couldn't install the update | 這個安裝檔沒有更新來源：安裝目錄的 `resources\app-update.yml` 不存在，多半是用舊 `.env.client` 在本機打包的。手動裝一次 CI 建的版本，或重新用 `build-client.ps1` 打包（現在會補上 `TM_CLIENT_UPDATE_*`）。 |
| `TM_CLIENT_UPDATE_PROJECT_URL and TM_CLIENT_UPDATE_PROJECT_ID go together` | 兩個要一起設或一起留空。 |
| `the Linux build needs a Linux host` | Linux 版只能在 Linux 上打包，用 CI 的 `build:client:linux`。 |
