# client/

公司版 Electron 用戶端的入口與（可選的）品牌檔。打包流程見 [docs/client-build.zh-TW.md](../docs/client-build.zh-TW.md)。

- `electron/main.js`：打包後成為 app 裡的 `corp/main.js`。它寫入首次啟動的設定（hub 位址、client 金鑰、上傳間隔、開機啟動），接著執行上游的 `src/electron/main.js`。

## 換成自己的 logo（可選）

repo 不附任何 logo。沒放下面這些檔案時，用戶端沿用上游的 Σ 圖示。要換成自己組織的 logo，把檔案放在下面的位置再打包，不需要改程式：

| 檔案 | 作用 |
|---|---|
| `client/assets/<路徑>` | 逐檔取代上游 `assets/<路徑>`，例如 `icon.png`（app 與安裝檔）、`icon-win.png`（Windows 系統匣）、`icons/token-monitor.svg`（app 內的標誌）、`icons/tray-token-monitor.png`（macOS 選單列範本圖）。上游已經沒有的路徑會讓打包失敗，避免放了沒人看得到的檔案。 |
| `client/build/icon-win.ico` | Windows 程式、安裝檔與工作列圖示。electron-builder 由 png 產生的 .ico 缺少 20、30、36、40 px，在 125%／150% 縮放下會模糊；自己準備一個含 16–256 px 各尺寸的 .ico 就不會。沒有時用上游的 `assets/icon-win.png`。 |
| `client/electron/title-logo.png` | 白色的小 logo，畫在小工具左上角，取代上游的 Σ；上游的滑鼠與點擊行為不變。 |

要確認 logo 有生效，可以跑 `npm run build:client -- --platform win --dry-run`：輸出的 `win.icon` 會指向你的 .ico。實際打包時，log 的 `Logo:` 這一行會列出被取代的檔案。
