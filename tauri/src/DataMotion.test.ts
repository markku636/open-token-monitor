import { describe, expect, it } from "vitest";
import { primeNewBars } from "./DataMotion";

/** 只有 inline style 的假長條（測試環境沒有 DOM）。 */
function fakeFill(scale?: string) {
  const props = new Map<string, string>(scale === undefined ? [] : [["--bar-scale", scale]]);
  const el = {
    style: {
      getPropertyValue: (k: string) => props.get(k) ?? "",
      setProperty: (k: string, v: string) => void props.set(k, v),
    },
  } as unknown as HTMLElement;
  return { el, props };
}

describe("primeNewBars", () => {
  it("writes the target scale only on bars React just created", () => {
    // 新節點要在量版面之前就有比例，否則第一份樣式是 scaleX(0)，之後寫比例會觸發 CSS 過場（上游 updateRow）。
    const fresh = fakeFill();
    const kept = fakeFill("0.4");
    const nodes = new Map<string, { fill: HTMLElement | null }>([
      ["a", { fill: fresh.el }],
      ["b", { fill: kept.el }],
      ["c", { fill: null }],
    ]);
    primeNewBars(nodes, [
      { key: "a", value: 10, scale: 0.8 },
      { key: "b", value: 5, scale: 0.5 },
      { key: "c", value: 1, scale: 0.1 },
      { key: "gone", value: 1, scale: 1 },
    ]);
    expect(fresh.props.get("--bar-scale")).toBe("0.8");
    // 既有的長條留給動畫或 CSS 過場從目前的長度動過去。
    expect(kept.props.get("--bar-scale")).toBe("0.4");
  });
});
