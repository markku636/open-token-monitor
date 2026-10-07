// 目前設定的模型別名 resolver（見 modelAliases.ts）。自動合併要知道有哪些模型，這裡用本機與全公司
// 「全部」期間的模型當作候選（上游以整份 stats 裡出現的模型為準）。

import { useMemo } from "react";
import { createResolver, type AliasGrouping, type Resolve } from "./modelAliases";
import { useApp } from "./store";

export function useResolveModel(): Resolve {
  const aliases = useApp((s) => s.settings?.modelAliases);
  const grouping = useApp((s) => (s.settings?.modelAliasGrouping ?? "off") as AliasGrouping);
  const localModels = useApp((s) => s.local?.periods.allTime.models);
  const companyModels = useApp((s) => s.company?.periods.allTime.models);
  return useMemo(
    () => createResolver(aliases ?? {}, [...Object.keys(localModels ?? {}), ...Object.keys(companyModels ?? {})], grouping),
    [aliases, grouping, localModels, companyModels],
  );
}
