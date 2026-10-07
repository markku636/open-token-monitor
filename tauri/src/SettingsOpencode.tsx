// 設定頁的 OpenCode 額度（上游 Settings → OpenCode Account 的單帳號版）：
// - Go 的額度預設讀 OpenCode 自己存在 auth.json 的 key（自動偵測，可以關掉）。
// - 也可以貼 Go 的 API key，或 opencode.ai 的登入 cookie（Zen 的預付餘額只有 cookie 拿得到）。
// 憑證送進 Rust 後只存在 OS 認證管理員，這裡只看得到「有沒有存」（src-tauri/src/limits/opencode/mod.rs）。

import { useEffect, useState } from "react";
import {
  api,
  errorMessage,
  type OpencodeCredentialKind,
  type OpencodeSaveCheck,
  type OpencodeStatus,
  type SettingsView,
} from "./api";
import { t } from "./i18n";
import { useApp } from "./store";
import { Button, Field, Toggle } from "./ui";

function saveNote(r: OpencodeSaveCheck): string {
  const notes: Record<OpencodeSaveCheck, string> = {
    saved: t("已儲存，正在重新查詢"),
    empty: t("請先貼上內容"),
    rejected: t("OpenCode 拒絕了這組憑證（可能已過期）"),
    noSubscription: t("這個帳號沒有 OpenCode Go 訂閱"),
    unreachable: t("連不上 OpenCode 的用量 API，請稍後再試"),
  };
  return notes[r];
}

function ambientHint(s: SettingsView, status: OpencodeStatus | null): string {
  if (!status) return "";
  if (!status.ambientDetected) return t("這台電腦沒有 OpenCode 存的 Go key");
  if (status.ambientClaimed) return t("偵測到的 key 與這裡存的 API key 相同");
  if (!s.opencodeAmbientEnabled) return t("偵測到 OpenCode 存的 Go key，但不回報它的額度");
  return t("讀取 OpenCode 自己存的 Go key，不必另外設定");
}

function CredentialField({
  kind,
  status,
  onChange,
}: {
  kind: OpencodeCredentialKind;
  status: OpencodeStatus | null;
  onChange: () => void;
}) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = kind === "api" ? status?.apiKey : status?.cookie;
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.opencodeSaveCredential(kind, value);
      if (r === "saved") {
        setValue("");
        onChange();
      }
      setNote(saveNote(r));
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      await api.opencodeClearCredential(kind);
      setNote(t("已刪除"));
      onChange();
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  let idle = t("OpenCode Go 的 API key：查詢 Go 的額度");
  if (kind === "cookie") {
    idle = status?.envCookie
      ? t("正在使用環境變數 TOKEN_MONITOR_OPENCODE_COOKIE；貼上的 cookie 優先")
      : t("opencode.ai 登入後的 auth cookie：Go 的額度與 Zen 的餘額");
  }
  const hint = note ?? (stored ? t("已儲存") : idle);
  return (
    <Field label={kind === "api" ? t("OpenCode API key") : t("OpenCode cookie")} hint={hint}>
      <input
        type="password"
        className="w-40 rounded-sm border border-fg/15 bg-transparent px-2 py-1 text-xs"
        value={value}
        placeholder={kind === "api" ? "sk-..." : "auth=..."}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
      />
      <Button disabled={busy || !value.trim()} onClick={() => void save()}>
        {t("儲存")}
      </Button>
      {stored && (
        <Button disabled={busy} onClick={() => void clear()}>
          {t("刪除")}
        </Button>
      )}
    </Field>
  );
}

export function OpencodeFields({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const [status, setStatus] = useState<OpencodeStatus | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    void api
      .opencodeStatus()
      .then((v) => {
        if (alive) setStatus(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version, s.opencodeAmbientEnabled]);
  const reload = () => setVersion((n) => n + 1);
  return (
    <>
      <Field label={t("OpenCode 自動偵測")} hint={ambientHint(s, status)}>
        <Toggle checked={s.opencodeAmbientEnabled} onChange={(v) => void updateSettings({ opencodeAmbientEnabled: v })} />
      </Field>
      <CredentialField kind="api" status={status} onChange={reload} />
      <CredentialField kind="cookie" status={status} onChange={reload} />
      <Field
        label={t("OpenCode 本機估算")}
        hint={t("線上額度取不到時，以 OpenCode 的本機資料庫估算 Go 的額度；只看得到這台電腦的紀錄")}
      >
        <Toggle
          checked={s.opencodeLocalLimitsEnabled}
          onChange={(v) => void updateSettings({ opencodeLocalLimitsEnabled: v })}
        />
      </Field>
      {status && status.skipped > 0 && (
        <p className="pb-2 text-xs text-fg/50">
          {t("這台電腦有 {n} 個 OpenCode 帳號，目前只顯示一個（順序：這裡存的 → 環境變數的 cookie → 自動偵測）", {
            n: status.skipped + 1,
          })}
        </p>
      )}
    </>
  );
}
