[English version ↓](#english)

## 下載哪一個？

| 你的電腦 | 下載這個 |
|---|---|
| **Windows 10 / 11** | [Token-Monitor_@VERSION@_x64-setup.exe](@DOWNLOADS@/Token-Monitor_@VERSION@_x64-setup.exe) |
| **Mac，Apple 晶片（M1、M2、M3、M4…）** | [Token-Monitor_@VERSION@_aarch64.dmg](@DOWNLOADS@/Token-Monitor_@VERSION@_aarch64.dmg) |
| **Linux（x64，例如 Ubuntu）** | [Token-Monitor_@VERSION@_amd64.AppImage](@DOWNLOADS@/Token-Monitor_@VERSION@_amd64.AppImage) |

Windows 也可以改用比較輕巧的 **Rust 版**（@RUSTVERSION@）：[Token-Monitor-Rust_@RUSTVERSION@_x64-setup.exe](@DOWNLOADS@/Token-Monitor-Rust_@RUSTVERSION@_x64-setup.exe)。兩個版本擇一安裝即可。

不確定是哪一種 Mac：點螢幕左上角的蘋果圖示 →「關於這台 Mac」，「晶片」寫 Apple M… 就下載上面的 dmg。寫「處理器 Intel」的 Mac 目前不支援。

## 安裝

安裝檔沒有程式碼簽章，第一次打開時系統會擋下：

- **Windows**：出現「Windows 已保護您的電腦」時，按「其他資訊」→「仍要執行」。
- **Mac**：把 app 拖進「應用程式」。第一次打開被擋時，到「系統設定」→「隱私權與安全性」，往下捲到「安全性」，按「強制打開」（Open Anyway）。
- **Linux**：先 `chmod +x` 這個 AppImage 再打開。

## 連上你的 hub

這個安裝檔**不帶任何 hub 網址或金鑰**，裝好後要自己設定一次：

1. 向 Token Monitor 的管理者拿 **hub 網址**與 **client 金鑰**。
2. 打開 Token Monitor，按右下角的 ⚙，打開「多裝置同步」，選「連接到 Hub」。
3. 填入 Hub URL 與密鑰。

之後每 30 分鐘把用量上傳到 hub，開機也會自動啟動。

Rust 版：按 ⚙ 打開設定，在「公司 hub」填入位置與 client 金鑰，按「套用」。

## 已經裝了舊版？

直接安裝新版即可，設定和資料都會保留。

app 會自己檢查這裡的最新版：有新版時 app 裡會提示，按「下載更新」再按「重啟更新」就完成。Mac 的 app 要放在「應用程式」裡才能在 app 裡更新。

## 遇到問題

請聯絡 Token Monitor 的管理者，並告訴他你的作業系統和這個版本號：**@VERSION@**。

---

# English

## Which file do I download?

| Your computer | Download this |
|---|---|
| **Windows 10 / 11** | [Token-Monitor_@VERSION@_x64-setup.exe](@DOWNLOADS@/Token-Monitor_@VERSION@_x64-setup.exe) |
| **Mac with Apple silicon (M1, M2, M3, M4…)** | [Token-Monitor_@VERSION@_aarch64.dmg](@DOWNLOADS@/Token-Monitor_@VERSION@_aarch64.dmg) |
| **Linux (x64, such as Ubuntu)** | [Token-Monitor_@VERSION@_amd64.AppImage](@DOWNLOADS@/Token-Monitor_@VERSION@_amd64.AppImage) |

On Windows you can use the lighter **Rust edition** (@RUSTVERSION@) instead: [Token-Monitor-Rust_@RUSTVERSION@_x64-setup.exe](@DOWNLOADS@/Token-Monitor-Rust_@RUSTVERSION@_x64-setup.exe). Install one of the two.

Not sure which Mac you have? Click the Apple menu in the top-left corner of the screen → "About This Mac". If "Chip" says Apple M…, download the dmg above. Macs that list an Intel "Processor" are not supported yet.

## Install

The installers have no code signature, so the system blocks them the first time you open them:

- **Windows**: when "Windows protected your PC" appears, click "More info" → "Run anyway".
- **Mac**: drag the app into Applications. When it is blocked the first time, open System Settings → Privacy & Security, scroll down to Security and click "Open Anyway".
- **Linux**: `chmod +x` the AppImage, then open it.

## Connect to your hub

This installer **carries no hub address or key**. Set it up once after installing:

1. Ask your Token Monitor administrator for the **hub URL** and a **client key**.
2. Open Token Monitor, click ⚙ at the bottom right, open "Multi-device Sync" and choose "Connect to a hub".
3. Enter the Hub URL and the secret.

From then on it uploads your usage to the hub every 30 minutes and starts by itself every time you turn on the computer.

Rust edition: click ⚙ to open Settings, enter the address and client key under "Company hub", and click "Apply".

## Already have an older version?

Just install the new version. Your settings and data are kept.

The app checks this page's latest version by itself: when there's a new version, the app tells you. Click "Download update", then "Restart to update", and you're done. On a Mac, the app has to be in Applications to update from inside the app.

## Need help?

Contact your Token Monitor administrator and tell them your operating system and this version number: **@VERSION@**.
