// 邊緣額度條的格子：每個有數字的工具取 5 小時與每週（不帶標籤的總量）兩格，已用比例（上游 Edge Dock
// 的 limit items；挑窗口的規則與 tray 的額度長條相同，見 src-tauri/src/gui/tray_bars.rs）。

import type { LimitProvider, LimitWindow, LimitsView } from "./api";

export interface DockCell {
  key: string;
  provider: string;
  kind: "session" | "weekly";
  used: number;
}

function used(w: LimitWindow): number | null {
  if (w.metric === "credits") return null;
  if (w.remainingPercent !== null && Number.isFinite(w.remainingPercent)) return 100 - w.remainingPercent;
  if (w.usedPercent !== null && Number.isFinite(w.usedPercent)) return w.usedPercent;
  return null;
}

function pick(p: LimitProvider, kind: "session" | "weekly"): LimitWindow | null {
  const windows = p.windows.filter(
    (w) => w.showMeter && w.kind === kind && !(p.provider === "codex" && w.additional) && used(w) !== null,
  );
  if (windows.length < 2) return windows[0] ?? null;
  const canonical = windows.find((w) => ["", "weekly"].includes(w.label.trim().toLowerCase()));
  return canonical ?? windows.reduce((a, b) => ((used(b) ?? 0) > (used(a) ?? 0) ? b : a));
}

export function dockCells(limits: LimitsView | null): DockCell[] {
  const cells: DockCell[] = [];
  for (const p of limits?.providers ?? []) {
    if (p.status !== "ok") continue;
    for (const kind of ["session", "weekly"] as const) {
      const w = pick(p, kind);
      const u = w ? used(w) : null;
      if (u !== null) cells.push({ key: `${p.provider}:${kind}`, provider: p.provider, kind, used: Math.min(100, Math.max(0, u)) });
    }
  }
  return cells;
}
