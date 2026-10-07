// 本機分頁的明細清單：工具（展開看 token 組成或模型）、模型（展開看 token 組成）、專案（展開看工具）、
// session（分頁）。資料在打開時向 Rust 要（usage_detail / usage_sessions），本機有新掃描結果時重拉。
// 版面與規則對應上游 renderer 的 breakdown 清單（app.js renderBreakdownRow 與各 *Rows.js）。

import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  api,
  type PeriodDetail,
  type PeriodName,
  type ProjectRow,
  type ReviewGroup,
  type SessionPage,
  type SessionRow,
  type Share,
  type UsageRow,
} from "./api";
import { clientLabel, seriesColor } from "./clients";
import {
  barWidth,
  callsLabel,
  clientGradient,
  compactSessionTime,
  detailPercentLabel,
  exchangeRows,
  inputPercentages,
  isLive,
  sessionIdLabel,
  sessionModelLabel,
  stableColor,
  tokenComponentBreakdown,
  visibleShares,
} from "./detailFormat";
import { fmtTokens, fmtUsd } from "./format";
import { t } from "./i18n";
import { useApp, type ToolDetailMode } from "./store";
import { Segmented } from "./ui";
import { useFetched } from "./useFetched";

/** 支援逐回合明細的工具（src-tauri/src/session_detail.rs `DETAIL_CLIENTS`）。 */
const DETAIL_CLIENTS = ["claude", "codex", "opencode"];
import { foldNames, foldRows } from "./modelAliases";
import { useResolveModel } from "./useModelAlias";

export function usePeriodDetail(period: PeriodName): PeriodDetail | null {
  return useFetched(() => api.usageDetail(period), period);
}

const empty = (text: string) => <div className="px-3 py-6 text-center text-xs text-fg/40">{text}</div>;

function Bar({ width, background }: { width: number; background: string }) {
  return (
    <div className="mt-0.5 h-1 rounded-full bg-fg/10">
      {width > 0 && <div className="h-1 rounded-full" style={{ width: `${width}%`, background }} />}
    </div>
  );
}

/** 清單的一列：左邊標題（可有副標），右邊 token 與成本，下面長條；有 `children` 時可展開。 */
function Row({
  title,
  titleHint,
  sub,
  right,
  bar,
  expanded,
  onToggle,
  onClick,
  children,
  leading,
}: {
  title: ReactNode;
  titleHint?: string;
  sub?: ReactNode;
  right: ReactNode;
  bar: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  /** 點整列開啟別的畫面（例如 session 的逐回合明細）；有 children 時用 onToggle 展開。 */
  onClick?: () => void;
  children?: ReactNode;
  leading?: ReactNode;
}) {
  const expandable = Boolean(onToggle && children);
  const head = (
    <>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1">
          {expandable && (
            <ChevronRight size={11} className={`shrink-0 text-fg/40 transition-transform ${expanded ? "rotate-90" : ""}`} />
          )}
          {leading}
          <span className="truncate" title={titleHint}>
            {title}
          </span>
        </span>
        <span className="num shrink-0 text-fg/60">{right}</span>
      </div>
      {sub && <div className="truncate text-2xs text-fg/40">{sub}</div>}
      {bar}
    </>
  );
  return (
    <li>
      {expandable ? (
        <button type="button" className="block w-full text-left" aria-expanded={expanded} onClick={onToggle}>
          {head}
        </button>
      ) : onClick ? (
        <button type="button" className="block w-full rounded-sm text-left hover:bg-fg/5" onClick={onClick}>
          {head}
        </button>
      ) : (
        head
      )}
      {expandable && expanded && <div className="mb-1 mt-1.5 space-y-0.5 rounded-sm bg-inset px-2 py-1.5">{children}</div>}
    </li>
  );
}

function DetailLine({ label, value, percent, color }: { label: ReactNode; value: string; percent?: string | null; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-2xs">
      <span className="flex min-w-0 items-center gap-1.5 text-fg/60">
        {color && <span className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: color }} />}
        <span className="truncate">{label}</span>
      </span>
      <span className="num shrink-0 text-fg/75">
        {percent ? <span className="mr-1.5 text-fg/40">{percent}</span> : null}
        {value}
      </span>
    </div>
  );
}

function shareLabel(key: string, unattributed: boolean | undefined, kind: "client" | "model"): string {
  if (unattributed) return t("未分類");
  return kind === "client" ? clientLabel(key) : key;
}

function TokenLines({ row }: { row: UsageRow }) {
  if (!row.components) return null;
  const parts = tokenComponentBreakdown(row.tokens, row.components);
  const pct = inputPercentages(parts);
  return (
    <>
      <DetailLine label={t("輸入 (快取命中)")} value={fmtTokens(parts.cacheRead)} percent={detailPercentLabel(pct.hit)} />
      <DetailLine label={t("輸入 (快取未命中)")} value={fmtTokens(parts.cacheMiss)} percent={detailPercentLabel(pct.miss)} />
      <DetailLine label={t("輸出")} value={fmtTokens(parts.output)} />
      {parts.unclassified > 0 && <DetailLine label={t("未分類")} value={fmtTokens(parts.unclassified)} />}
    </>
  );
}

function ModelLines({ tool, models }: { tool: UsageRow; models: Share[] }) {
  return (
    <>
      {models.map((m) => (
        <DetailLine
          key={m.key}
          label={m.unattributed ? t("未分類") : m.key}
          value={m.tokens > 0 ? fmtTokens(m.tokens) : fmtUsd(m.costUsd)}
          percent={m.tokens > 0 && tool.tokens > 0 ? detailPercentLabel((m.tokens / tool.tokens) * 100) : null}
        />
      ))}
    </>
  );
}

/** 工具或模型的清單。工具列展開後可切換 token 組成與模型拆分。 */
export function UsageList({ rows, kind }: { rows: UsageRow[]; kind: "client" | "model" }) {
  const [open, setOpen] = useState<string | null>(null);
  const mode = useApp((s) => s.toolDetailMode);
  const setMode = useApp((s) => s.setToolDetailMode);
  const resolve = useResolveModel();
  // 模型列（與工具下的模型）依設定的別名合併，只影響顯示。
  const shown = visibleShares(kind === "model" ? foldRows(rows, resolve) : rows);
  if (!shown.length) return empty(t("這段期間沒有用量"));
  const max = Math.max(...shown.map((r) => r.tokens), 0);
  const total = shown.reduce((s, r) => s + r.tokens, 0);
  return (
    <ul className="space-y-1.5 px-3">
      {shown.map((r, i) => {
        const models = kind === "client" ? visibleShares(foldRows(r.models ?? [], resolve)) : [];
        const canExpand = r.tokens > 0 && (r.components !== null || models.length > 0);
        const effective: ToolDetailMode = mode === "models" && models.length > 0 ? "models" : r.components ? "tokens" : "models";
        const color = r.unattributed ? seriesColor("__other", 0) : seriesColor(r.key, i);
        return (
          <Row
            key={r.key}
            title={shareLabel(r.key, r.unattributed, kind)}
            titleHint={r.key}
            right={`${fmtTokens(r.tokens)} · ${fmtUsd(r.costUsd)} · ${detailPercentLabel(total > 0 ? (r.tokens / total) * 100 : 0)}`}
            bar={<Bar width={barWidth(r.tokens, max)} background={color} />}
            expanded={open === r.key}
            onToggle={canExpand ? () => setOpen(open === r.key ? null : r.key) : undefined}
          >
            {canExpand && (
              <>
                {models.length > 0 && r.components && (
                  <div className="mb-1 flex justify-end">
                    <Segmented<ToolDetailMode>
                      size="xs"
                      value={effective}
                      options={[
                        { value: "tokens", label: "Tokens" },
                        { value: "models", label: t("模型") },
                      ]}
                      onChange={setMode}
                    />
                  </div>
                )}
                {effective === "tokens" ? <TokenLines row={r} /> : <ModelLines tool={r} models={models} />}
              </>
            )}
          </Row>
        );
      })}
    </ul>
  );
}

/** 上游 usageCharts.js 的 fallbackModelColors（專案的固定顏色）。 */
const PROJECT_COLORS = ["#6ab4f0", "#5fbf8a", "#a57df0", "#d97bc4", "#f0d66a", "#f06a7b"];

/** 專案清單（上游 projectRows.js）：長條是各工具比例的漸層，展開看各工具的 token。 */
export function ProjectList({ rows }: { rows: ProjectRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return empty(t("這段期間沒有專案用量"));
  const max = Math.max(...rows.map((r) => r.tokens), 0);
  return (
    <ul className="space-y-1.5 px-3">
      {rows.map((p) => {
        const own = stableColor(p.key, PROJECT_COLORS);
        const color = (key: string) => (key === "__unattributed" ? own : seriesColor(key, 0));
        return (
          <Row
            key={p.key}
            title={p.label}
            titleHint={p.label}
            leading={<span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: own }} />}
            right={`${fmtTokens(p.tokens)} · ${fmtUsd(p.costUsd)}`}
            bar={<Bar width={barWidth(p.tokens, max)} background={clientGradient(p.clients, color, own)} />}
            expanded={open === p.key}
            onToggle={p.clients.length ? () => setOpen(open === p.key ? null : p.key) : undefined}
          >
            {p.clients.map((c) => (
              <DetailLine
                key={c.key}
                color={color(c.key)}
                label={c.unattributed ? t("未知工具") : clientLabel(c.key)}
                value={fmtTokens(c.tokens)}
                percent={p.tokens > 0 ? `${Math.round((c.tokens / p.tokens) * 100)}%` : null}
              />
            ))}
          </Row>
        );
      })}
    </ul>
  );
}

function SessionLine({ s, max, now, onOpen }: { s: SessionRow; max: number; now: number; onOpen?: () => void }) {
  const resolve = useResolveModel();
  const model = sessionModelLabel(foldNames(s.models, resolve));
  const title = [clientLabel(s.client), model].filter(Boolean).join(" · ");
  const sub = [s.archived ? t("已封存") : "", compactSessionTime(s.at, new Date(now)), callsLabel(s.messageCount)].filter(Boolean).join(" · ");
  const id = sessionIdLabel(s.sessionId);
  // 封存的 session 原始紀錄已經不在，不可能還在寫入（上游 sessionActivityState 同樣視為閒置）。
  const live = !s.archived && isLive(s.at, now);
  return (
    <Row
      title={title}
      titleHint={`${clientLabel(s.client)} session${id ? ` ${id}` : ""}`}
      leading={
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "bg-success" : ""}`}
          style={live ? undefined : { background: seriesColor(s.client, 0) }}
          title={live ? t("10 分鐘內有活動") : undefined}
        />
      }
      sub={[sub, id].filter(Boolean).join(" · ")}
      right={`${fmtTokens(s.totalTokens)} · ${fmtUsd(s.costUsd)}`}
      bar={<Bar width={barWidth(s.totalTokens, max)} background={seriesColor(s.client, 0)} />}
      onClick={onOpen}
    />
  );
}

/**
 * session 的逐回合明細（上游 Session detail）：每則提問一列，展開看每一輪 AI 回覆的 token 組成與工具。
 * 成本是 session 在這段期間的成本依 token 比例分攤（OpenCode 用真實成本）。
 */
function SessionDetailView({ s, period, onBack }: { s: SessionRow; period: PeriodName; onBack: () => void }) {
  const resolve = useResolveModel();
  const [sortBy, setSortBy] = useState<"time" | "tokens">("time");
  const [open, setOpen] = useState<string | null>(null);
  const detail = useFetched(() => api.sessionDetailGet(s.client, s.sessionId, period, s.costUsd), `${s.key}:${period}`);
  const title = [clientLabel(s.client), sessionModelLabel(foldNames(s.models, resolve))].filter(Boolean).join(" · ");
  let body: ReactNode;
  if (!detail) body = empty(t("載入中…"));
  else if (!detail.found) body = empty(t("在這台機器上找不到對話紀錄。"));
  else if (!detail.exchanges.length) body = empty(t("這段期間沒有活動。"));
  else {
    const rows = exchangeRows(detail.exchanges, sortBy, fmtTokens);
    const max = Math.max(...rows.map((r) => r.value), 0);
    body = (
      <ul className="space-y-1.5 px-3">
        {rows.map((r) => (
          <Row
            key={r.key}
            title={
              r.isPrompt ? (
                <>
                  <span className="text-accent">{t("你")}</span>
                  <span className="text-fg/40"> › </span>
                  {r.title}
                </>
              ) : (
                <span className="text-fg/50">{r.title}</span>
              )
            }
            titleHint={r.title}
            sub={r.subtitle}
            right={`${fmtTokens(r.value)} · ${fmtUsd(r.cost)}`}
            bar={<Bar width={barWidth(r.value, max)} background={seriesColor(s.client, 0)} />}
            expanded={open === r.key}
            onToggle={() => setOpen(open === r.key ? null : r.key)}
          >
            {r.turns.map((turn) => (
              <div key={turn.key} className="py-0.5 text-2xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-fg/70">AI {turn.label}</span>
                  <span className="num text-fg/75">
                    {fmtTokens(turn.value)} <span className="text-fg/40">{fmtUsd(turn.cost)}</span>
                  </span>
                </div>
                <div className="num truncate text-fg/40">{turn.split}</div>
                {turn.tools && <div className="truncate text-fg/40">⊢ {turn.tools}</div>}
              </div>
            ))}
          </Row>
        ))}
      </ul>
    );
  }
  return (
    <>
      <div className="mb-2 flex items-center gap-2 px-3 text-xs">
        <button type="button" className="shrink-0 text-accent hover:underline" onClick={onBack}>
          ‹ Session
        </button>
        <span className="min-w-0 flex-1 truncate text-fg/70" title={s.sessionId}>
          {title}
        </span>
        <button type="button" className="shrink-0 text-2xs text-fg/50 hover:text-fg" onClick={() => setSortBy(sortBy === "time" ? "tokens" : "time")}>
          {sortBy === "tokens" ? t("↕ Token 最多") : t("↕ 最新")}
        </button>
      </div>
      {body}
    </>
  );
}

function ReviewLine({ g, max, now }: { g: ReviewGroup; max: number; now: number }) {
  return (
    <Row
      title={t("Codex 自動審查")}
      leading={<span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: seriesColor("codex", 0) }} />}
      sub={`${t("最近 {time}", { time: compactSessionTime(g.latestAt, new Date(now)) })} · ${fmtTokens(g.latestTokens)} · ${t("{count} 次背景執行", { count: g.count })}`}
      right={`${fmtTokens(g.totalTokens)} · ${fmtUsd(g.costUsd)}`}
      bar={<Bar width={barWidth(g.totalTokens, max)} background={seriesColor("codex", 0)} />}
    />
  );
}

/** session 清單（上游 sessionRows.js）：最近使用的在前，一頁 100 筆；Codex 背景審查合成最後一列。 */
export function SessionList({ period, fallback }: { period: PeriodName; fallback: ReactNode }) {
  // 換期間時由呼叫端以 key={period} 重建這個元件，頁碼自然回到第一頁。
  const [page, setPage] = useState(0);
  const [openSession, setOpenSession] = useState<SessionRow | null>(null);
  const data: SessionPage | null = useFetched(() => api.usageSessions(period, page), `${period}:${page}`);
  if (openSession) return <SessionDetailView s={openSession} period={period} onBack={() => setOpenSession(null)} />;
  if (!data) return null;
  if (!data.rows.length) return <>{fallback}</>;
  const now = Date.now();
  const max = data.maxTokens;
  const pages = Math.ceil(data.total / data.pageSize);
  const start = data.page * data.pageSize + 1;
  const end = Math.min(data.total, start + data.rows.length - 1);
  return (
    <>
      <ul className="space-y-1.5 px-3">
        {data.rows.map((r) =>
          r.kind === "review" ? (
            <ReviewLine key="__review" g={r} max={max} now={now} />
          ) : (
            <SessionLine
              key={r.key}
              s={r}
              max={max}
              now={now}
              // 只有讀得到逐回合紀錄的工具可以點開；封存的 session 原始紀錄已經不在（上游同樣只開這幾個）。
              onOpen={DETAIL_CLIENTS.includes(r.client) && !r.archived ? () => setOpenSession(r) : undefined}
            />
          ),
        )}
      </ul>
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-center gap-3 text-2xs text-fg/50">
          <button type="button" className="px-1 hover:text-fg disabled:opacity-30" disabled={data.page === 0} title={t("上一頁")} onClick={() => setPage(data.page - 1)}>
            ‹
          </button>
          <span className="num">{t("第 {start}–{end} 筆，共 {total} 筆", { start, end, total: data.total })}</span>
          <button
            type="button"
            className="px-1 hover:text-fg disabled:opacity-30"
            disabled={data.page >= pages - 1}
            title={t("下一頁")}
            onClick={() => setPage(data.page + 1)}
          >
            ›
          </button>
        </div>
      )}
    </>
  );
}
