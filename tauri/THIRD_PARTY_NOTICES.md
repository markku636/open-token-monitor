# Third-party notices

## Token Monitor（Javis603/token-monitor）

本專案的用量解析規則（`src-tauri/src/usage/`、`src-tauri/src/hub/payload.rs`、`src-tauri/src/device/`、`src-tauri/src/identity.rs`）移植自 token-monitor 的 JavaScript 原始碼；應用程式圖示（`brand/icon.png` 與 `src-tauri/icons/`）取自同一專案的 `assets/icon-win.png`。

```
MIT License

Copyright (c) 2026 Javis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 工具與模型廠商圖示

`src/assets/brand/*.svg` 逐字複製自 Javis603/token-monitor 的 `assets/icons/`（MIT，見上方授權全文）。圖示是各公司的商標，只用來標示用量來自哪個工具或模型，不代表與這些公司有關聯。

發佈前請人工確認：這些 SVG 的標記格式與 LobeHub 的 `@lobehub/icons`（MIT）靜態 SVG 相同，但上游沒有註明出處。如果確認出自 LobeHub，要在這裡另外附上它的 MIT 授權全文。

`src/assets/brand/project-row.svg` 複製自同一專案的 `src/electron/renderer/icons/views/project-row.svg`，衍生自 Lucide 的 `folder` 圖示：

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## tokscale

安裝檔隨附的掃描程式 tokscale（junhoyeo/tokscale，fork：Javis603/tokscale）以原本的授權散布；版本與 sha256 見 `scripts/vendor/tokscale.json`。
