<#
.SYNOPSIS
    Token Monitor（Tauri）Windows 安裝檔打包腳本。產出 NSIS 安裝檔（currentUser，免管理員）。

.DESCRIPTION
    流程：
      1. 檢查 Node.js、Rust、MSVC Build Tools
      2. 驗證 hub 位置與 client secret（有給 -HubUrl 時）
      3. npm ci、下載並驗證 tokscale
      4. （選用）更新版本號：tauri.conf.json 為單一事實來源，同步 package.json / Cargo.toml
      5. npm run verify（-SkipVerify 可略過）
      6. tauri build（只產 NSIS；公司版另產 updater 簽章 .sig）
      7. 收整到 release\v<版本>\（安裝檔、.sig、latest.json）並印出 SHA-256
      8. （選用）發佈到 hub 的 releases 目錄：安裝檔 → .sig → latest.json

    hub 位置與 client secret 只在第 6 步以環境變數 TM_HUB_URL / TM_CLIENT_SECRET 交給編譯器，
    結束時清除。secret 絕不當命令列參數傳（會留在程序清單與 shell 歷史）：
    用環境變數 TM_CLIENT_SECRET 或 -SecretFile。

    沒給 -HubUrl 時產出「本機模式」安裝檔（檔名帶 -local）：只統計、不上傳、不自動更新；
    仍可在設定視窗手動填入 hub 位置與金鑰。這種安裝檔不要發給員工。

    自動更新：公司版需要 Tauri updater 的簽章金鑰（一次性產生，私鑰交給你的密碼管理工具 / secret store 保管）：
        npm run tauri signer generate -- --ci -w D:\secure\tokenmonitor.key
    -SigningKeyFile 指向私鑰，同目錄的 .pub 是公鑰；公鑰在打包時以 --config 寫進
    plugins.updater.pubkey，repo 裡不放任何金鑰。私鑰有密碼時先設 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。
    私鑰遺失 = 已安裝的 client 再也無法自動更新（只能手動重裝），務必備份。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
    # 本機模式安裝檔，版本不變

.EXAMPLE
    $env:TM_CLIENT_SECRET = "<client secret>"
    powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -HubUrl https://tokens.example.internal -SetVersion 0.2.0
    # 公司版：內建 hub 位置與 secret

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -HubUrl https://tokens.example.internal -SecretFile D:\secure\client-secret.txt `
        -SigningKeyFile D:\secure\tokenmonitor.key -Bump patch -ReleasesDir \\hub-host\token-monitor\releases -NotesFile notes.md
    # 公司版 + 自動更新，打包後直接發佈到 hub
#>

param(
    # 公司 hub 的網址（https）。不給就產出本機模式安裝檔。
    [string]$HubUrl,

    # 內含 client secret 的檔案（一行）。不給就讀環境變數 TM_CLIENT_SECRET。
    [string]$SecretFile,

    # 版本號遞增方式；預設不動（核准的版本應該刻意指定）。
    [ValidateSet("patch", "minor", "major", "none")]
    [string]$Bump = "none",

    # 直接指定版本號（major.minor.patch），優先於 -Bump。
    [string]$SetVersion,

    # 允許 http:// 的 hub（只給測試環境）。
    [switch]$AllowHttp,

    # Tauri updater 的簽章私鑰（同目錄要有 <檔名>.pub）。不給就讀環境變數
    # TAURI_SIGNING_PRIVATE_KEY（私鑰內容）與 TM_UPDATER_PUBKEY（公鑰內容）。
    [string]$SigningKeyFile,

    # 公司版不帶自動更新（沒有簽章金鑰時；之後每一版都要手動重裝）。
    [switch]$NoUpdater,

    # 發佈目錄：hub 的 TOKEN_MONITOR_RELEASES_DIR（可以是 UNC 路徑）。
    [string]$ReleasesDir,

    # 放進 latest.json 的版本說明（純文字或 Markdown），設定頁與 widget 橫幅會顯示。
    [string]$NotesFile,

    # 略過 npm run verify。
    [switch]$SkipVerify,

    # 結束時不等待按鍵（CI / 自動化用）。
    [switch]$NoPause
)

# native 指令（cargo / tauri / npm）會把進度寫到 stderr。PowerShell 5.1 下 'Stop' 會把它當成
# 終止錯誤而中斷腳本，所以全域用 Continue，native 指令一律以 $LASTEXITCODE 判斷成敗。
$ErrorActionPreference = "Continue"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Test-Cmd($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }
function Assert-LastExit($what) {
    if ($LASTEXITCODE -ne 0) {
        throw "$what 失敗（exit code $LASTEXITCODE）。請往上捲動查看實際錯誤輸出。"
    }
}

# Rust 的 x86_64-pc-windows-msvc 需要 link.exe；用 vswhere 找 VC 工具元件比直接找 link.exe 可靠。
function Test-MsvcLinker {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $false }
    $path = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    return [bool]$path
}

# --- 版本號（tauri.conf.json 為單一事實來源）-----------------------------------
$VersionFiles = @{
    TauriConf = Join-Path $PSScriptRoot "src-tauri\tauri.conf.json"
    PkgJson   = Join-Path $PSScriptRoot "package.json"
    CargoToml = Join-Path $PSScriptRoot "src-tauri\Cargo.toml"
}

# 一律 UTF-8 讀寫（檔內有中文）。PS 5.1 的 Get-Content / Set-Content 預設走系統 ANSI 會讀壞。
function Read-TextFile([string]$path) { [System.IO.File]::ReadAllText($path) }
function Write-Utf8NoBom([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))
}

function Get-CurrentVersion {
    $m = [regex]::Match((Read-TextFile $VersionFiles.TauriConf), '"version"\s*:\s*"([^"]+)"')
    if (-not $m.Success) { throw "在 tauri.conf.json 找不到 version 欄位。" }
    return $m.Groups[1].Value
}

function Step-Version([string]$v, [string]$kind) {
    if ($v -notmatch '^\d+\.\d+\.\d+$') { throw "目前版本 '$v' 不是 major.minor.patch，無法自動遞增。" }
    $p = $v -split '\.'
    [int]$maj = $p[0]; [int]$min = $p[1]; [int]$pat = $p[2]
    switch ($kind) {
        "major" { $maj++; $min = 0; $pat = 0 }
        "minor" { $min++; $pat = 0 }
        "patch" { $pat++ }
    }
    return "$maj.$min.$pat"
}

function Set-AllVersions([string]$newVersion) {
    # JSON：第一個 "version" 就是頂層版本（依賴不含此鍵）。
    foreach ($f in @($VersionFiles.TauriConf, $VersionFiles.PkgJson)) {
        $re = [regex]'("version"\s*:\s*")[^"]+(")'
        Write-Utf8NoBom $f ($re.Replace((Read-TextFile $f), ('${1}' + $newVersion + '${2}'), 1))
    }
    # Cargo.toml：只改 [package] 的 version（行首），依賴的行內 { version = "2" } 不受影響。
    $reCargo = [regex]::new('(?m)^(version\s*=\s*")[^"]+(")')
    Write-Utf8NoBom $VersionFiles.CargoToml ($reCargo.Replace((Read-TextFile $VersionFiles.CargoToml), ('${1}' + $newVersion + '${2}'), 1))
}

function Invoke-Pause {
    if ($NoPause) { return }
    try { if ([Console]::IsInputRedirected) { return } } catch { return }
    Read-Host "按 Enter 結束" | Out-Null
}

$savedHub = $env:TM_HUB_URL
$savedSecret = $env:TM_CLIENT_SECRET
$savedSigningKey = $env:TAURI_SIGNING_PRIVATE_KEY
$overlayPath = Join-Path $PSScriptRoot "tmp\updater.conf.json"
$exitCode = 0
try {
    Write-Step "Token Monitor 打包開始"
    Set-Location $PSScriptRoot

    # --- 1. 工具鏈 ---
    if (-not (Test-Cmd node)) {
        Write-Step "未偵測到 Node.js，嘗試以 winget 安裝…"
        if (-not (Test-Cmd winget)) { throw "找不到 winget，請手動安裝 Node.js LTS：https://nodejs.org/" }
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (-not (Test-Cmd node)) { throw "Node.js 安裝後仍無法使用，請重開 PowerShell 再執行一次。" }
    }
    Write-Host "Node.js：$(node --version)" -ForegroundColor Green
    if (-not (Test-Cmd cargo)) {
        Write-Step "未偵測到 Rust，嘗試以 winget 安裝…"
        if (-not (Test-Cmd winget)) { throw "找不到 winget，請手動安裝 Rust：https://rustup.rs/" }
        winget install -e --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
        $env:Path += ";$env:USERPROFILE\.cargo\bin"
        if (-not (Test-Cmd cargo)) { throw "Rust 安裝後仍無法使用，請重開 PowerShell 再執行一次。" }
    }
    Write-Host "Rust：$(cargo --version)" -ForegroundColor Green
    if (-not (Test-MsvcLinker)) {
        throw "未偵測到 MSVC C++ Build Tools。請安裝 Visual Studio Build Tools 並勾選『使用 C++ 的桌面開發』：https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    }
    Write-Host "MSVC C++ Build Tools：已安裝" -ForegroundColor Green

    # --- 2. hub 位置與 secret ---
    $corp = $false
    $secret = $null
    if ($HubUrl) {
        $HubUrl = $HubUrl.Trim().TrimEnd('/')
        if ($HubUrl -match '["''\\\s]') { throw "-HubUrl 不可含引號、反斜線或空白：$HubUrl" }
        $uri = $null
        if (-not [System.Uri]::TryCreate($HubUrl, [System.UriKind]::Absolute, [ref]$uri)) { throw "-HubUrl 不是有效的網址：$HubUrl" }
        if ($uri.Scheme -ne "https" -and -not ($uri.Scheme -eq "http" -and $AllowHttp)) {
            throw "-HubUrl 必須是 https（測試環境用 http 請加 -AllowHttp）：$HubUrl"
        }
        if ($SecretFile) {
            if (-not (Test-Path $SecretFile)) { throw "找不到 -SecretFile：$SecretFile" }
            $secret = (Read-TextFile (Resolve-Path $SecretFile)).Trim()
        } else {
            $secret = "$savedSecret".Trim()
        }
        if (-not $secret) { throw "有 -HubUrl 時必須提供 client secret：設定環境變數 TM_CLIENT_SECRET 或使用 -SecretFile。" }
        if ($secret.Length -lt 8) { throw "client secret 太短（少於 8 個字元）。" }
        if ($secret -match '[\r\n"]') { throw "client secret 不可含換行或引號。" }
        $corp = $true
        Write-Host "公司版：hub = $HubUrl，secret = ••••$($secret.Substring($secret.Length - 4))" -ForegroundColor Green
    } else {
        Write-Host "未指定 -HubUrl：產出本機模式安裝檔（不上傳，檔名帶 -local；不要發給員工）。" -ForegroundColor Yellow
    }

    # --- 2b. 自動更新的簽章金鑰（只有公司版）---
    $updater = $false
    $signingKey = $null
    $pubkey = $null
    if ($corp -and -not $NoUpdater) {
        if ($SigningKeyFile) {
            if (-not (Test-Path $SigningKeyFile)) { throw "找不到 -SigningKeyFile：$SigningKeyFile" }
            $keyPath = (Resolve-Path $SigningKeyFile).Path
            $pubPath = "$keyPath.pub"
            if (-not (Test-Path $pubPath)) { throw "找不到公鑰 $pubPath（tauri signer generate 會和私鑰一起產生）。" }
            $signingKey = (Read-TextFile $keyPath).Trim()
            $pubkey = (Read-TextFile $pubPath).Trim()
        } else {
            $signingKey = "$savedSigningKey".Trim()
            $pubkey = "$env:TM_UPDATER_PUBKEY".Trim()
        }
        if (-not $signingKey -or -not $pubkey) {
            throw "公司版需要自動更新的簽章金鑰：用 -SigningKeyFile，或設定環境變數 TAURI_SIGNING_PRIVATE_KEY 與 TM_UPDATER_PUBKEY。確定這一版不要自動更新時加 -NoUpdater。"
        }
        $updater = $true
        Write-Host "自動更新：開啟（feed = $HubUrl/updates/latest.json）" -ForegroundColor Green
    } elseif ($corp) {
        Write-Host "自動更新：關閉（-NoUpdater）。之後的每一版都要在每台電腦手動重裝。" -ForegroundColor Yellow
    }
    if ($ReleasesDir -and -not $updater) {
        throw "-ReleasesDir 只給有自動更新的公司版：hub 靠 latest.json 決定核准版本與下載連結。"
    }
    if ($NotesFile -and -not (Test-Path $NotesFile)) { throw "找不到 -NotesFile：$NotesFile" }

    # --- 3. 前端依賴與 tokscale ---
    Write-Step "安裝前端依賴（npm ci）"
    npm ci --no-audit --no-fund
    Assert-LastExit "npm ci"
    Write-Step "下載並驗證 tokscale"
    node scripts/ensure-tokscale.mjs --platform=win32-x64
    Assert-LastExit "ensure-tokscale"

    # --- 4. 版本號 ---
    if ($SetVersion) {
        if ($SetVersion -notmatch '^\d+\.\d+\.\d+$') { throw "-SetVersion 需為 major.minor.patch（例：1.2.3），收到 '$SetVersion'。" }
        $old = Get-CurrentVersion
        Set-AllVersions $SetVersion
        Write-Host "版本號：$old -> $SetVersion" -ForegroundColor Green
    } elseif ($Bump -ne "none") {
        $old = Get-CurrentVersion
        $new = Step-Version $old $Bump
        Set-AllVersions $new
        Write-Host "版本號：$old -> $new" -ForegroundColor Green
    }
    $version = Get-CurrentVersion
    Write-Host "打包版本：$version" -ForegroundColor Green

    # --- 5. 驗證（不帶 hub / secret：測試用的 debug binary 不需要內建值）---
    Remove-Item Env:TM_HUB_URL -ErrorAction SilentlyContinue
    Remove-Item Env:TM_CLIENT_SECRET -ErrorAction SilentlyContinue
    if (-not $SkipVerify) {
        Write-Step "驗證（npm run verify）"
        npm run verify
        Assert-LastExit "npm run verify"
    }

    # --- 6. 建置 ---
    # Tauri 在 Windows 對含空白的路徑容易出錯：這種情況把 target 移到不含空白處。
    $targetDir = Join-Path $PSScriptRoot "src-tauri\target"
    if ($PSScriptRoot -match '\s') {
        $targetDir = Join-Path $env:LOCALAPPDATA "token-monitor-tauri\rust-target"
        $env:CARGO_TARGET_DIR = $targetDir
        Write-Host "專案路徑含空白，Rust target 改到：$targetDir" -ForegroundColor Yellow
    }
    if ($corp) {
        $env:TM_HUB_URL = $HubUrl
        $env:TM_CLIENT_SECRET = $secret
    }
    # --ci：不要互動提示。沒有 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 時 tauri build 會停下來問私鑰密碼，
    # 而 PowerShell 5.1 無法把環境變數設成空字串；--ci 模式下未設密碼即視為空密碼（無密碼的金鑰）。
    $buildArgs = @("run", "tauri", "build", "--", "--bundles", "nsis", "--ci")
    if ($updater) {
        # 公鑰與 createUpdaterArtifacts 只在這次建置生效（--config 以 JSON merge patch 疊在 tauri.conf.json 上）。
        $updaterConf = [ordered]@{ pubkey = $pubkey }
        if ($HubUrl.StartsWith("http://")) {
            # 只有 -AllowHttp 的測試 hub 才會走到這裡；updater 預設拒絕 http 的 feed。
            $updaterConf.dangerousInsecureTransportProtocol = $true
        }
        $overlay = [ordered]@{
            bundle  = [ordered]@{ createUpdaterArtifacts = $true }
            plugins = [ordered]@{ updater = $updaterConf }
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $overlayPath) | Out-Null
        Write-Utf8NoBom $overlayPath ($overlay | ConvertTo-Json -Depth 5)
        $buildArgs += @("--config", $overlayPath)
        $env:TAURI_SIGNING_PRIVATE_KEY = $signingKey
    }
    Write-Step "tauri build（第一次會編譯 release，需要數分鐘）"
    # npm.cmd，不用 npm：npm 11 的 npm.ps1 從 $MyInvocation.Line 重新解析參數，splatting（@buildArgs）會被解析壞。
    & npm.cmd @buildArgs
    Assert-LastExit "tauri build"
    Remove-Item Env:TM_HUB_URL -ErrorAction SilentlyContinue
    Remove-Item Env:TM_CLIENT_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue

    # --- 7. 收整 ---
    Write-Step "收整安裝檔"
    $nsisDir = Join-Path $targetDir "release\bundle\nsis"
    $built = Get-ChildItem -Path $nsisDir -Filter "*_${version}_x64-setup.exe" -ErrorAction SilentlyContinue
    if (-not $built -or @($built).Count -ne 1) { throw "在 $nsisDir 找不到唯一的 *_${version}_x64-setup.exe。" }
    $releaseDir = Join-Path $PSScriptRoot "release\v$version"
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    # 檔名不含空白：URL 與 IT 的靜默安裝指令（/S）比較好寫。
    $name = if ($corp) { "TokenMonitor_${version}_x64-setup.exe" } else { "TokenMonitor_${version}_x64-local-setup.exe" }
    $dest = Join-Path $releaseDir $name
    Copy-Item -Path $built.FullName -Destination $dest -Force
    $hash = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLowerInvariant()
    $sizeMb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
    $feed = $null
    if ($updater) {
        # minisign 簽的是檔案內容，改名不影響驗章。
        $sig = "$($built.FullName).sig"
        if (-not (Test-Path $sig)) { throw "找不到 updater 簽章 $sig（createUpdaterArtifacts 沒有生效？）" }
        Copy-Item -Path $sig -Destination "$dest.sig" -Force
        $feed = Join-Path $releaseDir "latest.json"
        $feedArgs = @("scripts/make-latest-json.mjs", "--version", $version, "--installer", $dest, "--hub-url", $HubUrl, "--out", $feed)
        if ($NotesFile) { $feedArgs += @("--notes-file", (Resolve-Path $NotesFile).Path) }
        & node @feedArgs
        Assert-LastExit "make-latest-json"
    }

    # --- 8. 發佈 ---
    if ($ReleasesDir) {
        Write-Step "發佈到 $ReleasesDir"
        New-Item -ItemType Directory -Force -Path $ReleasesDir | Out-Null
        # 順序很重要：client 絕不能看到安裝檔或簽章還不存在的 feed。
        Copy-Item -Path $dest -Destination (Join-Path $ReleasesDir $name) -Force
        Copy-Item -Path "$dest.sig" -Destination (Join-Path $ReleasesDir "$name.sig") -Force
        Copy-Item -Path $feed -Destination (Join-Path $ReleasesDir "latest.json") -Force
        Write-Host "已發佈：$name、$name.sig、latest.json" -ForegroundColor Green
    }

    Write-Step "打包完成"
    Write-Host "  檔案   $dest" -ForegroundColor Green
    Write-Host "  大小   $sizeMb MB"
    Write-Host "  SHA256 $hash"
    Write-Host "  版本   $version（$(if ($corp) { "公司版，hub = $HubUrl" } else { '本機模式' })）"
    Write-Host ""
    Write-Host "注意：" -ForegroundColor Yellow
    Write-Host "  - 安裝檔沒有程式碼簽章，第一次執行會出現 SmartScreen 警告（其他資訊 → 仍要執行）。"
    if ($updater) {
        Write-Host "  - 自動更新：已簽章。latest.json 在 $feed；-ReleasesDir 沒給時，要依序把安裝檔、.sig、latest.json 複製到 hub 的 releases 目錄。"
    } else {
        Write-Host "  - 這一版沒有自動更新。"
    }
    Write-Host "  - 靜默安裝：$name /S（必須在員工本人的 Windows 帳號下執行，不要用 SYSTEM 或別人的管理員帳號）。"
}
catch {
    Write-Host "`n打包失敗：$($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}
finally {
    # 還原呼叫端的環境變數，secret 不殘留在這個 shell 以外的地方。
    if ($null -ne $savedHub) { $env:TM_HUB_URL = $savedHub } else { Remove-Item Env:TM_HUB_URL -ErrorAction SilentlyContinue }
    if ($null -ne $savedSecret) { $env:TM_CLIENT_SECRET = $savedSecret } else { Remove-Item Env:TM_CLIENT_SECRET -ErrorAction SilentlyContinue }
    if ($null -ne $savedSigningKey) { $env:TAURI_SIGNING_PRIVATE_KEY = $savedSigningKey } else { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue }
    Remove-Item $overlayPath -ErrorAction SilentlyContinue
    Invoke-Pause
}
exit $exitCode
