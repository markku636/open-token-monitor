// widget 底部的更新提示（上游 appUpdatePill + popover）：有新版時「↑ v1.2.3」，下載中顯示百分比，
// 下載好了換成「v1.2.3 · ↻ 重新啟動」。點版本號打開版本說明；× 忽略這個版本（下載中與下載好的不能忽略）。

import { useState } from "react";
import { api, errorMessage, type UpdateState } from "./api";
import { lang, t } from "./i18n";
import { parseReleaseNotes, type NoteGroup } from "./releaseNotes";
import { useApp } from "./store";
import { updatePillVisible } from "./update";

/** 版本說明（設定頁與 widget 的 popover 共用）。 */
export function ReleaseNotes({ groups }: { groups: NoteGroup[] }) {
  return (
    <div className="space-y-2">
      {groups.map((g, i) => (
        <section key={`${g.title}-${i}`}>
          {g.title && <div className="text-2xs font-medium text-fg/70">{g.title}</div>}
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-2xs text-fg/60">
            {g.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function notesOf(u: UpdateState | null): NoteGroup[] {
  return u && (u.state === "available" || u.state === "ready") ? parseReleaseNotes(u.notes, lang()) : [];
}


export function UpdatePill() {
  const update = useApp((s) => s.update);
  // 忽略的版本記在設定（appUpdateDismissedVersion）：自動下載也會跳過它（上游 dismissedVersion）。
  const dismissed = useApp((s) => s.settings?.appUpdateDismissedVersion ?? "");
  const updateSettings = useApp((s) => s.updateSettings);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!updatePillVisible(update, dismissed)) return null;
  const ready = update.state === "ready";
  const downloading = update.state === "downloading";
  const groups = notesOf(update);
  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      if (ready) await api.updateInstall();
      else await api.updateDownload();
    } catch (e) {
      // 安裝失敗時 Rust 會把狀態改成 error、提示消失；把原因留在這裡讓使用者看得到。
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };
  const percent = downloading && update.total ? Math.floor((update.received / update.total) * 100) : null;
  const label = ready ? `v${update.version}` : percent !== null ? `${percent}%` : `↑ v${update.version}`;
  return (
    <div className="relative mx-3 mb-1">
      {open && groups.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 z-10 mb-1 rounded-sm border border-fg/10 bg-elevated p-2 shadow-lg">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium">{t("v{version} 更新內容", { version: update.version })}</span>
            <button type="button" className="text-2xs text-fg/45 hover:text-fg" onClick={() => setOpen(false)}>
              {t("收起")}
            </button>
          </div>
          <div className="scroll-thin max-h-48 overflow-y-auto">
            <ReleaseNotes groups={groups} />
          </div>
          {!downloading && (
            <button
              type="button"
              className="mt-2 w-full rounded-sm bg-accent px-2 py-1 text-2xs text-app disabled:opacity-40"
              disabled={busy}
              onClick={() => void act()}
            >
              {ready ? t("重新啟動以更新") : t("下載更新")}
            </button>
          )}
        </div>
      )}
      <div className={`flex items-center gap-2 rounded-sm px-2 py-1 text-2xs ${ready ? "bg-success/15" : "bg-accent/15"}`}>
        <button
          type="button"
          className="num min-w-0 flex-1 truncate text-left hover:underline disabled:no-underline"
          disabled={busy || (downloading && groups.length === 0)}
          title={groups.length ? t("v{version} 更新內容", { version: update.version }) : undefined}
          onClick={() => (groups.length ? setOpen(!open) : void act())}
        >
          {label}
        </button>
        {ready && (
          <button type="button" className="shrink-0 text-success hover:underline disabled:opacity-40" disabled={busy} onClick={() => void act()}>
            ↻ {t("重新啟動")}
          </button>
        )}
        {!ready && !downloading && !busy && (
          <button
            type="button"
            className="shrink-0 text-fg/40 hover:text-fg"
            title={t("忽略此版本")}
            onClick={() => void updateSettings({ appUpdateDismissedVersion: update.version })}
          >
            ×
          </button>
        )}
      </div>
      {error && <div className="mt-0.5 truncate text-2xs text-danger" title={error}>{error}</div>}
    </div>
  );
}
