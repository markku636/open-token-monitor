# 用戶端：安裝與設定

讀者：IT（核准版本、準備安裝檔、發 client 金鑰）與員工（安裝、設定）。

> **優先使用公司版安裝檔**：從本 repo 所在 GitLab 專案（例如 `https://gitlab.example.com/<group>/<project>`）的 **Deploy → Releases** 下載 `Token-Monitor_<版本>_x64-setup.exe`（dashboard 標題列的「下載 Token Monitor」也連到這裡），安裝後已連接到 hub、每 30 分鐘上傳、開機自動啟動，下面的手動設定都不用做。公司版的 widget 只顯示自己這台電腦的用量；要看全公司請開 hub 的 dashboard。Windows 與 Linux 的公司版會從同一個 Release 頁的最新版更新，有新版時在 app 裡提示。打包與發行見 [client-build.zh-TW.md](client-build.zh-TW.md)。

本文件是另一種裝法：安裝上游官方的 Token Monitor，手動填入 hub 網址與 client 金鑰。還沒有 Mac runner、打不出 macOS 安裝檔時，Mac 也用這種方式。hub 端怎麼發行見 [packaging.zh-TW.md](packaging.zh-TW.md)。

## 要裝哪一版

- **相容的版本就是 hub 所用的上游版本**，目前是 **v0.63.1**。
  - 每一版 hub 的發行文件（`docs/releases/<版本>.md`）的「相容的用戶端」寫著這個版本。
  - dashboard 管理員區的「用戶端版本」也會顯示。
- 只從上游官方的 [GitHub Releases](https://github.com/Javis603/token-monitor/releases) 下載那一版。
  - Windows：`Token-Monitor-Setup-<版本>.exe`。
  - macOS：`.dmg`，Apple Silicon 與 Intel 各一個。
- 不要用 Homebrew 的 `brew install --cask token-monitor`：它裝的是最新版，不一定是核准的版本。

## IT：準備安裝檔

1. 下載核准版本的安裝檔，核對簽章：
   - **Windows**：簽署者必須是 SignPath Foundation，狀態 `Valid`，並且有時間戳記（見上游的 [code-signing.md](../upstream/docs/code-signing.md)）：

     ```powershell
     Get-AuthenticodeSignature .\Token-Monitor-Setup-0.63.1.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
     ```

   - **macOS**：DMG 已經簽章並經過 Apple 公證。裝好之後檢查 app，結果要是 `accepted` 與 `source=Notarized Developer ID`：

     ```bash
     spctl --assess -vv "/Applications/Token Monitor.app"
     ```

2. 記下安裝檔的 SHA-256（`Get-FileHash`、`shasum -a 256`），把檔案與雜湊放在公司內部的共用位置。
3. 員工只從那裡安裝，不要各自從網路下載。派出去的全是同一個核對過的檔案。

## 員工：安裝與設定

1. 用自己的帳號登入電腦，照安裝程式的指示安裝。
2. 開啟 Token Monitor，按右下角的 ⚙，打開「多裝置同步」，選「連接到 Hub」，填入：

   | 欄位 | 填什麼 |
   |---|---|
   | Hub URL | `http://<hub 的 IP 或主機名稱>`。hub 在 port 80，不用帶 port。 |
   | 密鑰 | IT 發的 client 金鑰。 |
   | 裝置 ID | 這台電腦的財產編號，例如 `nb-2024-0137`，見下方「裝置 ID」。 |
   | 同步上傳頻率 | 每 10 分鐘。 |

3. 打開「一般」→「應用程式更新」，取消「自動下載更新」。
   - 出現更新提示時，先確認 IT 已經核准那一版。
   - 還沒核准就按 × 略過那一版。
4. 幾分鐘後，請管理員確認 dashboard 的「裝置歸屬」出現這台電腦，並且有用量。

## 裝置 ID

上游預設用主機名稱當裝置 ID：轉成小寫，英數字、`_` 與 `-` 以外的字元換成 `-`（[缺陷盤點](defects.zh-TW.md) B1）。hub 以裝置 ID 區分電腦、對應員工，所以預設值有三個問題：

- 主機名稱相同的兩台電腦會被當成同一台，用量互相覆蓋。
- 主機名稱全是中文的電腦，ID 都會變成 `device`。
- 改了主機名稱就變成一台新裝置，要重新對應員工。
  - 新 ID 會把本機保留的歷史（370 天）重送一次，舊 ID 的紀錄也還在 hub 上，所以報表會把重疊的日期算兩次。
  - hub 沒有合併兩台裝置的功能。管理員刪除舊裝置，只會把它從裝置清單上拿掉，它的用量仍然算在報表與 dashboard 裡。

所以每台電腦都要填一個**固定、不會重複**的裝置 ID，而且要在第一次連上 hub 之前填好。建議用財產編號，只用小寫英數字與 `-`（hub 只收 `A-Z a-z 0-9 _ . -`，最多 128 字）。重灌之後填回同一個值，就還是同一台。

## 金鑰與連線

- **client 金鑰發給全體員工。**
  - 它只能上傳、讀統計，不能管理，也不能讀報表。
  - 不要把 admin 金鑰（`TOKEN_MONITOR_SECRET`）發給任何用戶端。
- **port 80 是 http，金鑰與用量在網路上都是明碼**（[缺陷盤點](defects.zh-TW.md) B11）。
  - 上游的用戶端不會警告。
  - hub 只能在公司內網使用，hub 主機的防火牆只開放公司的網段。
  - 要加密時，在 hub 前面放 HTTPS 反向代理，使用內部 CA 的憑證，用戶端改填 `https://…`。內部 CA 能不能被用戶端信任，要先在一台電腦上驗證。

### 輪替 client 金鑰

原則上只在外洩時才換：

1. 在 hub 的 `TOKEN_MONITOR_CLIENT_SECRETS` 加上新金鑰，新舊並列，然後重啟 hub。
2. 通知員工在「多裝置同步」的「密鑰」貼上新金鑰。
3. 用 `ingest_events.auth_key_index` 確認已經沒有裝置在用舊金鑰。這個欄位記的是金鑰在清單裡的位置，從 0 算起。
4. 從 `TOKEN_MONITOR_CLIENT_SECRETS` 移除舊金鑰，再重啟 hub。

## 風險與緩解

直接安裝上游的用戶端，省下自己打包的成本：不必維護打包腳本，也不必為了 macOS 架 GitLab runner。代價是用戶端的版本與來源不在公司的控制裡。

| 風險 | 會發生什麼 | 緩解 |
|---|---|---|
| **用戶端比伺服器新** | 使用者自己更新之後，新版用戶端可能送出 hub 還不認得的欄位或格式。<br>- 輕則新資料被忽略。<br>- 重則上傳被 hub 的輸入驗證拒收，那台電腦的用量停在最後一次成功的上傳。 | - hub 跟著上游的 release 更新（`npm run upstream:update -- <tag>`，再 `npm run build:image`），每一版的發行文件寫明相容的用戶端版本。<br>- 關掉「自動下載更新」，只推核准的版本。<br>- dashboard 的「用戶端版本」會用 ⚠ 標出比 hub 新的裝置。看到了，就請使用者換回核准的版本，或者提早升級 hub。 |
| **外部更新被汙染** | 用戶端的安裝檔與更新都來自 GitHub。上游的帳號、release 流程或下載途徑一旦被入侵，惡意版本就會直接裝進員工的電腦。<br>- 用戶端讀得到本機 AI 工具的紀錄，也讀得到額度查詢用的帳號憑證。 | - 只用上游官方的 GitHub release。<br>- IT 核對簽章與雜湊（見上方），把核對過的檔案放在內部位置。<br>- 關掉自動下載更新。新版本先由 IT 核對，在一台測試機上試用後才公告。<br>- 追蹤上游的 release notes 與 security advisory。 |

和原本自己打包的用戶端相比，還有這些代價：

- **裝置 ID** 回到主機名稱，要手動填（見上方，B1）。
- **明碼傳輸**：安裝檔不再強制 https（見上方，B11）。
- **沒有公司信箱**：上游用戶端不回報使用者的公司信箱（`ownerEmail`）。員工的自動對應只能靠 AI 帳號的 email，對不到的由管理員手動歸類（[hub.zh-TW.md](hub.zh-TW.md#手動歸類-email)「手動歸類 email」）。
- **不能刪除裝置、不能儲存訂閱**：widget 的這兩個動作用的是 client 金鑰，hub 會回 403，要由管理員處理。
- **流量**：每個 widget 都會連上 `/api/stats/stream`，也會拉 `/api/devices`，裝置一多（例如數百台）流量就很大。hub 已經對 stats 做了時間窗快取與壓縮；pilot 期間要量測出口流量。
- **看得到同事的用量**：官方版的 widget 顯示 hub 上全部裝置的加總，包括同事的 AI 帳號與用量；公司版只顯示這台電腦（[client-build.zh-TW.md](client-build.zh-TW.md)「只顯示這台電腦」）。
- **macOS** 一樣手動設定，更新同樣來自 GitHub。
