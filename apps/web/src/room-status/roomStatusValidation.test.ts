import { describe, expect, it } from "vitest";
import type { RoomStatusBoardDto, RoomStatusConflictDto, RoomStatusIntervalDto, RoomStatusOperationalTaskDto } from "@qintopia/contracts";
import { assertRoomStatusBoard } from "./roomStatusValidation";

const expected = {
  propertyId: "property_validation",
  range: { arrivalDate: "2028-01-01", departureDate: "2028-01-02" },
  pageIndex: 0
};

function validBoard(): RoomStatusBoardDto {
  const targetReference = { type: "INVENTORY_UNIT" as const, id: "unit_validation", label: "Validation room", href: null };
  const createAction = {
    code: "CREATE_ORDER" as const,
    enabled: true,
    disabledReason: null,
    requiresFullInterval: false,
    targetReference
  };
  return {
    propertyId: expected.propertyId,
    businessDate: "2028-01-01",
    range: expected.range,
    dates: ["2028-01-01"],
    asOf: "2028-01-01T00:00:00.000Z",
    freshUntil: "2028-01-01T00:00:05.000Z",
    revision: "1",
    accessLevel: "WRITE",
    projectionState: "READY",
    filterOptions: {
      roomTypeCodes: ["VALIDATION"],
      salesModes: ["WHOLE_ROOM"],
      statuses: ["AVAILABLE"],
      capacities: [1],
      unitKinds: ["ROOM"]
    },
    page: { index: 0, size: 200, totalRooms: 1, totalPages: 1 },
    operationalTasks: [],
    rooms: [{
      id: "unit_validation",
      propertyId: expected.propertyId,
      roomId: "unit_validation",
      parentRoomId: null,
      kind: "ROOM",
      code: "V01",
      name: "Validation room",
      active: true,
      salesMode: "WHOLE_ROOM",
      buildingCode: "V",
      roomTypeCode: "VALIDATION",
      pricingProductCode: "VALIDATION",
      capacity: 1,
      childUnitIds: [],
      children: [],
      days: [{
        serviceDate: "2028-01-01",
        status: "AVAILABLE",
        available: true,
        intervalIds: [],
        conflicts: []
      }],
      intervals: [],
      conflicts: [],
      allowedActions: [createAction]
    }]
  };
}

function internalUseInterval(overrides: Partial<RoomStatusIntervalDto> = {}): RoomStatusIntervalDto {
  const blockReference = { type: "BLOCK" as const, id: "block_validation", label: "Validation block", href: null };
  const claimReference = { type: "CLAIM" as const, id: "claim_validation", label: "Validation claim", href: null };
  return {
    id: "interval_validation",
    displayInventoryUnitId: "unit_validation",
    actualInventoryUnitId: "unit_validation",
    roomId: "unit_validation",
    startDate: "2028-01-01",
    endDate: "2028-01-02",
    sourceStartDate: "2028-01-01",
    sourceEndDate: "2028-01-02",
    status: "INTERNAL_USE",
    available: false,
    blocking: true,
    sourceKind: "INTERNAL_USE",
    label: "Internal use",
    primaryOccupantLabel: null,
    reason: "Validation",
    claimIds: [claimReference.id],
    references: [claimReference, blockReference],
    conflicts: [{
      id: "conflict_validation",
      blockingFactKind: "CLAIM",
      claimId: claimReference.id,
      claimIds: [claimReference.id],
      requestedInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceKind: "INTERNAL_USE",
      sourceReference: blockReference,
      reason: "Validation",
      blocking: true
    }],
    history: [],
    allowedActions: [{
      code: "RELEASE_INTERNAL_USE",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: true,
      targetReference: blockReference
    }],
    ...overrides
  };
}

function dayConflict(interval: RoomStatusIntervalDto): RoomStatusConflictDto {
  return {
    ...interval.conflicts[0]!,
    id: "conflict_validation_day",
    startDate: "2028-01-01",
    endDate: "2028-01-02"
  };
}

function boardWithInternalUse(): RoomStatusBoardDto {
  const board = validBoard();
  const interval = internalUseInterval();
  const room = board.rooms[0]!;
  room.intervals = [interval];
  room.days = [{
    serviceDate: "2028-01-01",
    status: "INTERNAL_USE",
    available: false,
    intervalIds: [interval.id],
    conflicts: [dayConflict(interval)]
  }];
  room.conflicts = interval.conflicts;
  room.allowedActions = interval.allowedActions;
  return board;
}

function orderExceptionTask(status: "RESERVED" | "IN_HOUSE" | "UNKNOWN"): RoomStatusOperationalTaskDto {
  const claimReference = { type: "CLAIM" as const, id: "claim_order_validation", label: "Order claim", href: null };
  const orderReference = { type: "ORDER" as const, id: "order_validation", label: "Order", href: "/orders/order_validation" };
  const stayReference = { type: "STAY" as const, id: "stay_validation", label: "Stay", href: null };
  const inventoryReference = { type: "INVENTORY_UNIT" as const, id: "unit_validation", label: "V01", href: null };
  const overdueDeparture = status === "IN_HOUSE";
  const claimBacked = !overdueDeparture;
  const startDate = overdueDeparture ? "2027-12-30" : status === "RESERVED" ? "2027-12-31" : "2028-01-01";
  const endDate = overdueDeparture ? "2027-12-31" : "2028-01-02";
  return {
    taskKind: "EXCEPTION",
    businessDate: "2028-01-01",
    id: "task_order_exception",
    displayInventoryUnitId: "unit_validation",
    actualInventoryUnitId: "unit_validation",
    roomId: "unit_validation",
    startDate,
    endDate,
    sourceStartDate: startDate,
    sourceEndDate: endDate,
    status,
    available: false,
    blocking: true,
    sourceKind: "ORDER",
    label: "Order exception",
    primaryOccupantLabel: null,
    reason: "Validation",
    claimIds: claimBacked ? [claimReference.id] : [],
    references: claimBacked ? [claimReference, orderReference, stayReference, inventoryReference] : [orderReference, stayReference, inventoryReference],
    conflicts: [{
      id: "conflict_order_validation",
      blockingFactKind: overdueDeparture ? "OVERDUE_IN_HOUSE" : "CLAIM",
      claimId: claimBacked ? claimReference.id : null,
      claimIds: claimBacked ? [claimReference.id] : [],
      requestedInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceKind: "ORDER",
      sourceReference: orderReference,
      reason: "Validation",
      blocking: true
    }],
    history: [],
    allowedActions: status === "UNKNOWN" ? [] : [{
      code: "OPEN_ORDER",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: false,
      targetReference: orderReference
    }]
  };
}

function normalLodgingTask(taskKind: "ARRIVAL" | "IN_HOUSE" | "DEPARTURE"): RoomStatusOperationalTaskDto {
  const claimReference = { type: "CLAIM" as const, id: "claim_order_validation", label: "Order claim", href: null };
  const task = orderExceptionTask(taskKind === "ARRIVAL" ? "RESERVED" : "IN_HOUSE");
  task.id = `task_order_${taskKind.toLowerCase()}`;
  task.taskKind = taskKind;
  task.reason = null;
  task.startDate = taskKind === "ARRIVAL" ? "2028-01-01" : "2027-12-31";
  task.endDate = taskKind === "DEPARTURE" ? "2028-01-01" : "2028-01-02";
  task.sourceStartDate = task.startDate;
  task.sourceEndDate = task.endDate;
  if (taskKind === "DEPARTURE") {
    task.available = false;
    task.blocking = true;
    task.claimIds = [];
    task.references = task.references.filter((reference) => reference.type !== "CLAIM");
    task.conflicts = [{
      ...task.conflicts[0]!,
      blockingFactKind: "LODGING_ORDER",
      claimId: null,
      claimIds: [],
      startDate: "2028-01-01",
      endDate: "2028-01-02"
    }];
    return task;
  }
  task.claimIds = [claimReference.id];
  if (!task.references.some((reference) => reference.type === "CLAIM")) task.references.unshift(claimReference);
  task.conflicts = [{
    ...task.conflicts[0]!,
    blockingFactKind: "CLAIM",
    claimId: claimReference.id,
    claimIds: [claimReference.id],
    startDate: "2028-01-01",
    endDate: "2028-01-02"
  }];
  return task;
}

describe("assertRoomStatusBoard", () => {
  it("accepts a complete authoritative board", () => {
    expect(() => assertRoomStatusBoard(validBoard(), expected)).not.toThrow();
  });

  it("rejects missing or invalid freshness instead of treating it as writable", () => {
    const missing = validBoard() as unknown as Record<string, unknown>;
    delete missing.freshUntil;
    expect(() => assertRoomStatusBoard(missing, expected)).toThrow(/freshUntil/);

    const extended = validBoard();
    extended.freshUntil = "2028-01-01T00:00:06.000Z";
    expect(() => assertRoomStatusBoard(extended, expected)).toThrow(/5 秒 freshness/);
  });

  it("rejects missing facets and incomplete aggregate Claim references", () => {
    const missingFacets = validBoard() as unknown as Record<string, unknown>;
    delete missingFacets.filterOptions;
    expect(() => assertRoomStatusBoard(missingFacets, expected)).toThrow(/filterOptions/);

    const missingClaimIds = boardWithInternalUse() as unknown as {
      rooms: Array<{ intervals: Array<{ conflicts: Array<Record<string, unknown>> }> }>;
    };
    delete missingClaimIds.rooms[0]!.intervals[0]!.conflicts[0]!.claimIds;
    expect(() => assertRoomStatusBoard(missingClaimIds, expected)).toThrow(/claimIds/);
  });

  it("rejects a READ projection that exposes any write action", () => {
    const board = validBoard();
    board.accessLevel = "READ";
    expect(() => assertRoomStatusBoard(board, expected)).toThrow(/READ 主体暴露写动作/);
  });

  it("rejects incomplete nested day and interval DTOs", () => {
    const missingDayFacts = validBoard() as unknown as { rooms: Array<{ days: Array<Record<string, unknown>> }> };
    delete missingDayFacts.rooms[0]!.days[0]!.conflicts;
    expect(() => assertRoomStatusBoard(missingDayFacts, expected)).toThrow(/days\[0\]\.conflicts/);

    const missingOccupantField = validBoard();
    missingOccupantField.rooms[0]!.intervals.push({
      id: "interval_validation",
      displayInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceStartDate: "2028-01-01",
      sourceEndDate: "2028-01-02",
      status: "INTERNAL_USE",
      available: false,
      blocking: true,
      sourceKind: "INTERNAL_USE",
      label: "Internal use",
      primaryOccupantLabel: null,
      reason: "Validation",
      claimIds: ["claim_validation"],
      references: [],
      conflicts: [],
      history: [],
      allowedActions: []
    });
    const rawInterval = missingOccupantField.rooms[0]!.intervals[0] as unknown as Record<string, unknown>;
    delete rawInterval.primaryOccupantLabel;
    expect(() => assertRoomStatusBoard(missingOccupantField, expected)).toThrow(/primaryOccupantLabel/);
  });

  it("rejects fail-open unknown, blocking, and mismatched row facts", () => {
    const unknownDay = validBoard();
    unknownDay.rooms[0]!.days[0] = {
      ...unknownDay.rooms[0]!.days[0]!,
      status: "UNKNOWN",
      available: true
    };
    expect(() => assertRoomStatusBoard(unknownDay, expected)).toThrow(/fail closed/);

    const blockingInterval = validBoard();
    blockingInterval.rooms[0]!.intervals.push({
      ...internalUseInterval({ id: "interval_fail_open" }),
      available: true,
    });
    expect(() => assertRoomStatusBoard(blockingInterval, expected)).toThrow(/阻断区间和冲突事实/);

    const wrongRow = validBoard();
    const wrongRowInterval = internalUseInterval({
      id: "interval_wrong_row",
      displayInventoryUnitId: "unit_other"
    });
    wrongRowInterval.conflicts = [{
      ...wrongRowInterval.conflicts[0]!,
      requestedInventoryUnitId: "unit_other"
    }];
    wrongRow.rooms[0]!.intervals.push({
      ...wrongRowInterval
    });
    expect(() => assertRoomStatusBoard(wrongRow, expected)).toThrow(/所属库存行/);
  });

  it("requires service-owned operational task boundaries", () => {
    const missingTasks = validBoard() as unknown as Record<string, unknown>;
    delete missingTasks.operationalTasks;
    expect(() => assertRoomStatusBoard(missingTasks, expected)).toThrow(/operationalTasks/);

    const invalidDeparture = validBoard();
    invalidDeparture.operationalTasks.push({
      taskKind: "DEPARTURE",
      businessDate: "2028-01-01",
      id: "task_departure_invalid",
      displayInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2027-12-31",
      endDate: "2028-01-02",
      sourceStartDate: "2027-12-31",
      sourceEndDate: "2028-01-02",
      status: "IN_HOUSE",
      available: true,
      blocking: false,
      sourceKind: "ORDER",
      label: "Order departure",
      primaryOccupantLabel: "Validation guest",
      reason: null,
      claimIds: [],
      references: [
        { type: "ORDER", id: "order_validation", label: "Order", href: "/orders/order_validation" },
        { type: "STAY", id: "stay_validation", label: "Stay", href: null }
      ],
      conflicts: [],
      history: [],
      allowedActions: [{
        code: "OPEN_ORDER",
        enabled: true,
        disabledReason: null,
        requiresFullInterval: false,
        targetReference: { type: "ORDER", id: "order_validation", label: "Order", href: "/orders/order_validation" }
      }]
    });
    expect(() => assertRoomStatusBoard(invalidDeparture, expected)).toThrow(/离店任务/);
  });

  it("accepts Claim-backed arrival/in-house tasks and an explicit current departure-day blocker", () => {
    const board = validBoard();
    board.operationalTasks = [
      normalLodgingTask("ARRIVAL"),
      normalLodgingTask("IN_HOUSE"),
      normalLodgingTask("DEPARTURE")
    ];
    expect(() => assertRoomStatusBoard(board, expected)).not.toThrow();

    const misclassified = validBoard();
    const inHouse = normalLodgingTask("IN_HOUSE");
    inHouse.conflicts[0] = { ...inHouse.conflicts[0]!, blockingFactKind: "OVERDUE_IN_HOUSE", claimId: null, claimIds: [] };
    inHouse.claimIds = [];
    inHouse.references = inHouse.references.filter((reference) => reference.type !== "CLAIM");
    misclassified.operationalTasks = [inHouse];
    expect(() => assertRoomStatusBoard(misclassified, expected)).toThrow(/真实 Claim/);

    for (const taskKind of ["ARRIVAL", "IN_HOUSE"] as const) {
      const orderOnly = normalLodgingTask(taskKind);
      orderOnly.claimIds = [];
      orderOnly.references = orderOnly.references.filter((reference) => reference.type !== "CLAIM");
      orderOnly.conflicts[0] = {
        ...orderOnly.conflicts[0]!,
        blockingFactKind: "LODGING_ORDER",
        claimId: null,
        claimIds: []
      };
      const invalid = validBoard();
      invalid.operationalTasks = [orderOnly];
      expect(() => assertRoomStatusBoard(invalid, expected), taskKind).toThrow(/真实 Claim/);
    }
  });

  it("accepts UNKNOWN and service-defined overdue order/free-stay exception tasks", () => {
    const validUnknown = validBoard();
    validUnknown.operationalTasks = [orderExceptionTask("UNKNOWN")];
    expect(() => assertRoomStatusBoard(validUnknown, expected)).not.toThrow();

    const missingClaim = orderExceptionTask("UNKNOWN");
    missingClaim.claimIds = [];
    missingClaim.references = missingClaim.references.filter((reference) => reference.type !== "CLAIM");
    missingClaim.conflicts[0] = {
      ...missingClaim.conflicts[0]!,
      blockingFactKind: "LODGING_ORDER",
      claimId: null,
      claimIds: []
    };
    const validMissingClaim = validBoard();
    validMissingClaim.operationalTasks = [missingClaim];
    expect(() => assertRoomStatusBoard(validMissingClaim, expected)).not.toThrow();

    const overdueArrival = validBoard();
    overdueArrival.operationalTasks = [orderExceptionTask("RESERVED")];
    expect(() => assertRoomStatusBoard(overdueArrival, expected)).not.toThrow();

    const historicalNoArrival = orderExceptionTask("RESERVED");
    historicalNoArrival.endDate = "2028-01-01";
    historicalNoArrival.sourceEndDate = "2028-01-01";
    historicalNoArrival.available = true;
    historicalNoArrival.blocking = false;
    historicalNoArrival.claimIds = [];
    historicalNoArrival.references = historicalNoArrival.references.filter((reference) => reference.type !== "CLAIM");
    historicalNoArrival.conflicts = [];
    const validHistoricalNoArrival = validBoard();
    validHistoricalNoArrival.operationalTasks = [historicalNoArrival];
    expect(() => assertRoomStatusBoard(validHistoricalNoArrival, expected)).not.toThrow();

    const failOpenOverdueArrival = orderExceptionTask("RESERVED");
    failOpenOverdueArrival.available = true;
    failOpenOverdueArrival.blocking = false;
    failOpenOverdueArrival.claimIds = [];
    failOpenOverdueArrival.references = failOpenOverdueArrival.references.filter((reference) => reference.type !== "CLAIM");
    failOpenOverdueArrival.conflicts = [];
    const invalidFailOpenOverdueArrival = validBoard();
    invalidFailOpenOverdueArrival.operationalTasks = [failOpenOverdueArrival];
    expect(() => assertRoomStatusBoard(invalidFailOpenOverdueArrival, expected)).toThrow(/真实 Claim/);

    const orderOnlyOverdueArrival = orderExceptionTask("RESERVED");
    orderOnlyOverdueArrival.claimIds = [];
    orderOnlyOverdueArrival.references = orderOnlyOverdueArrival.references.filter((reference) => reference.type !== "CLAIM");
    orderOnlyOverdueArrival.conflicts[0] = {
      ...orderOnlyOverdueArrival.conflicts[0]!,
      blockingFactKind: "LODGING_ORDER",
      claimId: null,
      claimIds: []
    };
    const invalidOrderOnlyOverdueArrival = validBoard();
    invalidOrderOnlyOverdueArrival.operationalTasks = [orderOnlyOverdueArrival];
    expect(() => assertRoomStatusBoard(invalidOrderOnlyOverdueArrival, expected)).toThrow(/真实 Claim/);

    const overdueDeparture = validBoard();
    overdueDeparture.operationalTasks = [orderExceptionTask("IN_HOUSE")];
    expect(() => assertRoomStatusBoard(overdueDeparture, expected)).not.toThrow();

    const notOverdueArrival = validBoard();
    notOverdueArrival.operationalTasks = [{
      ...orderExceptionTask("RESERVED"),
      startDate: "2028-01-01",
      sourceStartDate: "2028-01-01",
      conflicts: [{
        ...orderExceptionTask("RESERVED").conflicts[0]!,
        startDate: "2028-01-01"
      }]
    }];
    expect(() => assertRoomStatusBoard(notOverdueArrival, expected)).toThrow(/逾期未到异常/);

    const failOpenOverdueDeparture = validBoard();
    failOpenOverdueDeparture.operationalTasks = [{
      ...orderExceptionTask("IN_HOUSE"),
      blocking: false,
      available: true
    }];
    expect(() => assertRoomStatusBoard(failOpenOverdueDeparture, expected)).toThrow(/非阻断区间|逾期未退异常/);

    const missingTaskConflict = validBoard();
    missingTaskConflict.operationalTasks = [orderExceptionTask("UNKNOWN")];
    missingTaskConflict.operationalTasks[0]!.conflicts = [];
    expect(() => assertRoomStatusBoard(missingTaskConflict, expected)).toThrow(/一个精确冲突事实/);
  });

  it("requires visible intervals to be contained by complete source boundaries", () => {
    const outsideSource = boardWithInternalUse();
    outsideSource.rooms[0]!.intervals[0]!.sourceStartDate = "2028-01-02";
    expect(() => assertRoomStatusBoard(outsideSource, expected)).toThrow(/来源完整半开区间/);

    const clippedRelease = boardWithInternalUse();
    const interval = clippedRelease.rooms[0]!.intervals[0]!;
    interval.sourceStartDate = "2027-12-31";
    interval.sourceEndDate = "2028-01-03";
    expect(() => assertRoomStatusBoard(clippedRelease, expected)).toThrow(/不能启用完整释放动作/);

    const disabledRelease = boardWithInternalUse();
    const disabledInterval = disabledRelease.rooms[0]!.intervals[0]!;
    disabledInterval.sourceStartDate = "2027-12-31";
    disabledInterval.sourceEndDate = "2028-01-03";
    disabledInterval.allowedActions[0] = {
      ...disabledInterval.allowedActions[0]!,
      enabled: false,
      disabledReason: "当前窗口只包含来源完整区间的一部分"
    };
    disabledRelease.rooms[0]!.allowedActions = disabledInterval.allowedActions;
    expect(() => assertRoomStatusBoard(disabledRelease, expected)).not.toThrow();
  });

  it("rejects day facts that diverge from their covering blocking intervals", () => {
    const missingInterval = boardWithInternalUse();
    missingInterval.rooms[0]!.days[0]!.intervalIds = [];
    expect(() => assertRoomStatusBoard(missingInterval, expected)).toThrow(/覆盖该营业日的全部区间/);

    const failOpenAvailability = boardWithInternalUse();
    failOpenAvailability.rooms[0]!.days[0]!.available = true;
    expect(() => assertRoomStatusBoard(failOpenAvailability, expected)).toThrow(/blocking\/UNKNOWN/);

    const mismatchedConflict = boardWithInternalUse();
    mismatchedConflict.rooms[0]!.days[0]!.conflicts[0] = {
      ...mismatchedConflict.rooms[0]!.days[0]!.conflicts[0]!,
      claimId: "claim_other",
      claimIds: ["claim_other"]
    };
    expect(() => assertRoomStatusBoard(mismatchedConflict, expected)).toThrow(/单一 Claim/);
  });

  it("binds every action and href to a trusted typed source reference", () => {
    const wrongTarget = validBoard();
    wrongTarget.rooms[0]!.allowedActions[0]!.targetReference = {
      type: "ORDER",
      id: "order_validation",
      label: "Order",
      href: "/orders/order_validation"
    };
    expect(() => assertRoomStatusBoard(wrongTarget, expected)).toThrow(/目标类型不一致/);

    const unsafeHref = validBoard();
    unsafeHref.rooms[0]!.allowedActions[0]!.targetReference!.href = "javascript:alert(1)";
    expect(() => assertRoomStatusBoard(unsafeHref, expected)).toThrow(/可信内部路径/);

    const unrelatedBlock = boardWithInternalUse();
    unrelatedBlock.rooms[0]!.intervals[0]!.allowedActions[0]!.targetReference = {
      type: "BLOCK",
      id: "block_other",
      label: "Other block",
      href: null
    };
    expect(() => assertRoomStatusBoard(unrelatedBlock, expected)).toThrow(/不属于该区间/);
  });

  it("rejects a non-contiguous date axis and inconsistent pagination", () => {
    const wrongDates = validBoard();
    wrongDates.dates = ["2028-01-02"];
    wrongDates.rooms[0]!.days[0]!.serviceDate = "2028-01-02";
    expect(() => assertRoomStatusBoard(wrongDates, expected)).toThrow(/dates/);

    const wrongPage = validBoard();
    wrongPage.page.totalPages = 2;
    expect(() => assertRoomStatusBoard(wrongPage, expected)).toThrow(/page.totalPages/);
  });
});
