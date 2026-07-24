import { describe, expect, it } from "vitest";
import {
  roomStatusRowSalesLabel,
  roomStatusSaleCapabilityLabel,
  roomStatusSelectedSaleLabel,
  roomStatusUnitDescription,
  roomStatusUnitLabel,
  roomStatusUnitLocationLabel
} from "./roomStatusPresentation";

describe("room status unit presentation", () => {
  it("uses building, room code, and room type without repeating the code", () => {
    const unit = { kind: "ROOM", code: "302", name: "302 · 单人间（公卫）", buildingCode: "3" } as const;

    expect(roomStatusUnitLabel(unit)).toBe("3栋 302 单人间（公卫）");
    expect(roomStatusUnitLocationLabel(unit)).toBe("3栋 302");
    expect(roomStatusUnitDescription(unit)).toBe("单人间（公卫）");
  });

  it("uses the parent room location for a named bed", () => {
    const unit = { kind: "BED", code: "101-A", name: "101 · 床位 A", buildingCode: "1" } as const;

    expect(roomStatusUnitLabel(unit)).toBe("1栋 101 床位 A");
    expect(roomStatusUnitLocationLabel(unit)).toBe("1栋 101-A");
    expect(roomStatusUnitDescription(unit)).toBe("床位 A");
  });

  it("keeps the stable code when a custom name does not contain it", () => {
    const unit = { kind: "ROOM", code: "D01", name: "养蜂单人间", buildingCode: "D" } as const;

    expect(roomStatusUnitLabel(unit)).toBe("D栋 D01 养蜂单人间");
  });
});

describe("room status sales presentation", () => {
  it("describes a split-capable room selection as whole-room sales", () => {
    const unit = { kind: "ROOM", salesMode: "BED_SPLIT" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("整房销售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("支持整房及单床销售");
    expect(roomStatusRowSalesLabel(unit)).toBe("支持整房及单床销售");
  });

  it("describes a bed selection as single-bed sales", () => {
    const unit = { kind: "BED", salesMode: "BED_SPLIT" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("单床销售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("支持整房及单床销售");
    expect(roomStatusRowSalesLabel(unit)).toBe("单床销售");
  });

  it("describes a whole-room-only unit without implying bed sales", () => {
    const unit = { kind: "ROOM", salesMode: "WHOLE_ROOM" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("整房销售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("仅整房销售");
    expect(roomStatusRowSalesLabel(unit)).toBe("整房销售");
  });

  it("keeps unavailable inventory explicit", () => {
    const unit = { kind: "ROOM", salesMode: "UNAVAILABLE" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("不可售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("当前不可售");
    expect(roomStatusRowSalesLabel(unit)).toBe("不可售");
  });
});
