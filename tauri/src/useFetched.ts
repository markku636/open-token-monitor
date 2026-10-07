// 打開畫面時才向 Rust 要資料的 hook（明細清單、趨勢）。

import { useEffect, useState } from "react";
import { useApp } from "./store";

export interface FetchedOptions {
  /**
   * 換了 key 之後，新資料到之前仍回傳上一份（不論是哪個 key 的），拉失敗才回 null。
   * 本機清單用：換期間時列不會先被換成簡易清單又換回來，列的身分留著，數字與長條才能從舊期間動到新期間
   * （上游換期間時就是從舊的列動過去）。
   */
  keepPrevious?: boolean;
}

/** 拉到的資料與它所屬的 key（`keepPrevious` 時可能是上一個 key）；還沒有任何資料時是 null。 */
export interface FetchedEntry<T> {
  key: string;
  data: T | null;
}

/**
 * 打開畫面時拉一次，`key`（期間、頁碼）、本機 record（`updatedAt`）或 `refresh` 變了就重拉。
 * 重拉期間仍顯示同一個 key 的舊資料（每幾秒一次的更新不閃爍）；換了 key 則在新資料到之前回 null，
 * 不會把上一個期間的數字掛在新期間底下（`keepPrevious` 例外，見上）。
 */
export function useFetchedEntry<T>(fetch: () => Promise<T | null>, key: string, refresh?: unknown, opts?: FetchedOptions): FetchedEntry<T> | null {
  const updatedAt = useApp((s) => s.local?.updatedAt);
  const [state, setState] = useState<FetchedEntry<T> | null>(null);
  useEffect(() => {
    let alive = true;
    fetch()
      .then((data) => {
        if (alive) setState({ key, data });
      })
      .catch(() => {
        if (alive) setState({ key, data: null });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, updatedAt, refresh]);
  if (state?.key === key || (opts?.keepPrevious && state)) return state;
  return null;
}

export function useFetched<T>(fetch: () => Promise<T | null>, key: string, refresh?: unknown, opts?: FetchedOptions): T | null {
  return useFetchedEntry(fetch, key, refresh, opts)?.data ?? null;
}
