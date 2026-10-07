// 設定視窗（另一個有邊框的 Tauri 視窗，?view=settings）。

import { useEffect, useState } from "react";
import {
  api,
  errorMessage,
  onCopilotLogin,
  type AppStatus,
  type Diagnostics,
  type LocalStats,
  type SettingsView,
  type SyncReport,
  type ThemeSetting,
  type WindowMode,
} from "./api";
import type { LangSetting } from "./i18n";
import { clientLabel } from "./clients";
import { fmtTime } from "./format";
import { useApp } from "./store";
import { t } from "./i18n";
import { Button, Field, Section, Segmented, Select, Toggle } from "./ui";
import { updateStatusText } from "./update";
import { providerName } from "./limits";
import { DisplaySection } from "./SettingsDisplay";
import { ExportSection } from "./SettingsExport";
import { notesOf, ReleaseNotes } from "./UpdatePill";
import { formatShortcut, shortcutFromEvent } from "./shortcut";
import { normalizeOwnerEmail } from "./ownerEmail";

const SOURCE_LABEL: Record<string, string> = {
  baked: t("內建"),
  settings: t("覆寫"),
  keyring: t("覆寫"),
  env: t("環境變數"),
  cli: t("命令列"),
  none: t("未設定"),
};

// 公司 hub 用這個信箱把裝置歸到員工，dashboard 才分得出公司、部門與團隊。
function OwnerEmailField({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const [value, setValue] = useState(s.ownerEmail);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const email = normalizeOwnerEmail(value);
  const invalid = value.trim() !== "" && !email;
  const unchanged = email === s.ownerEmail && !invalid;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await updateSettings({ ownerEmail: email });
      setValue(email);
      setMessage(email ? t("已儲存，下次上傳會帶上") : t("已清除"));
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Field label={t("公司信箱")} hint={t("hub 用它把這台電腦歸到你的公司與部門")}>
        <input
          className="w-[210px] rounded-sm border border-fg/15 bg-inset px-2 py-1 text-xs"
          type="email"
          placeholder="name@company.com"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setMessage(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !invalid && !unchanged) void save();
          }}
        />
        <Button variant="primary" disabled={busy || invalid || unchanged} onClick={() => void save()}>
          {t("儲存")}
        </Button>
      </Field>
      {invalid && <p className="text-xs text-danger">{t("這不像是 email 地址")}</p>}
      {message && <p className="text-xs text-fg/70">{message}</p>}
    </div>
  );
}

function HubSection({ s }: { s: SettingsView }) {
  const applySettings = useApp((x) => x.applySettings);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(s.hubUrl);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (o: { url?: string | null; secret?: string | null }, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      applySettings(await api.hubSetOverride(o));
      setSecret("");
      setMessage(done);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("公司 hub")}>
      <Field label={t("位置")} hint={SOURCE_LABEL[s.hub.urlSource]}>
        <span className="max-w-[260px] truncate font-mono text-xs text-fg/70">{s.hub.url ?? "—"}</span>
      </Field>
      <Field label={t("連線金鑰")} hint={SOURCE_LABEL[s.hub.secretSource]}>
        <span className="font-mono text-xs text-fg/70">{s.hub.secretMasked ?? "—"}</span>
      </Field>
      <OwnerEmailField s={s} />
      <div className="py-2.5">
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setOpen(!open)}>
          {open ? t("收起") : t("覆寫位置或金鑰（金鑰輪替時使用）")}
        </button>
        {open && (
          <div className="mt-2 space-y-2">
            <input
              className="w-full rounded-sm border border-fg/15 bg-inset px-2 py-1 font-mono text-xs"
              placeholder={s.hub.bakedUrl ?? "https://…"}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <input
              className="w-full rounded-sm border border-fg/15 bg-inset px-2 py-1 font-mono text-xs"
              type="password"
              placeholder={t("新的 client secret（留空則不變）")}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void run({ url, secret: secret || null }, t("已套用，重新連線中"))}
              >
                {t("套用")}
              </Button>
              <Button disabled={busy} onClick={() => void run({ url: "", secret: "" }, t("已還原內建值"))}>
                {t("還原內建值")}
              </Button>
            </div>
            <p className="text-xs text-fg/45">
              {t("金鑰存在 Windows 認證管理員，不寫入設定檔。只有 hub 更換金鑰、而這台還沒裝新版時才需要。")}
            </p>
          </div>
        )}
        {message && <p className="mt-2 text-xs text-fg/70">{message}</p>}
      </div>
    </Section>
  );
}

function UpdateSection({ s }: { s: SettingsView }) {
  const update = useApp((x) => x.update);
  const updateSettings = useApp((x) => x.updateSettings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const disabled = !update || update.state === "disabled";
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await task();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const notes = notesOf(update);
  const inFlight = update?.state === "checking" || update?.state === "downloading" || update?.state === "installing";
  let action = (
    <Button disabled={busy || inFlight} onClick={() => void run(api.updateCheck)}>
      {t("立即檢查")}
    </Button>
  );
  if (update?.state === "ready") {
    action = (
      <Button variant="primary" disabled={busy} onClick={() => void run(api.updateInstall)}>
        {t("重新啟動以更新")}
      </Button>
    );
  } else if (update?.state === "available") {
    action = (
      <Button variant="primary" disabled={busy} onClick={() => void run(api.updateDownload)}>
        {t("下載 v{v}", { v: update.version })}
      </Button>
    );
  }
  return (
    <Section title={t("更新")}>
      <Field label={t("目前版本")}>
        <span className="font-mono text-xs text-fg/70">v{s.appVersion}</span>
      </Field>
      <Field label={t("自動下載更新")} hint={t("下載好後仍要按「重新啟動以更新」才會安裝")}>
        <Toggle
          checked={s.automaticAppUpdates}
          onChange={(v) => void updateSettings({ automaticAppUpdates: v })}
        />
      </Field>
      <div className="space-y-2 py-2.5">
        <p className="text-xs text-fg/70">{updateStatusText(update)}</p>
        {notes.length > 0 && update && "version" in update && (
          <details className="rounded-sm bg-inset px-2 py-1.5" open>
            <summary className="cursor-pointer text-xs">{t("v{version} 更新內容", { version: update.version })}</summary>
            <div className="mt-1.5">
              <ReleaseNotes groups={notes} />
            </div>
          </details>
        )}
        {!disabled && <div className="flex gap-2">{action}</div>}
        {message && <p className="text-xs text-danger">{message}</p>}
      </div>
    </Section>
  );
}

function DiagnosticsSection() {
  const [d, setD] = useState<Diagnostics | null>(null);
  useEffect(() => {
    void api.appDiagnostics().then(setD);
  }, []);
  const text = d ? JSON.stringify(d, null, 2) : "";
  return (
    <Section title={t("診斷")}>
      <div className="space-y-2 py-2.5">
        <pre className="scroll-thin max-h-48 overflow-auto rounded-sm bg-inset p-2 font-mono text-2xs text-fg/70">{text}</pre>
        <div className="flex gap-2">
          <Button onClick={() => void navigator.clipboard?.writeText(text)}>{t("複製")}</Button>
          <Button onClick={() => void api.appOpenLogDir()}>{t("開啟日誌資料夾")}</Button>
        </div>
      </div>
    </Section>
  );
}

// 每個工具旁的狀態說明：偵測結果，以及 Cursor / Antigravity 最近一次同步。
const DETECTED_LABEL: Record<string, string> = {
  active: t("有用量"),
  waiting: t("已安裝，尚無用量"),
  missing: t("本機沒有資料"),
};

function syncNote(sync: SyncReport, base: string): string {
  switch (sync.state) {
    case "synced":
      return sync.client === "cursor"
        ? t("已同步 {n} 筆 · {t}", { n: sync.rows ?? 0, t: fmtTime(sync.at) })
        : t("已同步 IDE 用量 · {t}", { t: fmtTime(sync.at) });
    case "notSignedIn":
      return t("未登入 Cursor（請先登入 Cursor 桌面版）");
    case "noData":
      return base || t("沒有 IDE 資料（CLI 仍會統計）");
    case "failed":
      return t("同步失敗：{e}", { e: sync.message ?? "" });
  }
}

// 即時更新的說明：監看中的目錄數，或為什麼只能靠定時掃描。
function watchNote(s: SettingsView, appStatus: AppStatus | null): string {
  if (!s.watchEnabled) return t("關閉時只依「定時掃描間隔」更新");
  if (appStatus?.watchError) return t("無法監看：{e}（改為定時掃描）", { e: appStatus.watchError });
  if (appStatus?.watching) {
    const n = appStatus.watchRoots.length;
    if (appStatus.watchMode === "polling") {
      return appStatus.watchFallbackCode
        ? t("系統的檔案監看額度已用完（{code}），改為每 2 秒檢查 {n} 個資料夾", {
            code: appStatus.watchFallbackCode,
            n,
          })
        : t("每 2 秒檢查 {n} 個資料夾，有變動時幾秒內更新", { n });
    }
    return t("監看 {n} 個資料夾，有變動時幾秒內更新", { n });
  }
  return t("工具的紀錄有變動時幾秒內更新");
}

// history 的說明：最近一次掃描的結果。
function historyNote(s: SettingsView, appStatus: AppStatus | null): string {
  if (!s.historyEnabled) return t("關閉後 hub 的熱力圖與日報表不會有這台電腦");
  if (appStatus?.historyError) return t("上次掃描失敗：{e}", { e: appStatus.historyError });
  if (appStatus?.lastHistoryAt) {
    return t("{n} 天 · 掃描於 {t}", { n: appStatus.historyDays, t: fmtTime(appStatus.lastHistoryAt) });
  }
  return t("上傳每天的用量，給 hub 的熱力圖與日報表");
}

const SHORTCUT_STATE: Record<string, string> = {
  registered: t("已啟用"),
  unregistered: t("無法註冊，可能被其他程式占用"),
};

// 全域快捷鍵：按「錄製」後直接按組合鍵；Esc 取消、Backspace 清除（上游的錄製器）。
function ShortcutField({ s, appStatus }: { s: SettingsView; appStatus: AppStatus | null }) {
  const { updateSettings } = useApp();
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      const r = shortcutFromEvent(e);
      if (r.action === "invalid") {
        setProblem(r.reason === "modifierRequired" ? t("要搭配 Ctrl、Alt 或 Win 鍵") : t("不支援這個按鍵"));
        return;
      }
      setRecording(false);
      setProblem(null);
      if (r.action !== "cancel") void updateSettings({ windowToggleShortcut: r.shortcut });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, updateSettings]);
  const hint = recording
    ? problem ?? t("按下新的組合鍵；Esc 取消、Backspace 清除")
    : s.windowToggleShortcut
      ? SHORTCUT_STATE[appStatus?.windowShortcut ?? ""] ?? ""
      : t("在任何地方按下組合鍵就能顯示或隱藏 widget");
  return (
    <Field label={t("顯示／隱藏快捷鍵")} hint={hint}>
      <div className="flex items-center gap-2">
        <span className="num text-sm">{recording ? "…" : formatShortcut(s.windowToggleShortcut, t("關閉"))}</span>
        <Button onClick={() => { setProblem(null); setRecording(!recording); }}>{recording ? t("取消") : t("錄製")}</Button>
        {s.windowToggleShortcut && !recording && (
          <Button onClick={() => void updateSettings({ windowToggleShortcut: "" })}>{t("清除")}</Button>
        )}
      </div>
    </Field>
  );
}

// Cursor 的手動 token：桌面版登入時會自動讀取，只用 CLI 的人才需要貼。token 送進 Rust 後就不回傳。
function CursorTokenField() {
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.cursorSetToken(value);
      setValue("");
      setNote(t("已儲存，正在重新查詢"));
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field
      label={t("Cursor token")}
      hint={note ?? t("Cursor 桌面版登入時會自動讀取；只用 Cursor CLI 的人，貼上 cursor.com 的 WorkosCursorSessionToken")}
    >
      <div className="flex items-center gap-2">
        <input
          type="password"
          className="w-44 rounded-sm border border-fg/15 bg-transparent px-2 py-1 text-xs"
          value={value}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
        />
        <Button disabled={busy || !value.trim()} onClick={() => void save()}>
          {t("儲存")}
        </Button>
      </div>
    </Field>
  );
}

// GitHub Copilot 的登入：device flow，在 github.com 輸入代碼。token 只存在 Rust 端的認證管理員。
function CopilotLoginField() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void api.copilotSignedIn().then((v) => setSignedIn(Boolean(v)));
    let unlisten: (() => void) | undefined;
    void onCopilotLogin((e) => {
      setCode(null);
      if (e.state === "done") {
        setSignedIn(true);
        setNote(t("已登入，正在查詢額度"));
      } else {
        setNote(e.message === "expired" ? t("代碼已過期，請重新登入") : e.message === "denied" ? t("已取消授權") : e.message);
      }
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);
  const start = async () => {
    setNote(null);
    try {
      const c = await api.copilotLoginStart();
      setCode(c.userCode);
    } catch (e) {
      setNote(errorMessage(e));
    }
  };
  const logout = async () => {
    await api.copilotLogout();
    setSignedIn(false);
    setNote(null);
  };
  const hint = code
    ? t("在剛開啟的 GitHub 頁面輸入代碼 {code}", { code })
    : note ?? (signedIn ? t("已登入 GitHub") : t("以 GitHub 帳號登入，查詢 Copilot 的 Premium 與 Chat 額度"));
  return (
    <Field label={t("GitHub Copilot")} hint={hint}>
      <div className="flex items-center gap-2">
        {code && <span className="num rounded-sm bg-inset px-2 py-1 text-sm font-semibold tracking-widest">{code}</span>}
        {signedIn ? (
          <Button onClick={() => void logout()}>{t("登出")}</Button>
        ) : (
          <Button disabled={Boolean(code)} onClick={() => void start()}>
            {t("登入")}
          </Button>
        )}
      </div>
    </Field>
  );
}

function toolNote(id: string, local: LocalStats | null, appStatus: AppStatus | null): string {
  const base = DETECTED_LABEL[local?.clientStatus[id] ?? ""] ?? "";
  const sync = appStatus?.selfSync?.[id];
  return sync ? syncNote(sync, base) : base;
}

export default function Settings() {
  const { settings: s, updateSettings, error, local, status: appStatus } = useApp();
  if (!s) return <div className="p-6 text-sm text-fg/50">{t("載入中…")}</div>;
  const toggleClient = (id: string, on: boolean) => {
    const next = on ? [...s.trackedClients, id] : s.trackedClients.filter((c) => c !== id);
    void updateSettings({ trackedClients: s.supportedClients.filter((c) => next.includes(c)) });
  };
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[620px] space-y-3 p-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">{t("設定")}</h1>
          <span className="text-xs text-fg/45">
            v{s.appVersion} · {s.buildChannel === "corp" ? t("公司版") : t("開發版")} · {s.deviceId}
          </span>
        </div>
        {error && <div className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

        <Section title={t("一般")}>
          <Field label={t("開機時自動啟動")}>
            <Toggle checked={s.autostart} onChange={(v) => void updateSettings({ autostart: v })} />
          </Field>
          <Field label={t("視窗模式")} hint={t("桌面模式固定在最底層，不能拖曳")}>
            <Segmented<WindowMode>
              value={s.windowMode}
              options={[
                { value: "floating", label: t("浮動") },
                { value: "normal", label: t("標準") },
                { value: "desktop", label: t("桌面") },
                { value: "tray", label: t("系統匣") },
              ]}
              onChange={(v) => void updateSettings({ windowMode: v })}
            />
          </Field>
          {s.windowMode === "floating" && (
            <Field
              label={t("保持在工作列上方（實驗性）")}
              hint={t("Widget 與工作列重疊時，會在 Windows 切換 app 後嘗試重新移到上層；某些切換過程可能會短暫閃爍。")}
            >
              <Toggle checked={s.keepAboveTaskbar} onChange={(v) => void updateSettings({ keepAboveTaskbar: v })} />
            </Field>
          )}
          {s.windowMode === "floating" && (
            <Field label={t("收合成浮動泡泡")} hint={t("widget 失去焦點時縮到螢幕邊緣，顯示今日 token；按一下展開，按 Esc 立刻收合")}>
              <Toggle
                checked={s.floatingBubbleEnabled}
                onChange={(v) => void updateSettings({ floatingBubbleEnabled: v })}
              />
            </Field>
          )}
          <Field label={t("邊緣額度條")} hint={t("螢幕邊緣的細條，游標碰到就展開各工具的額度；點圓環開啟額度分頁")}>
            <Toggle checked={s.edgeDockEnabled} onChange={(v) => void updateSettings({ edgeDockEnabled: v })} />
          </Field>
          {s.edgeDockEnabled && (
            <Field label={t("額度條位置")} hint={t("高度 {n}%", { n: Math.round(s.edgeDockOffset * 100) })}>
              <div className="flex items-center gap-2">
                <Segmented<"left" | "right">
                  value={s.edgeDockSide}
                  options={[
                    { value: "left", label: t("左") },
                    { value: "right", label: t("右") },
                  ]}
                  onChange={(v) => void updateSettings({ edgeDockSide: v })}
                />
                <input
                  type="range"
                  min={10}
                  max={90}
                  step={5}
                  value={Math.round(s.edgeDockOffset * 100)}
                  onChange={(e) => void updateSettings({ edgeDockOffset: Number(e.target.value) / 100 })}
                />
              </div>
            </Field>
          )}
          <Field label={t("主題")}>
            <Segmented<ThemeSetting>
              value={s.theme}
              options={[
                { value: "system", label: t("跟隨系統") },
                { value: "dark", label: t("深色") },
                { value: "light", label: t("淺色") },
              ]}
              onChange={(v) => void updateSettings({ theme: v })}
            />
          </Field>
          <Field label={t("語言")}>
            <Segmented<LangSetting>
              value={s.language}
              options={[
                { value: "auto", label: t("自動") },
                { value: "zh-TW", label: "繁體中文" },
                { value: "en", label: "English" },
              ]}
              onChange={(v) => void updateSettings({ language: v })}
            />
          </Field>
          <Field label={t("系統匣圖示")} hint={s.trayContent === "barsSessions" ? t("上面 Claude Code、下面 Codex 的 5 小時已用比例") : t("額度長條：最接近上限的工具，上面 5 小時、下面每週的已用比例")}>
            <Segmented<"icon" | "bars" | "barsSessions">
              value={s.trayContent}
              options={[
                { value: "icon", label: t("圖示") },
                { value: "bars", label: t("額度長條") },
                { value: "barsSessions", label: t("各工具 5 小時") },
              ]}
              onChange={(v) => void updateSettings({ trayContent: v })}
            />
          </Field>
          <Field label={t("玻璃效果")} hint={t("widget 背後的 Windows acrylic 模糊；降低不透明度才看得清楚")}>
            <Toggle checked={s.systemGlass} onChange={(v) => void updateSettings({ systemGlass: v })} />
          </Field>
          <Field label={t("縮放")} hint={t("{n}% · widget 上也可以按 Ctrl + = / - / 0", { n: Math.round(s.zoomFactor * 100) })}>
            <input
              type="range"
              min={70}
              max={160}
              step={10}
              value={Math.round(s.zoomFactor * 100)}
              onChange={(e) => void updateSettings({ zoomFactor: Number(e.target.value) / 100 })}
            />
          </Field>
          <ShortcutField s={s} appStatus={appStatus} />
          <Field label={t("不透明度")} hint={`${s.opacity}%`}>
            <input
              type="range"
              min={40}
              max={100}
              value={s.opacity}
              onChange={(e) => void updateSettings({ opacity: Number(e.target.value) })}
            />
          </Field>
        </Section>

        <DisplaySection s={s} />
        <ExportSection s={s} />

        <Section title={t("收集與上傳")}>
          <Field label={t("上傳間隔")} hint={t("大量裝置同時上線時，預設 10 分鐘上傳一次；本機數字仍即時更新")}>
            <Select<number>
              value={s.syncUploadIntervalMs}
              options={[
                { value: 0, label: t("即時") },
                { value: 600_000, label: t("10 分鐘") },
                { value: 1_200_000, label: t("20 分鐘") },
                { value: 1_800_000, label: t("30 分鐘") },
              ]}
              onChange={(v) => void updateSettings({ syncUploadIntervalMs: v })}
            />
          </Field>
          <Field label={t("定時掃描間隔")} hint={t("同時同步 Cursor 與 Antigravity；每小時另外完整重掃一次")}>
            <Select<number>
              value={s.collectionIntervalMs}
              options={[
                { value: 60_000, label: t("1 分鐘") },
                { value: 300_000, label: t("5 分鐘") },
                { value: 900_000, label: t("15 分鐘") },
                { value: 1_800_000, label: t("30 分鐘") },
              ]}
              onChange={(v) => void updateSettings({ collectionIntervalMs: v })}
            />
          </Field>
          <Field label={t("即時更新")} hint={watchNote(s, appStatus)}>
            <Toggle checked={s.watchEnabled} onChange={(v) => void updateSettings({ watchEnabled: v })} />
          </Field>
          <Field
            label={t("保留已刪除的 session")}
            hint={t("Claude Code 預設 30 天後刪掉舊紀錄；開啟時那些用量仍算進本月與全部（只存在這台電腦）")}
          >
            <Toggle
              checked={s.sessionUsageArchiveEnabled}
              onChange={(v) => void updateSettings({ sessionUsageArchiveEnabled: v })}
            />
          </Field>
          <Field label={t("每日歷史")} hint={historyNote(s, appStatus)}>
            <Toggle checked={s.historyEnabled} onChange={(v) => void updateSettings({ historyEnabled: v })} />
          </Field>
          {s.historyEnabled && (
            <Field label={t("歷史掃描間隔")} hint={t("換日與手動重掃時不等間隔")}>
              <Select<number>
                value={s.historyIntervalMs}
                options={[
                  { value: 300_000, label: t("5 分鐘") },
                  { value: 600_000, label: t("10 分鐘") },
                  { value: 900_000, label: t("15 分鐘") },
                  { value: 1_800_000, label: t("30 分鐘") },
                  { value: 3_600_000, label: t("1 小時") },
                ]}
                onChange={(v) => void updateSettings({ historyIntervalMs: v })}
              />
            </Field>
          )}
          <Field label={t("專案（資料夾）統計")} hint={t("關閉後不會上傳專案資料夾名稱")}>
            <Toggle checked={s.projectsEnabled} onChange={(v) => void updateSettings({ projectsEnabled: v })} />
          </Field>
          <div className="py-2.5">
            <div className="text-sm">{t("追蹤的工具")}</div>
            <ul className="mt-2 space-y-1.5">
              {s.supportedClients.map((id) => (
                <li key={id} className="flex items-baseline justify-between gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={s.trackedClients.includes(id)}
                      onChange={(e) => toggleClient(id, e.target.checked)}
                    />
                    <span>{clientLabel(id)}</span>
                  </label>
                  <span className="truncate text-fg/45" title={toolNote(id, local, appStatus)}>
                    {s.trackedClients.includes(id) ? toolNote(id, local, appStatus) : t("不追蹤")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section title={t("額度")}>
          <Field label={t("顯示並上傳額度")} hint={t("讀取這台電腦上 Claude Code、Codex、Cursor 與 GitHub Copilot 的登入，查詢用量上限；不會上傳任何 token")}>
            <Toggle checked={s.limitsEnabled} onChange={(v) => void updateSettings({ limitsEnabled: v })} />
          </Field>
          {s.limitsEnabled && (
            <>
              <Field label={t("查詢間隔")}>
                <Select<number>
                  value={s.limitsRefreshMs}
                  options={[
                    { value: 60_000, label: t("1 分鐘") },
                    { value: 120_000, label: t("2 分鐘") },
                    { value: 300_000, label: t("5 分鐘") },
                    { value: 900_000, label: t("15 分鐘") },
                    { value: 1_800_000, label: t("30 分鐘") },
                  ]}
                  onChange={(v) => void updateSettings({ limitsRefreshMs: v })}
                />
              </Field>
              {s.limitProviders.includes("cursor") && <CursorTokenField />}
              {s.limitProviders.includes("copilot") && <CopilotLoginField />}
              <div className="flex gap-4 py-2.5 text-xs">
                {(["claude", "codex", "cursor", "copilot"] as const).map((id) => (
                  <label key={id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={s.limitProviders.includes(id)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...s.limitProviders, id]
                          : s.limitProviders.filter((p) => p !== id);
                        void updateSettings({ limitProviders: ["claude", "codex", "cursor", "copilot"].filter((p) => next.includes(p)) });
                      }}
                    />
                    <span>{providerName(id)}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </Section>

        <HubSection s={s} />
        <UpdateSection s={s} />
        <DiagnosticsSection />
        <p className="px-1 pb-2 text-xs text-fg/40">
          {t("金額是依各家 API 牌價換算的等值成本，不是實際帳單；使用訂閱方案的人實際付的是月費。")}
        </p>
      </div>
    </div>
  );
}
