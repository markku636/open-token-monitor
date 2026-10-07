// 邊緣額度條的視窗內容（src-tauri/src/gui/dock.rs）：收合時是貼在螢幕邊的細條（peek），游標碰到就
// 請 Rust 展開成圓環列；游標離開 320 ms 後收回（上游 EDGE_DOCK_TIMING.hideDelayMs）。點圓環開啟額度分頁。

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { api, isTauri, onDockState, type DockView } from "./api";
import { dockCells, type DockCell } from "./dockItems";
import { t } from "./i18n";
import { meterTone, providerName } from "./limits";
import { useApp } from "./store";

const useDock = create<DockView>(() => ({ expanded: false, side: "right" }));

/** 上游 `EDGE_DOCK_TIMING`：碰到邊緣 140 ms 才展開（掃過去不算），離開 320 ms 才收回。 */
const REVEAL_DELAY_MS = 140;
const HIDE_DELAY_MS = 320;

const TONE_STROKE = { danger: "rgb(var(--c-danger))", warning: "rgb(var(--c-warning))", accent: "rgb(var(--c-accent))" } as const;

function Ring({ cell }: { cell: DockCell }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const label = cell.kind === "session" ? t("5 時") : t("週");
  return (
    <button
      type="button"
      className="flex w-full flex-col items-center gap-0.5 py-1 hover:bg-fg/10"
      title={`${providerName(cell.provider)} · ${Math.round(cell.used)}%`}
      onClick={() => void api.dockOpenLimits()}
    >
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="5" />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke={TONE_STROKE[meterTone(cell.used)]}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(cell.used / 100) * c} ${c}`}
          transform="rotate(-90 22 22)"
        />
        <text x="22" y="26" textAnchor="middle" className="num" fontSize="11" fill="currentColor">
          {Math.round(cell.used)}
        </text>
      </svg>
      <span className="text-2xs leading-none text-fg/60">
        {providerName(cell.provider).split(" ")[0]} {label}
      </span>
    </button>
  );
}

export function Dock() {
  const bootstrap = useApp((s) => s.bootstrap);
  const limits = useApp((s) => s.limits);
  const { expanded, side } = useDock();
  const cells = dockCells(limits);
  const reveal = useRef<number | undefined>(undefined);
  const hide = useRef<number | undefined>(undefined);

  useEffect(() => {
    void bootstrap();
    if (!isTauri()) return;
    void onDockState((v) => useDock.setState(v));
    void api.dockGet().then((v) => {
      if (v) useDock.setState(v);
    });
  }, [bootstrap]);

  const cancel = () => {
    window.clearTimeout(reveal.current);
    window.clearTimeout(hide.current);
  };
  const enter = () => {
    cancel();
    if (!expanded && cells.length > 0) {
      reveal.current = window.setTimeout(() => void api.dockExpand(cells.length), REVEAL_DELAY_MS);
    }
  };
  const leave = () => {
    cancel();
    if (expanded) hide.current = window.setTimeout(() => void api.dockCollapse(), HIDE_DELAY_MS);
  };
  const inner = side === "left" ? "rounded-r-md" : "rounded-l-md";

  if (!expanded) {
    return (
      <div
        className={`h-full w-full ${inner} ${cells.length ? "bg-accent/70" : "bg-fg/30"}`}
        title={cells.length ? "" : t("還沒有額度資料")}
        onMouseEnter={enter}
        onMouseLeave={cancel}
      />
    );
  }
  return (
    <div className={`widget-shell flex h-full w-full flex-col justify-center py-2 ${inner}`} onMouseEnter={cancel} onMouseLeave={leave}>
      {cells.map((cell) => (
        <Ring key={cell.key} cell={cell} />
      ))}
    </div>
  );
}
