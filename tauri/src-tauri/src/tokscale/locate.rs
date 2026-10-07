//! 找 tokscale 執行檔。
//!
//! 順序：`TOKSCALE_BIN` → exe 旁的 `tokscale.exe`（Tauri externalBin 安裝後的位置）→
//! exe 旁帶 target triple 的檔名 → debug build 才找 `src-tauri/binaries/`
//! （`npm run ensure:tokscale` 下載的位置）→ PATH。

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokscaleBinary {
    pub path: PathBuf,
    /// 從哪裡找到的：env / bundled / dev / path。
    pub source: &'static str,
}

impl TokscaleBinary {
    /// 群組能力的快取鍵：換了 binary 就要重新探測（上游 collector.js 的 identity）。
    pub fn identity(&self) -> String {
        format!("{}|{}", self.source, self.path.display())
    }
}

pub const TARGET_TRIPLE: &str = env!("TM_TARGET_TRIPLE");

fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

pub fn candidates() -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    if let Some(p) = std::env::var_os("TOKSCALE_BIN").filter(|v| !v.is_empty()) {
        out.push((PathBuf::from(p), "env"));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        out.push((dir.join(exe_name("tokscale")), "bundled"));
        out.push((
            dir.join(exe_name(&format!("tokscale-{TARGET_TRIPLE}"))),
            "bundled",
        ));
    }
    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(exe_name(&format!("tokscale-{TARGET_TRIPLE}")));
        out.push((dev, "dev"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            out.push((dir.join(exe_name("tokscale")), "path"));
        }
    }
    out
}

pub fn locate() -> AppResult<TokscaleBinary> {
    let all = candidates();
    for (path, source) in &all {
        if path.is_file() {
            return Ok(TokscaleBinary {
                path: path.clone(),
                source,
            });
        }
    }
    Err(AppError::TokscaleMissing(
        all.iter()
            .filter(|(_, s)| *s != "path")
            .map(|(p, _)| p.display().to_string())
            .collect(),
    ))
}
