import { describe, expect, it } from "vitest";
import type { RoomStatusOperationalTaskDto } from "@qintopia/contracts";
import { executableTaskAction, nextMobileTaskFocusId } from "./RoomStatusMobileTasks";

function internalUseTask(overrides: Partial<RoomStatusOperationalTaskDto> = {}): RoomStatusOperationalTaskDto {
  return {
    taskKind: "EXCEPTION",
    businessDate: "2026-07-20",
    id: "task_internal_use_today",
    displayInventoryUnitId: "unit_outside_current_page",
    actualInventoryUnitId: "unit_outside_current_page",
    roomId: "unit_room_outside_current_page",
    startDate: "2026-07-20",
    endDate: "2026-07-21",
    sourceStartDate: "2026-07-19",
    sourceEndDate: "2026-07-23",
    status: "INTERNAL_USE",
    available: false,
    blocking: true,
    sourceKind: "INTERNAL_USE",
    label: "内部占用",
    primaryOccupantLabel: null,
    reason: "跨页运营任务",
    claimIds: ["claim_internal_use_today"],
    references: [{ type: "BLOCK", id: "block_internal_use_today", label: "内部占用 Block", href: null }],
    conflicts: [],
    history: [],
    allowedActions: [{
      code: "RELEASE_INTERNAL_USE",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: true,
      targetReference: { type: "BLOCK", id: "block_internal_use_today", label: "内部占用 Block", href: null }
    }],
    ...overrides
  };
}

describe("RoomStatus mobile task actions", () => {
  it("keeps a complete server-authorized Block release executable outside the matrix page", () => {
    expect(executableTaskAction(internalUseTask(), null)?.code).toBe("RELEASE_INTERNAL_USE");
  });

  it("fails closed for disabled, mistyped, or incomplete release facts", () => {
    const base = internalUseTask();
    expect(executableTaskAction({
      ...base,
      allowedActions: [{ ...base.allowedActions[0]!, enabled: false, disabledReason: "服务端已禁用" }]
    }, null)).toBeUndefined();
    expect(executableTaskAction({ ...base, sourceKind: "MAINTENANCE" }, null)).toBeUndefined();
    expect(executableTaskAction({
      ...base,
      allowedActions: [{
        ...base.allowedActions[0]!,
        targetReference: { type: "ORDER", id: "order_wrong_target", label: "错误目标", href: "/orders/order_wrong_target" }
      }]
    }, null)).toBeUndefined();
    expect(executableTaskAction({ ...base, sourceEndDate: base.sourceStartDate }, null)).toBeUndefined();
  });

  it("returns the next surviving task at the completed task position, then falls back to the tab", () => {
    const first = internalUseTask({ id: "task_first" });
    const completed = internalUseTask({ id: "task_completed" });
    const next = internalUseTask({ id: "task_next" });
    expect(nextMobileTaskFocusId([first, completed, next], completed.id, 1)).toBe(next.id);
    expect(nextMobileTaskFocusId([completed], completed.id, 0)).toBeNull();
  });
});
