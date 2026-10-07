// 打開畫面時才向 Rust 要資料的 hook（明細清單、趨勢）。

import { useEffect, useState } from "react";
import { useApp } from "./store";

/**
 * 打開畫面時拉一次，`key`（期間、頁碼）、本機 record（`updatedAt`）或 `refresh` 變了就重拉。
 * 重拉期間仍顯示同一個 key 的舊資料（每幾秒一次的更新不閃爍）；換了 key 則在新資料到之前回 null，
 * 不會把上一個期間的數字掛在新期間底下。
 */
export function useFetched<T>(fetch: () => Promise<T | null>, key: string, refresh?: unknown): T | null {
  const updatedAt = useApp((s) => s.local?.updatedAt);
  const [state, setState] = useState<{ key: string; data: T | null } | null>(null);
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
  return state?.key === key ? state.data : null;
}
