# Third-party notices

## Token Monitor (Javis603/token-monitor)

`upstream/` is an unmodified copy of [Javis603/token-monitor](https://github.com/Javis603/token-monitor), including its own [LICENSE](upstream/LICENSE). The hub overlay (`hub/`) and the client packaging (`client/`, `packaging/`) load and wrap that code. The Rust client ports parts of it and uses its icon; see [tauri/THIRD_PARTY_NOTICES.md](tauri/THIRD_PARTY_NOTICES.md).

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

## tokscale

The installers bundle the tokscale scanner (junhoyeo/tokscale, fork: Javis603/tokscale) under its own license. Upstream pins its version and sha256 in `upstream/scripts/vendor/tokscale.json`, and the Rust client keeps a copy in `tauri/scripts/vendor/tokscale.json`.
