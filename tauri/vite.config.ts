import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 版本號單一事實來源是 src-tauri/tauri.conf.json；build-installer.ps1 會把
// package.json / Cargo.toml 同步成同一個值，這裡讀 package.json 注入 __APP_VERSION__。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // src-tauri/target 裡 cargo 正在寫的檔案會讓 vite 的 watcher 丟 EBUSY 而整個結束（Tauri 範本同樣忽略）。
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // React 核心獨立一包：快取穩定（App 改版時 vendor chunk hash 不變）。
          if (/[\/]node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return "react-vendor";
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
});
