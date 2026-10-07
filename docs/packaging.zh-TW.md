# hub 映像：打包、發行與部署

讀者：發行 hub 的維護者，以及部署 hub 的 IT。

本文件是 hub（伺服器端）的打包。公司版用戶端的打包見 [client-build.zh-TW.md](client-build.zh-TW.md)；手動設定上游官方版見 [client-setup.zh-TW.md](client-setup.zh-TW.md)。

## 一次發行

一次發行分成兩半：本機的 `npm run build:image`（[scripts/build-hub-image.js](../scripts/build-hub-image.js)）切出這一版、寫好文件，GitLab 的 tag pipeline（[.gitlab-ci.yml](../.gitlab-ci.yml)）建映像，最後由人按下部署。

本機，`npm run build:image`：

1. **檢查**：working tree 要乾淨；`upstream/` 要和當初拉進來時完全相同（`check:upstream`）；`npm run verify` 要通過。
2. **版本**：`<上游版本>-corp.<N>`，例如 `0.63.1-corp.1`。
   - `N` 取同一個上游版本已有的 `corp/v*` tag 的最大值加 1。推算前會先抓 `origin` 上的 tag，兩台機器才不會發出同一個版本號。
   - 上游版本換了，`N` 就從 1 開始。
3. **文件**：寫好後 commit，訊息是 `docs(release): corp/v<版本>`。
   - [CHANGELOG.md](../CHANGELOG.md) 的「未發行」改成 `## corp/v<版本>（日期）`，上面再開一個空的「未發行」。
   - 產生 `docs/releases/<版本>.md`，內容見下方「發行文件」。
4. **tag**：annotated tag `corp/v<版本>`，推到 `origin`。

GitLab，`corp/v<版本>` 的 pipeline：

5. **verify**：和 MR 一樣跑 `npm run verify`。
6. **build:hub**：在 hub 主機的 `hub-deploy` runner 上執行 `node scripts/build-hub-image.js --ci`。
   - **映像**：只用這個 tag 的檔案建置。用 `git archive` 取出，所以不會帶進沒有 commit 的東西，行尾一律是 LF。tag 是 `token-monitor-hub:<版本>`，`latest` 由部署時處理。label 記著版本、commit 與上游版本（見下方「產出」）。
   - **冒煙測試**：在一個臨時的 Docker network 裡起一個 `postgres:18-alpine` 與新映像。PostgreSQL 用本 repo 的初始化腳本建立帳號，hub 以自己的帳號 `token_monitor` 連線、套用 migration。`/api/health` 要回 200，`/api/custom/health` 的儲存要是 PostgreSQL，log 要有 `postgres store ready`。不論成功或失敗，容器、volume 與 network 都會刪掉。
   - **產出**：寫到 `dist/hub/<版本>/`，再上傳到 Package Registry 的 `token-monitor-hub/<版本>`，見下方「產出」。
7. **deploy:hub**：手動。按下去就把這一版部署到 hub 主機，見下方「部署」。

`corp/v<版本>` tag 就是那一版的原始碼，發行文件也在裡面。GitLab 不能用時，`npm run build:image -- --build` 在本機做第 6 步的建置、冒煙測試與產出，映像同時標成 `latest`。

## 需要什麼

- 本 repo 的 checkout，已經 `npm ci`。
- 推到 `origin` 的權限。`corp/v*` 要是 protected tag，tag 的 pipeline 才拿得到部署用的 runner 與變數（[hub.zh-TW.md](hub.zh-TW.md#從-gitlab-部署)「從 GitLab 部署」）。
- 只有試跑（`--no-tag`）與 `--build` 在本機建映像，這時才需要：
  - Docker：Docker Desktop 或 Linux 的 Docker Engine，要能拉 `node:22-alpine` 與 `postgres:18-alpine`。
  - `tar`：Windows 10 以上內建，Git Bash 的也可以。

## 發行前

1. **確認 CHANGELOG 已經寫好。** 平常每個功能 commit 都該在 CHANGELOG 的「未發行」加一行（[AGENTS.md](../AGENTS.md)）。「未發行」是空的時候，腳本會拒絕發行。
2. **上游有新版時，先更新 `upstream/`**：`npm run upstream:update -- vX.Y.Z`（[hub.zh-TW.md](hub.zh-TW.md#同步上游)「同步上游」）。版本號會跟著變成 `X.Y.Z-corp.1`，相容的用戶端也變成 vX.Y.Z，記得通知 IT。
3. **commit 所有改動。**

## 指令

```powershell
npm run build:image -- --dry-run    # 先看：印出這一版的文件與要跑的指令，什麼都不改
npm run build:image -- --no-tag     # 試跑：在本機建映像、冒煙測試、產出 dist/；不改 repo、不打 tag、不動 latest
npm run build:image                 # 發行：文件、tag；映像由 GitLab 的 build:hub 建
git push origin HEAD                # 發行文件的 commit 也推上去：腳本只推 tag
```

推上 tag 之後，到 GitLab 的 CI/CD → Pipelines 看 `corp/v<版本>` 那一條：`build:hub` 成功後按 `deploy:hub`。

| 旗標 | 作用 |
|---|---|
| `--dry-run` | 只印出這一版的文件，以及建置、測試、產出與 tag 的指令。不會 commit、建置，也不會打 tag。 |
| `--no-tag` | 試跑：在本機建映像。不改 CHANGELOG、不寫發行文件、不打 tag，映像只標 `:<版本>`，不動 `latest`。`dist/` 的 `RELEASE.md` 會註明是試跑。 |
| `--build` | 發行時也在本機建映像、冒煙測試、產出 `dist/`，映像標 `:<版本>` 與 `latest`。GitLab 不能用時用；tag 照樣推出去，`build:hub` 也照樣會建。 |
| `--ci` | `build:hub` 用的：建置 `CI_COMMIT_TAG` 那個 `corp/v*` tag，tag 必須就是 `HEAD`。文件從 tag 裡讀，不跑 verify（pipeline 的 verify 跑過了），不打 tag，映像只標 `:<版本>`。不能和 `--no-tag`、`--build`、`--dry-run` 一起用。 |
| `--no-push` | 打 tag 但不推。 |
| `--skip-verify` | 不跑 `npm run verify`，剛跑過時用。 |
| `--skip-smoke` | 不跑冒煙測試。 |
| `--no-save` | 不輸出映像檔的 tar，在打包的這台主機上部署時用。 |
| `--version X.Y.Z-corp.N` | 指定版本。`X.Y.Z` 必須是 `upstream/` 的版本，已經發行過的版本會被拒絕。 |
| `--image <名稱>` | 映像名稱，預設 `token-monitor-hub`。 |
| `--remote <名稱>` | 抓 tag、推 tag 的 remote，預設 `origin`。 |

## 發行文件

`docs/releases/<版本>.md` 在打包時產生，commit 在 repo 裡：

- **版本資訊**：版本與日期、commit、上游版本與上游的 commit、**相容的用戶端版本**（就是上游版本）、映像、上一版，以及有沒有新的 migration。
- **這一版的異動**：CHANGELOG「未發行」的內容。
- **自上一版以來的 commit**。
- **資料庫 migration**：全部的 migration，這一版新增的會標出來。
- **設定的變化**：和上一版相比，新增與移除的環境變數。從 `hub/`、`docker/` 與 `.env.example` 找出所有 `TOKEN_MONITOR_*` 與 `POSTGRES_*`。
- **從 GitLab 部署**：在這一版 tag 的 pipeline 按 `deploy:hub`。
- **部署**：不經過 GitLab 的手動做法。先備份，再從 Package Registry 下載、載入映像，`docker compose up`，最後確認。
- **回滾**：
  - 沒有新的 migration 時，換回上一版的映像即可。
  - 有新的 migration 時，要先用部署前的備份還原資料庫，因為 migration 只會往前。
- **風險檢查**：
  - 用戶端比伺服器新。
  - 外部更新被汙染。
  - 資料庫備份。
  - 金鑰。

## 產出

`build:hub` 寫到 `dist/hub/<版本>/`，再上傳到 GitLab 的 Deploy → Package Registry 的 `token-monitor-hub/<版本>`。`RELEASE.md` 與 `SHA256SUMS` 也留在 job 的 artifacts。本機的試跑與 `--build` 只寫到本機的 `dist/hub/<版本>/`。

| 檔案 | 內容 |
|---|---|
| `token-monitor-hub-<版本>.tar` | `docker save` 的映像。 |
| `RELEASE.md` | 發行文件，加上這次打包的映像 ID、commit 與 tar 的 SHA-256。 |
| `SHA256SUMS` | tar 與 `RELEASE.md` 的 SHA-256，`sha256sum -c` 的格式。 |

映像的 label：

```powershell
docker inspect --format '{{json .Config.Labels}}' token-monitor-hub:latest
```

| label | 值 |
|---|---|
| `org.opencontainers.image.version` | `<版本>` |
| `org.opencontainers.image.revision` | 建置的 commit |
| `org.opencontainers.image.created` | 建置時間 |
| `org.opencontainers.image.source` | GitLab 專案的網址；本機建置時是 `--remote` 的網址，去掉其中的帳密 |
| `io.token-monitor.upstream.version` | 上游版本，也就是相容的用戶端版本 |
| `io.token-monitor.upstream.commit` | 上游的 commit |

## 中途失敗

- **寫文件之前失敗**，例如 verify：repo 沒有任何改動，修好之後再跑。
- **文件 commit 之後、打 tag 之前失敗**，例如 `--build` 時 Docker 沒開、冒煙測試失敗：那個 commit 還只在本機。
  - 問題不在程式時，直接再跑一次同一個指令。腳本看到 `docs/releases/<版本>.md` 與 CHANGELOG 的 `corp/v<版本>` 段落都已經在，就沿用它們，不會再寫一次。
  - 要改程式時，先用 `git reset --hard HEAD~1` 撤掉發行文件的 commit，修好、commit 之後再跑。
- **冒煙測試失敗**：錯誤訊息附有容器的 log。`tmp/hub-image/<版本>/` 會留著，方便檢查建置用的檔案。
- **tag 推不上去**：tag 已經打在本機，照提示執行 `git push origin corp/v<版本>`。
- **`build:hub` 失敗**：job 的 log 有錯誤訊息與容器的 log。
  - 問題不在程式時，例如 runner 或網路，重跑 `build:hub`。
  - 要改程式時，那個版本號已經推出去了，不要移動它的 tag：修好、在「未發行」記一行，再發行下一版。
- **tag 的 pipeline 一直卡在 pending**：`corp/v*` 還不是 protected tag，Protected 的 `hub-deploy` runner 不接它的 job。

## 部署

**從 GitLab**：在 `corp/v<版本>` 的 pipeline 按 `deploy:hub`（[hub.zh-TW.md](hub.zh-TW.md#從-gitlab-部署)「從 GitLab 部署」）。

- 它在 hub 主機上備份資料庫、換上 `.env`、把原本的 `latest` 留成 `:previous`、`docker compose up -d`，再等 `/api/health`。
- 主機上沒有那個映像時，例如清掉了，或是重新部署舊版，就從 Package Registry 下載、核對 SHA-256 後載入。
- 回滾：在 Operate → Environments → `hub/production` 對上一版的部署按 re-deploy。有新 migration 的版本要先還原備份，見該版 `RELEASE.md` 的「回滾」。

**手動**：第一次部署（`.env`、資料庫密碼）見 [docker.md](docker.md)。之後每一版照該版 `RELEASE.md` 的「部署」做，大致是：

1. 備份資料庫。
2. 部署的主機上要有這一版的 `docker/`：`git checkout corp/v<版本>`。
3. 從 Package Registry 的 `token-monitor-hub/<版本>` 下載這一版的三個檔案：映像檔、`RELEASE.md` 與 `SHA256SUMS`。先核對並載入映像，再標成 `latest`：

   ```bash
   sha256sum -c SHA256SUMS                 # PowerShell：Get-FileHash <檔案>，和 SHA256SUMS 比對
   docker load -i token-monitor-hub-<版本>.tar
   docker tag token-monitor-hub:<版本> token-monitor-hub:latest
   ```

4. `docker compose -f docker/compose.yml --env-file .env up -d`。

用 `--build` 在本機打包時，這台主機的映像已經標好 `latest`，直接做第 4 步。

## 開發時建映像

```powershell
docker build -f docker/Dockerfile -t token-monitor-hub .
```

這會用 working tree 建置，包括還沒 commit 的改動，只適合開發時試用。發行一律用 `npm run build:image`。
