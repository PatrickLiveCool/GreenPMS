import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Hand,
  Layers3,
  SearchX
} from "lucide-react";
import type {
  RoomStatusBoardDto,
  RoomStatusDayDto,
  RoomStatusIntervalDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import {
  addLocalDateDays,
  dateWindowStartForFocus,
  filterRoomStatusRooms,
  hasActiveRoomStatusFilters,
  moveRoomStatusFocus,
  selectionFromCells,
  shiftDateWindowStart,
  visibleDateWindow,
  type RoomStatusCellFocus,
  type RoomStatusFilters,
  type RoomStatusScrollAnchor,
  type RoomStatusSelection
} from "./roomStatusState";
import {
  formatRoomStatusDate,
  roomStatusPresentation,
  roomStatusSourceLabels,
  RoomStatusMark,
  RoomStatusWarning,
  useRoomStatusMobileViewport
} from "./roomStatusPresentation";

interface PositionedInterval {
  interval: RoomStatusIntervalDto;
  startColumn: number;
  endColumn: number;
  lane: number;
}

interface RenderedUnit {
  unit: RoomStatusUnitDto;
  parent: RoomStatusUnitDto | null;
  depth: 0 | 1;
}

export interface RoomStatusGridProps {
  board: RoomStatusBoardDto;
  filters: RoomStatusFilters;
  expandedRoomIds: readonly string[];
  focusedCell: RoomStatusCellFocus | null;
  selection: RoomStatusSelection | null;
  dateWindowStart: number;
  dateWindowSize: number;
  todayDate?: string;
  initialScrollAnchor?: RoomStatusScrollAnchor | null;
  restoreFocus?: boolean;
  focusRequestToken?: number;
  onToggleRoom: (roomId: string) => void;
  onFocusedCellChange: (focus: RoomStatusCellFocus) => void;
  onSelectionChange: (selection: RoomStatusSelection | null) => void;
  onPageChange: (pageIndex: number) => void;
  onDateWindowChange: (start: number) => void;
  onInspectUnit: (unit: RoomStatusUnitDto) => void;
  onInspectDay: (unit: RoomStatusUnitDto, day: RoomStatusDayDto | null) => void;
  onInspectInterval: (unit: RoomStatusUnitDto, interval: RoomStatusIntervalDto) => void;
  onClearFilters: () => void;
  onScrollAnchorChange?: (anchor: RoomStatusScrollAnchor) => void;
}

function intervalsForWindow(intervals: readonly RoomStatusIntervalDto[], dates: readonly string[]): PositionedInterval[] {
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (!firstDate || !lastDate) return [];
  const visibleDeparture = addLocalDateDays(lastDate, 1);
  const candidates = intervals
    .filter((interval) => interval.startDate < visibleDeparture && interval.endDate > firstDate)
    .map((interval) => {
      const clippedStart = interval.startDate <= firstDate ? firstDate : interval.startDate;
      const clippedEnd = interval.endDate >= visibleDeparture ? visibleDeparture : interval.endDate;
      const startColumn = Math.max(0, dates.findIndex((date) => date >= clippedStart));
      const exactEnd = dates.findIndex((date) => date >= clippedEnd);
      const endColumn = exactEnd < 0 ? dates.length : exactEnd;
      return { interval, startColumn, endColumn };
    })
    .filter(({ startColumn, endColumn }) => endColumn > startColumn)
    .sort((left, right) => left.startColumn - right.startColumn || right.endColumn - left.endColumn || left.interval.id.localeCompare(right.interval.id));

  const laneEnds: number[] = [];
  return candidates.map((candidate) => {
    const availableLane = laneEnds.findIndex((laneEnd) => laneEnd <= candidate.startColumn);
    const lane = availableLane < 0 ? laneEnds.length : availableLane;
    laneEnds[lane] = candidate.endColumn;
    return { ...candidate, lane };
  });
}

function dayFor(unit: RoomStatusUnitDto, serviceDate: string): RoomStatusDayDto | null {
  return unit.days.find((day) => day.serviceDate === serviceDate) ?? null;
}

function cellAccessibleName(unit: RoomStatusUnitDto, serviceDate: string, day: RoomStatusDayDto | null): string {
  if (!day) return `${unit.name}，${formatRoomStatusDate(serviceDate)}，状态未知，服务端未返回逐日事实`;
  const status = roomStatusPresentation[day.status].label;
  const intervals = unit.intervals.filter((interval) => day.intervalIds.includes(interval.id));
  const sources = intervals.map((interval) => [
    roomStatusSourceLabels[interval.sourceKind],
    interval.label,
    interval.primaryOccupantLabel ? `主要居住人 ${interval.primaryOccupantLabel}` : null
  ].filter(Boolean).join(" "));
  const conflicts = day.conflicts.map((conflict) => `阻断冲突 ${conflict.reason}，${conflict.sourceReference.label}`);
  const availability = day.available ? "服务端标记可售" : "服务端标记不可售";
  return [unit.name, formatRoomStatusDate(serviceDate), status, availability, ...sources, ...conflicts].join("，");
}

function isCellSelected(selection: RoomStatusSelection | null, unitId: string, serviceDate: string): boolean {
  return Boolean(selection
    && selection.unitId === unitId
    && serviceDate >= selection.arrivalDate
    && serviceDate < selection.departureDate);
}

function rowDescription(unit: RoomStatusUnitDto): string {
  const salesMode = unit.salesMode === "WHOLE_ROOM" ? "整房销售" : unit.salesMode === "BED_SPLIT" ? "拆床销售" : "不可售";
  const kind = unit.kind === "ROOM" ? "房间" : "床位";
  return `${kind}，${salesMode}，容纳 ${unit.capacity} 人`;
}

export function RoomStatusGrid({
  board,
  filters,
  expandedRoomIds,
  focusedCell,
  selection,
  dateWindowStart,
  dateWindowSize,
  todayDate,
  initialScrollAnchor,
  restoreFocus = false,
  focusRequestToken = 0,
  onToggleRoom,
  onFocusedCellChange,
  onSelectionChange,
  onPageChange,
  onDateWindowChange,
  onInspectUnit,
  onInspectDay,
  onInspectInterval,
  onClearFilters,
  onScrollAnchorChange
}: RoomStatusGridProps) {
  const isMobile = useRoomStatusMobileViewport();
  const scrollRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerSelection = useRef<{ pointerId: number; unitId: string; anchorDate: string; touch: boolean } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollRestored = useRef(false);
  const focusRestored = useRef(false);
  const lastFocusRequestToken = useRef(focusRequestToken);
  const pendingKeyboardFocus = useRef<RoomStatusCellFocus | null>(null);
  const [touchSelectionMode, setTouchSelectionMode] = useState(false);
  const pageRooms = useMemo(() => board.rooms.slice(0, Math.max(0, board.page.size)), [board.page.size, board.rooms]);
  const filteredRooms = useMemo(() => filterRoomStatusRooms(pageRooms, filters), [filters, pageRooms]);
  const dates = useMemo(
    () => visibleDateWindow(board.dates, dateWindowStart, dateWindowSize),
    [board.dates, dateWindowSize, dateWindowStart]
  );
  const renderedUnits = useMemo<RenderedUnit[]>(() => filteredRooms.flatMap(({ room, children }) => {
    const rows: RenderedUnit[] = [{ unit: room, parent: null, depth: 0 }];
    if (room.salesMode === "BED_SPLIT" && expandedRoomIds.includes(room.id)) {
      rows.push(...children.map((child): RenderedUnit => ({ unit: child, parent: room, depth: 1 })));
    }
    return rows;
  }), [expandedRoomIds, filteredRooms]);
  const positionedByUnit = useMemo(() => new Map(renderedUnits.map(({ unit }) => [unit.id, intervalsForWindow(unit.intervals, dates)])), [dates, renderedUnits]);
  const unitIds = renderedUnits.map(({ unit }) => unit.id);
  const firstCell = unitIds[0] && dates[0] ? { unitId: unitIds[0], serviceDate: dates[0] } : null;
  const effectiveFocus = focusedCell && unitIds.includes(focusedCell.unitId) && dates.includes(focusedCell.serviceDate)
    ? focusedCell
    : firstCell;
  const firstVisibleDate = dates[0];
  const lastVisibleDate = dates.at(-1);
  const clampedWindowStart = board.dates.indexOf(firstVisibleDate ?? "");
  const previousWindowStart = shiftDateWindowStart(board.dates.length, Math.max(0, clampedWindowStart), dateWindowSize, -1);
  const nextWindowStart = shiftDateWindowStart(board.dates.length, Math.max(0, clampedWindowStart), dateWindowSize, 1);

  useEffect(() => {
    scrollRestored.current = false;
    focusRestored.current = false;
    lastFocusRequestToken.current = focusRequestToken;
  }, [board.propertyId]);

  useEffect(() => {
    if (isMobile) return;
    if (scrollRestored.current || !initialScrollAnchor || !scrollRef.current) return;
    scrollRestored.current = true;
    const scroll = scrollRef.current;
    let top = initialScrollAnchor.top;
    if (initialScrollAnchor.unitId) {
      const row = [...scroll.querySelectorAll<HTMLElement>("[data-room-status-row]")]
        .find((candidate) => candidate.dataset.roomStatusRow === initialScrollAnchor.unitId);
      if (row) top = row.offsetTop - 42;
    }
    scroll.scrollTo({ left: initialScrollAnchor.left, top, behavior: "auto" });
  }, [initialScrollAnchor, isMobile]);

  useEffect(() => {
    if (isMobile) return;
    const restorationRequested = restoreFocus && !focusRestored.current;
    const explicitRequest = focusRequestToken !== lastFocusRequestToken.current;
    if ((!restorationRequested && !explicitRequest) || !effectiveFocus) return;
    if (restorationRequested) focusRestored.current = true;
    lastFocusRequestToken.current = focusRequestToken;
    const frame = requestAnimationFrame(() => {
      const cell = cellRefs.current.get(`${effectiveFocus.unitId}:${effectiveFocus.serviceDate}`);
      if (cell) {
        if (!focusedCell
          || focusedCell.unitId !== effectiveFocus.unitId
          || focusedCell.serviceDate !== effectiveFocus.serviceDate) onFocusedCellChange(effectiveFocus);
        cell.focus({ preventScroll: false });
      }
      else scrollRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [effectiveFocus, focusRequestToken, focusedCell, isMobile, onFocusedCellChange, restoreFocus]);

  useEffect(() => {
    if (isMobile || !pendingKeyboardFocus.current) return;
    const pending = pendingKeyboardFocus.current;
    const frame = requestAnimationFrame(() => {
      const cell = cellRefs.current.get(`${pending.unitId}:${pending.serviceDate}`);
      if (!cell) return;
      pendingKeyboardFocus.current = null;
      cell.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [dateWindowStart, dates, isMobile]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const active = pointerSelection.current;
      if (!active || event.pointerId !== active.pointerId) return;
      const pointedElement = document.elementFromPoint(event.clientX, event.clientY);
      const intervalTarget = pointedElement?.closest<HTMLElement>(".room-status-interval") ?? null;
      const directTarget = intervalTarget
        ? null
        : pointedElement?.closest<HTMLElement>("[data-room-status-cell='true']") ?? null;
      const pointedRow = pointedElement?.closest<HTMLElement>("[data-room-status-row]");
      const target = directTarget ?? [...(pointedRow?.querySelectorAll<HTMLElement>("[data-room-status-cell='true']") ?? [])]
        .find((cell) => {
          const bounds = cell.getBoundingClientRect();
          return event.clientX >= bounds.left && event.clientX < bounds.right;
        });
      if (!target || target.dataset.unitId !== active.unitId || !target.dataset.serviceDate) return;
      onSelectionChange(selectionFromCells(active.unitId, active.anchorDate, target.dataset.serviceDate));
    };
    const handlePointerEnd = (event: PointerEvent) => {
      const active = pointerSelection.current;
      if (active?.pointerId !== event.pointerId) return;
      pointerSelection.current = null;
      if (active.touch) setTouchSelectionMode(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [onSelectionChange]);

  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
  }, []);

  if (isMobile) return null;

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>, rowDelta: number, columnDelta: number) => {
    event.preventDefault();
    const current = { unitId: event.currentTarget.dataset.unitId!, serviceDate: event.currentTarget.dataset.serviceDate! };
    const next = moveRoomStatusFocus(unitIds, board.dates, current, rowDelta, columnDelta);
    if (!next) return;
    const targetWindowStart = dateWindowStartForFocus(board.dates, clampedWindowStart, dateWindowSize, next.serviceDate);
    const windowChanges = targetWindowStart !== clampedWindowStart;
    if (windowChanges) {
      pendingKeyboardFocus.current = next;
      onDateWindowChange(targetWindowStart);
    }
    onFocusedCellChange(next);
    if (event.shiftKey) {
      const anchorDate = selection?.unitId === next.unitId ? selection.anchorDate : current.serviceDate;
      onSelectionChange(selectionFromCells(next.unitId, anchorDate, next.serviceDate));
    }
    if (!windowChanges) requestAnimationFrame(() => cellRefs.current.get(`${next.unitId}:${next.serviceDate}`)?.focus());
  };

  const handleCellKeyDown = (event: KeyboardEvent<HTMLDivElement>, unit: RoomStatusUnitDto, day: RoomStatusDayDto | null) => {
    if (event.key === "ArrowLeft") return moveFocus(event, 0, -1);
    if (event.key === "ArrowRight") return moveFocus(event, 0, 1);
    if (event.key === "ArrowUp") return moveFocus(event, -1, 0);
    if (event.key === "ArrowDown") return moveFocus(event, 1, 0);
    if (event.key === "Escape") {
      event.preventDefault();
      onSelectionChange(null);
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      const serviceDate = event.currentTarget.dataset.serviceDate!;
      const anchorDate = event.shiftKey && selection?.unitId === unit.id ? selection.anchorDate : serviceDate;
      onSelectionChange(selectionFromCells(unit.id, anchorDate, serviceDate));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onInspectDay(unit, day);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, unit: RoomStatusUnitDto, serviceDate: string) => {
    if (event.button !== 0) return;
    const touch = event.pointerType === "touch";
    if (touch && !touchSelectionMode) return;
    event.preventDefault();
    pointerSelection.current = { pointerId: event.pointerId, unitId: unit.id, anchorDate: serviceDate, touch };
    onFocusedCellChange({ unitId: unit.id, serviceDate });
    onSelectionChange(selectionFromCells(unit.id, serviceDate, serviceDate));
    event.currentTarget.focus();
  };

  const handleScroll = () => {
    if (!scrollRef.current || !onScrollAnchorChange || scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const scroll = scrollRef.current;
      if (!scroll) return;
      const firstVisibleRow = [...scroll.querySelectorAll<HTMLElement>("[data-room-status-row]")]
        .find((row) => row.offsetTop + row.offsetHeight > scroll.scrollTop + 42);
      onScrollAnchorChange({
        unitId: firstVisibleRow?.dataset.roomStatusRow ?? null,
        left: scroll.scrollLeft,
        top: scroll.scrollTop
      });
    });
  };

  if (!dates.length) {
    return (
      <section className="room-status-grid-empty" aria-labelledby="room-status-no-dates">
        <Layers3 aria-hidden="true" size={22} />
        <h2 id="room-status-no-dates">当前查询没有逐日房态</h2>
        <p>请选择至少一个住宿夜，并重新查询服务端房态。</p>
      </section>
    );
  }

  if (!renderedUnits.length) {
    const filtered = hasActiveRoomStatusFilters(filters);
    return (
      <section
        className="room-status-grid-empty"
        aria-labelledby="room-status-no-rooms"
        data-room-status-state={filtered ? "filtered-empty" : "empty"}
      >
        <SearchX aria-hidden="true" size={22} />
        <h2 id="room-status-no-rooms">{filtered ? "没有符合筛选的房间" : "当前页没有库存单元"}</h2>
        <p>{filtered ? "调整筛选条件，或清除筛选查看当前页的全部房间。" : "可切换房间分页或刷新房态。"}</p>
        {filtered ? <button type="button" className="room-status-button" onClick={onClearFilters}>清除筛选</button> : null}
      </section>
    );
  }

  const gridStyle = {
    "--room-status-date-count": dates.length,
    "--room-status-interval-lanes": 1
  } as CSSProperties;

  return (
    <section
      className={`room-status-grid-section${touchSelectionMode ? " is-touch-selection" : ""}`}
      aria-labelledby="room-status-grid-heading"
      data-testid="room-status-board-range"
      data-range-arrival={board.range.arrivalDate}
      data-range-departure={board.range.departureDate}
    >
      <header className="room-status-grid-section-header">
        <div>
          <h2 id="room-status-grid-heading">房间与床位逐日房态</h2>
          <p>{formatRoomStatusDate(firstVisibleDate!)}至{formatRoomStatusDate(addLocalDateDays(lastVisibleDate!, 1))}，日期为半开区间</p>
        </div>
        <div className="room-status-window-controls" aria-label="可见日期窗口">
          <button
            type="button"
            className="room-status-button room-status-button-secondary room-status-touch-selection-toggle"
            aria-pressed={touchSelectionMode}
            onClick={() => setTouchSelectionMode((enabled) => !enabled)}
          >
            <Hand aria-hidden="true" size={16} />{touchSelectionMode ? "正在选择" : "触控选区"}
          </button>
          <button
            type="button"
            className="room-status-icon-button"
            aria-label="向前移动可见日期"
            title="向前移动可见日期"
            disabled={previousWindowStart === Math.max(0, clampedWindowStart)}
            onClick={() => onDateWindowChange(previousWindowStart)}
          >
            <ChevronsLeft aria-hidden="true" size={17} />
          </button>
          <span>{dates.length} 夜</span>
          <button
            type="button"
            className="room-status-icon-button"
            aria-label="向后移动可见日期"
            title="向后移动可见日期"
            disabled={nextWindowStart === Math.max(0, clampedWindowStart)}
            onClick={() => onDateWindowChange(nextWindowStart)}
          >
            <ChevronsRight aria-hidden="true" size={17} />
          </button>
        </div>
      </header>

      {board.projectionState === "PARTIAL" ? (
        <div className="room-status-grid-notice" role="status">
          <RoomStatusWarning>投影不完整。页面保留已返回事实，但不能把缺失内容解释为可售。</RoomStatusWarning>
        </div>
      ) : null}

      <div
        className="room-status-grid-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="region"
        aria-label="房态二维网格，可使用方向键移动，Shift 加方向键扩展选区"
        tabIndex={0}
      >
        <div className="room-status-grid" role="grid" aria-rowcount={renderedUnits.length + 1} aria-colcount={dates.length + 1} style={gridStyle}>
          <div className="room-status-grid-header" role="row">
            <div className="room-status-resource-header" role="columnheader">房源</div>
            <div className="room-status-date-header-track" role="presentation">
              {dates.map((date) => {
                const parsed = new Date(`${date}T00:00:00Z`);
                const weekDay = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(parsed);
                return (
                  <div key={date} className={`room-status-date-header${date === todayDate ? " is-today" : ""}`} role="columnheader" aria-label={`${formatRoomStatusDate(date)} ${weekDay}`}>
                    <strong>{date.slice(5)}</strong>
                    <span>{date === todayDate ? "今天" : weekDay}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {renderedUnits.map(({ unit, depth }, rowIndex) => {
            const canExpand = depth === 0 && unit.salesMode === "BED_SPLIT" && unit.children.length > 0;
            const expanded = canExpand && expandedRoomIds.includes(unit.id);
            const positionedIntervals = positionedByUnit.get(unit.id) ?? [];
            const intervalsByStartColumn = new Map<number, typeof positionedIntervals>();
            for (const positioned of positionedIntervals) {
              const intervals = intervalsByStartColumn.get(positioned.startColumn) ?? [];
              intervals.push(positioned);
              intervalsByStartColumn.set(positioned.startColumn, intervals);
            }
            const rowLanes = Math.max(1, ...positionedIntervals.map((item) => item.lane + 1));
            return (
              <div
                className={`room-status-grid-row room-status-grid-row-depth-${depth}`}
                role="row"
                key={unit.id}
                data-room-status-row={unit.id}
                aria-rowindex={rowIndex + 2}
                style={{ "--room-status-interval-lanes": rowLanes } as CSSProperties}
              >
                <div className="room-status-resource-cell" role="rowheader">
                  {canExpand ? (
                    <button
                      type="button"
                      className="room-status-expand-button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "收起" : "展开"}${unit.name}床位`}
                      title={`${expanded ? "收起" : "展开"}床位`}
                      onClick={() => onToggleRoom(unit.id)}
                    >
                      {expanded ? <ChevronDown aria-hidden="true" size={17} /> : <ChevronRight aria-hidden="true" size={17} />}
                    </button>
                  ) : <span className="room-status-expand-spacer" aria-hidden="true" />}
                  <button type="button" className="room-status-resource-detail" onClick={() => onInspectUnit(unit)}>
                    <strong>{unit.code}</strong>
                    <span>{unit.name}</span>
                    <small>{rowDescription(unit)}</small>
                  </button>
                </div>
                <div className="room-status-day-track" role="presentation">
                  {dates.map((date, columnIndex) => {
                    const day = dayFor(unit, date);
                    const status = day?.status ?? "UNKNOWN";
                    const selected = isCellSelected(selection, unit.id, date);
                    const focusable = effectiveFocus?.unitId === unit.id && effectiveFocus.serviceDate === date;
                    const startingIntervals = intervalsByStartColumn.get(columnIndex) ?? [];
                    return (
                      <div
                        role="gridcell"
                        aria-rowindex={rowIndex + 2}
                        aria-colindex={columnIndex + 2}
                        aria-selected={selected}
                        aria-label={cellAccessibleName(unit, date, day)}
                        tabIndex={focusable ? 0 : -1}
                        key={date}
                        data-room-status-cell="true"
                        data-unit-id={unit.id}
                        data-service-date={date}
                        className={`room-status-day-cell room-status-day-${status.toLowerCase().replaceAll("_", "-")}${selected ? " is-selected" : ""}${date === todayDate ? " is-today" : ""}${!day?.available ? " is-authoritatively-unavailable" : ""}${day?.conflicts.length ? " has-blocking-conflict" : ""}${startingIntervals.length ? " has-source-interval" : ""}`}
                        ref={(node) => {
                          const key = `${unit.id}:${date}`;
                          if (node) cellRefs.current.set(key, node);
                          else cellRefs.current.delete(key);
                        }}
                        onFocus={() => onFocusedCellChange({ unitId: unit.id, serviceDate: date })}
                        onPointerDown={(event) => handlePointerDown(event, unit, date)}
                        onDoubleClick={() => onInspectDay(unit, day)}
                        onKeyDown={(event) => handleCellKeyDown(event, unit, day)}
                      >
                        <RoomStatusMark status={status} compact />
                        {day?.conflicts.length ? <span className="room-status-cell-conflict">{day.conflicts.length} 个阻断</span> : null}
                        {startingIntervals.map(({ interval, startColumn, endColumn, lane }) => (
                          <button
                            key={interval.id}
                            type="button"
                            className={`room-status-interval room-status-interval-${interval.status.toLowerCase().replaceAll("_", "-")}${interval.blocking ? " is-blocking" : ""}${interval.conflicts.length ? " has-blocking-conflict" : ""}`}
                            style={{ left: 0, width: `${(endColumn - startColumn) * 100}%`, top: `calc(5px + ${lane} * 25px)` }}
                            aria-label={`${interval.label}，${roomStatusSourceLabels[interval.sourceKind]}${interval.primaryOccupantLabel ? `，主要居住人 ${interval.primaryOccupantLabel}` : ""}，${formatRoomStatusDate(interval.startDate)}至${formatRoomStatusDate(interval.endDate)}，${roomStatusPresentation[interval.status].label}${interval.blocking ? "，阻断库存" : "，不阻断库存"}${interval.conflicts.length ? `，${interval.conflicts.length} 个阻断冲突` : ""}`}
                            title={`${roomStatusSourceLabels[interval.sourceKind]} · ${interval.label}`}
                            onPointerDown={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                            onClick={() => onInspectInterval(unit, interval)}
                          >
                            <span>{interval.primaryOccupantLabel ?? interval.label}</span>
                            <small>{roomStatusSourceLabels[interval.sourceKind]} · {interval.label}</small>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="room-status-grid-footer">
        <span>当前第 {board.page.index + 1} / {Math.max(1, board.page.totalPages)} 页，共 {board.page.totalRooms} 间房</span>
        <div aria-label="房间分页">
          <button
            type="button"
            className="room-status-button room-status-button-secondary"
            disabled={board.page.index <= 0}
            onClick={() => onPageChange(Math.max(0, board.page.index - 1))}
          >
            <ChevronLeft aria-hidden="true" size={16} />上一页
          </button>
          <button
            type="button"
            className="room-status-button room-status-button-secondary"
            disabled={board.page.index >= board.page.totalPages - 1}
            onClick={() => onPageChange(Math.min(Math.max(0, board.page.totalPages - 1), board.page.index + 1))}
          >
            下一页<ChevronRight aria-hidden="true" size={16} />
          </button>
        </div>
      </footer>
    </section>
  );
}
