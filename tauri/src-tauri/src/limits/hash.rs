//! 帳號與專案的不透明身分（上游 src/shared/hashKey.js）。
//!
//! `hash_key(parts) = "sha256:" + hex(sha256(part₁ + "\0" + part₂ + "\0" + …))`。
//! 必須與上游逐位元相同：hub 靠它把 Electron 裝置與 Tauri 裝置上的同一個帳號／專案視為同一個。

use sha2::{Digest, Sha256};

pub fn hash_key(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_crypto() {
        // node -e "const c=require('crypto');const h=c.createHash('sha256');h.update('project').update('\0').update('d:/projects/token-monitor').update('\0');console.log(h.digest('hex'))"
        assert_eq!(
            hash_key(&["project", "d:/projects/token-monitor"]),
            "sha256:64b804767d05f031c6cbd482b58cd0ad1bdc6cbdfcf845206440e6516e391ae4"
        );
    }
}
