fn main() {
    // 編譯時內建的公司 hub 位置與 client secret（刻意接受 secret 可從 binary 解出：client 角色只能上傳與讀取）。
    // 由 build-installer.ps1 以環境變數傳入；值改變時必須重編，否則會打包到舊值。
    println!("cargo:rerun-if-env-changed=TM_HUB_URL");
    println!("cargo:rerun-if-env-changed=TM_CLIENT_SECRET");
    // GitHub 發行的安裝檔從這個 repo（owner/repo）最新的 Release 更新（build-installer.ps1 -GitHubRepo）。
    println!("cargo:rerun-if-env-changed=TM_UPDATE_GITHUB_REPO");
    let channel = match std::env::var("TM_CLIENT_SECRET") {
        Ok(v) if !v.trim().is_empty() => "corp",
        _ => "dev",
    };
    println!("cargo:rustc-env=TM_BUILD_CHANNEL={channel}");
    // tokscale sidecar 的檔名帶 target triple（Tauri externalBin 慣例），locate.rs 用它找開發用 binary。
    let triple = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=TM_TARGET_TRIPLE={triple}");

    // 只有 GUI build 需要 Tauri context / 嵌入前端 dist（generate_context!）。
    // tm-agent（--no-default-features，無 gui feature）跳過，避免要求 ../dist 存在。
    if std::env::var_os("CARGO_FEATURE_GUI").is_some() {
        tauri_build::build();
    }
}
