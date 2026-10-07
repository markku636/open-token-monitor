import { describe, expect, it } from "vitest";
import { dragAfterMove, dropIndex, type DragState } from "./ReorderList";

const armed: DragState = { id: "home", pointerId: 1, from: 0, startY: 100, dy: 0, active: false, mids: [100, 130, 160], height: 30 };

describe("ReorderList drag", () => {
  it("starts dragging only past the 4px threshold while a button is held", () => {
    expect(dragAfterMove(armed, { pointerId: 1, clientY: 103, buttons: 1 })).toBe(armed);
    expect(dragAfterMove(armed, { pointerId: 1, clientY: 104, buttons: 1 })).toMatchObject({ active: true, dy: 4 });
    expect(dragAfterMove(armed, { pointerId: 2, clientY: 140, buttons: 1 })).toBe(armed);
  });

  it("drops an armed or active state once no button is held (the release never reached the row)", () => {
    expect(dragAfterMove(armed, { pointerId: 1, clientY: 140, buttons: 0 })).toBeNull();
    expect(dragAfterMove({ ...armed, active: true, dy: 20 }, { pointerId: 1, clientY: 140, buttons: 0 })).toBeNull();
  });

  it("drops at the position whose midline is above the pointer", () => {
    expect(dropIndex(armed.mids, 0, 100 + 45)).toBe(1);
    expect(dropIndex(armed.mids, 0, 100 + 70)).toBe(2);
    expect(dropIndex(armed.mids, 2, 160 - 70)).toBe(0);
  });
});
