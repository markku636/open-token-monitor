[English version ↓](#english)

## 下載哪一個？

| 你的電腦 | 下載這個 |
|---|---|
| **Windows 10 / 11** | [Token-Monitor_@VERSION@_x64-setup.exe](@DOWNLOADS@/windows) |
| **Mac，Apple 晶片（M1、M2、M3、M4…）** | [Token-Monitor_@VERSION@_aarch64.dmg](@DOWNLOADS@/macos) |
| **Linux（x64，例如 Ubuntu）** | [Token-Monitor_@VERSION@_amd64.AppImage](@DOWNLOADS@/linux) |

不確定是哪一種 Mac：點螢幕左上角的蘋果圖示 →「關於這台 Mac」，「晶片」寫 Apple M… 就下載上面的 dmg。寫「處理器 Intel」的 Mac 目前不支援。

## 安裝

照 **[安裝說明](@INSTALL@?lang=zh-TW)** 一步一步做：[Windows](@INSTALL@?lang=zh-TW#windows)、[Mac](@INSTALL@?lang=zh-TW#macos)、[Linux](@INSTALL@?lang=zh-TW#linux)。Windows 與 Mac 的每一步旁邊都畫著那一步的畫面，要按的地方圈了起來。

公司還沒有程式碼簽章憑證，第一次打開時 Windows 與 macOS 會擋下，照安裝說明做就能打開。裝好打開後，Token Monitor 會自己連上公司的 hub，**不用輸入任何設定**，之後開機也會自動啟動。

## 已經裝了舊版？

直接安裝新版即可，設定和資料都會保留。

app 會自己檢查更新：有新版時 app 裡會提示，按「下載更新」再按「重啟更新」就完成，不用再回來這裡下載。打包時沒有設定更新來源的舊版本還不會檢查，要手動裝一次新版；Mac 手動裝好新版後第一次打開會再被擋一次，照[安裝說明的 Mac 步驟](@INSTALL@?lang=zh-TW#macos)做即可。Mac 的 app 要放在「應用程式」裡才能在 app 裡更新，更新後打開不會再被擋。

Linux 手動換新的 AppImage 時，先刪掉舊的檔案再打開新的，開機啟動會自動改成新的檔案。在 app 裡更新則不用做任何事。

## 遇到問題

請聯絡 Token Monitor 的管理者，並告訴他你的作業系統和這個版本號：**@VERSION@**。

---

# English

## Which file do I download?

| Your computer | Download this |
|---|---|
| **Windows 10 / 11** | [Token-Monitor_@VERSION@_x64-setup.exe](@DOWNLOADS@/windows) |
| **Mac with Apple silicon (M1, M2, M3, M4…)** | [Token-Monitor_@VERSION@_aarch64.dmg](@DOWNLOADS@/macos) |
| **Linux (x64, such as Ubuntu)** | [Token-Monitor_@VERSION@_amd64.AppImage](@DOWNLOADS@/linux) |

Not sure which Mac you have? Click the Apple menu in the top-left corner of the screen → "About This Mac". If "Chip" says Apple M…, download the dmg above. Macs that list an Intel "Processor" are not supported yet.

## Install

Follow the **[install guide](@INSTALL@?lang=en)** step by step: [Windows](@INSTALL@?lang=en#windows), [Mac](@INSTALL@?lang=en#macos), [Linux](@INSTALL@?lang=en#linux). For Windows and Mac, each step has a picture of that screen with what to click circled.

The company doesn't have a code signing certificate yet, so Windows and macOS block the app the first time you open it; the guide shows how to open it anyway. Once installed and opened, Token Monitor connects to the company hub by itself. **There is nothing to set up**, and it starts by itself every time you turn on the computer.

## Already have an older version?

Just install the new version. Your settings and data are kept.

The app checks for updates by itself: when there's a new version, the app tells you. Click "Download update", then "Restart to update", and you're done. No need to come back here to download it. Older versions built without an update source don't check yet, so install the new version by hand once. The first time you open a new version installed by hand on a Mac, macOS blocks it once more: follow the [Mac steps in the install guide](@INSTALL@?lang=en#macos). On a Mac, the app has to be in Applications to update from inside the app, and it isn't blocked after such an update.

On Linux, when you replace the AppImage by hand, delete the old file before opening the new one: starting at login switches to the new file by itself. Updating from inside the app needs nothing from you.

## Need help?

Contact your Token Monitor administrator and tell them your operating system and this version number: **@VERSION@**.
