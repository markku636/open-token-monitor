// 目前生效的廠商色：品牌色套上設定的 `vendorColors` 覆寫。
// 取代上游直接改寫共用 clientColors 的做法（app.js applyVendorColorOverrides）：設定變了，
// 用到的元件跟著重繪。

import { useMemo } from "react";
import { useApp } from "./store";
import { mergeVendorColors } from "./theme";
import { BRAND_COLORS, type VendorColorMap } from "./vendorColors";

export function useVendorColors(): VendorColorMap {
  const overrides = useApp((s) => s.settings?.vendorColors);
  return useMemo(() => mergeVendorColors(BRAND_COLORS, overrides), [overrides]);
}
