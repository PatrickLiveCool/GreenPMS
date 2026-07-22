import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarRange,
  Clock3,
  ExternalLink,
  History,
  Layers3,
  ReceiptText,
  ShieldAlert
} from "lucide-react";
import type {
  RoomStatusActionDto,
  RoomStatusBoardDto,
  RoomStatusConflictDto,
  RoomStatusDayDto,
  RoomStatusIntervalDto,
  RoomStatusReferenceDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import { selectionFromInputs, type RoomStatusSelection } from "./roomStatusState";
import {
  formatRoomStatusDate,
  formatRoomStatusDateTime,
  roomStatusActionLabels,
  roomStatusBlockingFactLabels,
  roomStatusSourceLabels,
  RoomStatusMark,
  RoomStatusWarning
} from "./roomStatusPresentation";

export interface RoomStatusContextProps {
  board: RoomStatusBoardDto;
  selectedUnit: RoomStatusUnitDto | null;
  selectedDay: RoomStatusDayDto | null;
  selectedInterval: RoomStatusIntervalDto | null;
  relatedIntervals: readonly RoomStatusIntervalDto[];
  selection: RoomStatusSelection | null;
  conflicts: readonly RoomStatusConflictDto[];
  allowedActions: readonly RoomStatusActionDto[];
  onSelectedUnitChange: (unit: RoomStatusUnitDto) => void;
  onSelectionChange: (selection: RoomStatusSelection | null) => void;
  onOpenReference: (reference: RoomStatusReferenceDto) => void;
  onOpenReceipt: (receiptId: string) => void;
  onAction: (action: RoomStatusActionDto) => void;
}

interface SelectionDraft {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
}

function flattenUnits(rooms: readonly RoomStatusUnitDto[]): RoomStatusUnitDto[] {
  return rooms.flatMap((room) => room.salesMode === "BED_SPLIT" ? [room, ...room.children] : [room]);
}

function unitOptionLabel(unit: RoomStatusUnitDto): string {
  const kind = unit.kind === "ROOM" ? "房间" : "床位";
  return `${unit.code} · ${unit.name}（${kind}）`;
}

function ReferenceList({ references, onOpen }: { references: readonly RoomStatusReferenceDto[]; onOpen: (reference: RoomStatusReferenceDto) => void }) {
  if (!references.length) return <p className="room-status-context-empty">当前获权视图没有对象引用。</p>;
  return (
    <ul className="room-status-reference-list">
      {references.map((reference) => (
        <li key={`${reference.type}:${reference.id}`}>
          {reference.href ? (
            <button type="button" onClick={() => onOpen(reference)}>
              <span><strong>{reference.label}</strong><small>{reference.type}</small></span>
              <code>{reference.id}</code>
              <ExternalLink aria-hidden="true" size={15} />
            </button>
          ) : (
            <div className="room-status-reference-static">
              <span><strong>{reference.label}</strong><small>{reference.type}</small></span>
              <code>{reference.id}</code>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ConflictList({ conflicts, onOpenReference }: { conflicts: readonly RoomStatusConflictDto[]; onOpenReference: (reference: RoomStatusReferenceDto) => void }) {
  if (!conflicts.length) return <p className="room-status-context-empty">服务端没有返回阻断冲突。</p>;
  return (
    <ul className="room-status-conflict-list">
      {conflicts.map((conflict) => (
        <li key={conflict.id}>
          <div>
            <AlertTriangle aria-hidden="true" size={17} />
            <strong>{conflict.reason}</strong>
            <span>{formatRoomStatusDate(conflict.startDate)}至{formatRoomStatusDate(conflict.endDate)}</span>
          </div>
          <dl>
            <dt>请求 / 实际库存</dt>
            <dd><code>{conflict.requestedInventoryUnitId}</code><span> / </span><code>{conflict.actualInventoryUnitId}</code></dd>
            <dt>阻断事实</dt>
            <dd>{roomStatusBlockingFactLabels[conflict.blockingFactKind]}</dd>
            <dt>Claim</dt>
            <dd>{conflict.claimIds.length ? conflict.claimIds.map((claimId) => <code key={claimId}>{claimId} </code>) : "不适用"}</dd>
            <dt>来源</dt>
            <dd>{roomStatusSourceLabels[conflict.sourceKind]}</dd>
          </dl>
          {conflict.sourceReference.href ? (
            <button type="button" className="room-status-text-button" onClick={() => onOpenReference(conflict.sourceReference)}>
              查看 {conflict.sourceReference.label}<ArrowRight aria-hidden="true" size={15} />
            </button>
          ) : (
            <div className="room-status-conflict-source-static">
              <span>{conflict.sourceReference.label}</span>
              <code>{conflict.sourceReference.id}</code>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RoomStatusContext({
  board,
  selectedUnit,
  selectedDay,
  selectedInterval,
  relatedIntervals,
  selection,
  conflicts,
  allowedActions,
  onSelectedUnitChange,
  onSelectionChange,
  onOpenReference,
  onOpenReceipt,
  onAction
}: RoomStatusContextProps) {
  const units = useMemo(() => flattenUnits(board.rooms), [board.rooms]);
  const dateErrorId = useId();
  const dateErrorRef = useRef<HTMLDivElement>(null);
  const initialUnitId = selection?.unitId ?? selectedUnit?.id ?? "";
  const [draft, setDraft] = useState<SelectionDraft>({
    unitId: initialUnitId,
    arrivalDate: selection?.arrivalDate ?? "",
    departureDate: selection?.departureDate ?? ""
  });

  useEffect(() => {
    setDraft({
      unitId: selection?.unitId ?? selectedUnit?.id ?? "",
      arrivalDate: selection?.arrivalDate ?? "",
      departureDate: selection?.departureDate ?? ""
    });
  }, [selectedUnit?.id, selection?.arrivalDate, selection?.departureDate, selection?.unitId]);

  const candidateDraftSelection = selectionFromInputs(draft.unitId, draft.arrivalDate, draft.departureDate);
  const draftDateError = draft.arrivalDate && draft.departureDate
    ? !candidateDraftSelection
      ? "退房日期必须晚于入住日期。"
      : candidateDraftSelection.arrivalDate < board.range.arrivalDate
        || candidateDraftSelection.departureDate > board.range.departureDate
        ? `日期必须位于当前房态查询区间 [${board.range.arrivalDate}, ${board.range.departureDate}) 内。`
        : undefined
    : undefined;
  const draftSelection = draftDateError ? null : candidateDraftSelection;
  const contextIntervals = useMemo(() => {
    const intervals = selectedInterval ? [selectedInterval, ...relatedIntervals] : [...relatedIntervals];
    return [...new Map(intervals.map((interval) => [interval.id, interval])).values()];
  }, [relatedIntervals, selectedInterval]);
  const references = useMemo(() => [...new Map(contextIntervals
    .flatMap((interval) => interval.references)
    .map((reference) => [`${reference.type}:${reference.id}`, reference])).values()], [contextIntervals]);
  const histories = useMemo(() => [...new Map(contextIntervals
    .flatMap((interval) => interval.history)
    .map((item) => [`${item.occurredAt}:${item.commandId ?? "none"}:${item.receiptId ?? "none"}:${item.action}`, item])).values()]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)), [contextIntervals]);
  const status = selectedInterval?.status ?? selectedDay?.status;
  const contextTitle = selectedInterval?.label ?? selectedUnit?.name ?? "尚未选择房源";

  const changeUnit = (unitId: string) => {
    setDraft((current) => ({ ...current, unitId }));
    const unit = units.find((candidate) => candidate.id === unitId);
    if (unit) onSelectedUnitChange(unit);
  };

  const applyDraftSelection = () => {
    if (draftSelection) {
      onSelectionChange(draftSelection);
      return;
    }
    dateErrorRef.current?.focus();
  };

  return (
    <aside className="room-status-context" aria-labelledby="room-status-context-heading">
      <header className="room-status-context-header">
        <div>
          <span>选中对象上下文</span>
          <h2 id="room-status-context-heading">{contextTitle}</h2>
        </div>
        {status ? <RoomStatusMark status={status} /> : null}
      </header>

      <section className="room-status-selection-editor" aria-labelledby="room-status-selection-heading">
        <div className="room-status-context-section-heading">
          <CalendarRange aria-hidden="true" size={17} />
          <h3 id="room-status-selection-heading">日期选区</h3>
        </div>
        <p>拖选的等价输入。应用后只更新本地半开区间，不创建订单、Claim 或 Block。</p>
        <label>房间或床位
          <select data-testid="room-status-unit-select" value={draft.unitId} onChange={(event) => changeUnit(event.target.value)}>
            <option value="">请选择房源</option>
            {units.map((unit) => <option key={unit.id} value={unit.id}>{unitOptionLabel(unit)}</option>)}
          </select>
        </label>
        <div className="room-status-date-inputs">
          <label>入住日期
            <input
              type="date"
              value={draft.arrivalDate}
              min={board.range.arrivalDate}
              max={board.range.departureDate}
              aria-invalid={draftDateError ? "true" : undefined}
              aria-describedby={draftDateError ? dateErrorId : undefined}
              onChange={(event) => setDraft((current) => ({ ...current, arrivalDate: event.target.value }))}
            />
          </label>
          <label>退房日期
            <input
              type="date"
              value={draft.departureDate}
              min={draft.arrivalDate || board.range.arrivalDate}
              max={board.range.departureDate}
              aria-invalid={draftDateError ? "true" : undefined}
              aria-describedby={draftDateError ? dateErrorId : undefined}
              onChange={(event) => setDraft((current) => ({ ...current, departureDate: event.target.value }))}
            />
          </label>
        </div>
        <div className="room-status-selection-actions">
          <button type="button" className="room-status-button room-status-button-secondary" disabled={!selection} onClick={() => onSelectionChange(null)}>清除选区</button>
          <button
            type="button"
            className="room-status-button"
            disabled={!draft.unitId || !draft.arrivalDate || !draft.departureDate}
            onClick={applyDraftSelection}
          >应用选区</button>
        </div>
        {draftDateError ? (
          <div
            id={dateErrorId}
            ref={dateErrorRef}
            className="room-status-field-error-summary"
            role="alert"
            tabIndex={-1}
            data-testid="room-status-selection-date-error"
          >
            <RoomStatusWarning>{draftDateError}</RoomStatusWarning>
          </div>
        ) : null}
      </section>

      {selectedUnit ? (
        <section className="room-status-context-section" aria-labelledby="room-status-unit-heading">
          <div className="room-status-context-section-heading">
            <Layers3 aria-hidden="true" size={17} />
            <h3 id="room-status-unit-heading">库存单元</h3>
          </div>
          <dl className="room-status-context-facts">
            <dt>稳定 ID</dt><dd><code>{selectedUnit.id}</code></dd>
            <dt>房号 / 名称</dt><dd>{selectedUnit.code} · {selectedUnit.name}</dd>
            <dt>粒度</dt><dd>{selectedUnit.kind === "ROOM" ? "房间" : "床位"}</dd>
            <dt>销售模式</dt><dd>{selectedUnit.salesMode === "WHOLE_ROOM" ? "整房销售" : selectedUnit.salesMode === "BED_SPLIT" ? "拆床销售" : "不可售"}</dd>
            <dt>房型 / 产品</dt><dd>{selectedUnit.roomTypeCode ?? "未记录"} · {selectedUnit.pricingProductCode ?? "未记录"}</dd>
            <dt>容纳人数</dt><dd>{selectedUnit.capacity}</dd>
          </dl>
        </section>
      ) : null}

      {selectedInterval ? (
        <section className="room-status-context-section" aria-labelledby="room-status-source-heading">
          <div className="room-status-context-section-heading">
            <ShieldAlert aria-hidden="true" size={17} />
            <h3 id="room-status-source-heading">来源事实</h3>
          </div>
          <dl className="room-status-context-facts">
            <dt>区间 ID</dt><dd><code>{selectedInterval.id}</code></dd>
            <dt>来源类型</dt><dd>{roomStatusSourceLabels[selectedInterval.sourceKind]}</dd>
            <dt>主要居住人</dt><dd>{selectedInterval.primaryOccupantLabel ?? "不适用"}</dd>
            <dt>当前窗口区间</dt><dd><code>[{selectedInterval.startDate}, {selectedInterval.endDate})</code></dd>
            <dt>来源完整区间</dt><dd><code>[{selectedInterval.sourceStartDate}, {selectedInterval.sourceEndDate})</code></dd>
            <dt>显示 / 实际库存</dt><dd><code>{selectedInterval.displayInventoryUnitId}</code><span> / </span><code>{selectedInterval.actualInventoryUnitId}</code></dd>
            <dt>是否阻断</dt><dd>{selectedInterval.blocking ? "是" : "否"}</dd>
            <dt>原因</dt><dd>{selectedInterval.reason ?? "未提供原因"}</dd>
            <dt>Claim</dt><dd>{selectedInterval.claimIds.length ? selectedInterval.claimIds.map((id) => <code key={id}>{id} </code>) : "无"}</dd>
          </dl>
          <ReferenceList references={references} onOpen={onOpenReference} />
        </section>
      ) : selectedDay ? (
        <section className="room-status-context-section" aria-labelledby="room-status-day-heading">
          <div className="room-status-context-section-heading">
            <Clock3 aria-hidden="true" size={17} />
            <h3 id="room-status-day-heading">逐日事实</h3>
          </div>
          <dl className="room-status-context-facts">
            <dt>日期</dt><dd>{selectedDay.serviceDate}</dd>
            <dt>服务端状态</dt><dd><RoomStatusMark status={selectedDay.status} compact /></dd>
            <dt>服务端可售</dt><dd>{selectedDay.available ? "是" : "否"}</dd>
            <dt>连续区间</dt><dd>{selectedDay.intervalIds.length ? selectedDay.intervalIds.map((id) => <code key={id}>{id} </code>) : "无"}</dd>
          </dl>
        </section>
      ) : null}

      {!selectedInterval && contextIntervals.length ? (
        <section className="room-status-context-section" aria-labelledby="room-status-related-sources-heading">
          <div className="room-status-context-section-heading">
            <ShieldAlert aria-hidden="true" size={17} />
            <h3 id="room-status-related-sources-heading">选区关联来源事实</h3>
          </div>
          <ol className="room-status-related-source-list">
            {contextIntervals.map((interval) => (
              <li key={interval.id}>
                <strong>{roomStatusSourceLabels[interval.sourceKind]} · {interval.label}</strong>
                <dl className="room-status-context-facts">
                  <dt>区间 ID</dt><dd><code>{interval.id}</code></dd>
                  <dt>来源类型</dt><dd>{interval.sourceKind}</dd>
                  <dt>来源完整区间</dt><dd><code>[{interval.sourceStartDate}, {interval.sourceEndDate})</code></dd>
                  <dt>显示 / 实际库存</dt><dd><code>{interval.displayInventoryUnitId}</code><span> / </span><code>{interval.actualInventoryUnitId}</code></dd>
                  <dt>Claim</dt><dd>{interval.claimIds.length ? interval.claimIds.map((id) => <code key={id}>{id} </code>) : "无"}</dd>
                </dl>
              </li>
            ))}
          </ol>
          <ReferenceList references={references} onOpen={onOpenReference} />
        </section>
      ) : null}

      <section className="room-status-context-section" aria-labelledby="room-status-conflicts-heading">
        <div className="room-status-context-section-heading">
          <AlertTriangle aria-hidden="true" size={17} />
          <h3 id="room-status-conflicts-heading">精确冲突</h3>
        </div>
        <ConflictList conflicts={conflicts} onOpenReference={onOpenReference} />
      </section>

      {contextIntervals.length ? (
        <section className="room-status-context-section" aria-labelledby="room-status-history-heading">
          <div className="room-status-context-section-heading">
            <History aria-hidden="true" size={17} />
            <h3 id="room-status-history-heading">事实历史</h3>
          </div>
          {histories.length ? (
            <ol className="room-status-history-list">
              {histories.map((item, index) => (
                <li key={`${item.occurredAt}:${item.commandId ?? index}`}>
                  <strong>{item.action}</strong>
                  <span>{formatRoomStatusDateTime(item.occurredAt)} · {item.source} · actor {item.actorId ?? "已脱敏 / 未记录"}</span>
                  <dl>
                    <dt>Command</dt><dd><code>{item.commandId ?? "无"}</code></dd>
                    <dt>Correlation</dt><dd><code>{item.correlationId ?? "无"}</code></dd>
                    <dt>Receipt</dt>
                    <dd>{item.receiptId ? (
                      <button
                        type="button"
                        className="room-status-inline-reference"
                        aria-label={`Receipt ${item.receiptId}`}
                        onClick={() => onOpenReceipt(item.receiptId!)}
                      >
                        <ReceiptText aria-hidden="true" size={14} /><code>{item.receiptId}</code>
                      </button>
                    ) : "无"}</dd>
                  </dl>
                </li>
              ))}
            </ol>
          ) : <p className="room-status-context-empty">当前获权视图没有历史记录。</p>}
        </section>
      ) : null}

      <section className="room-status-context-actions" aria-labelledby="room-status-actions-heading">
        <div className="room-status-context-section-heading">
          <ArrowRight aria-hidden="true" size={17} />
          <h3 id="room-status-actions-heading">服务端允许动作</h3>
        </div>
        {allowedActions.length ? (
          <ul>
            {allowedActions.map((action) => (
              <li key={`${action.code}:${action.targetReference?.type ?? "none"}:${action.targetReference?.id ?? "none"}`}>
                <button type="button" className="room-status-button" disabled={!action.enabled} onClick={() => onAction(action)}>
                  {roomStatusActionLabels[action.code]}<ArrowRight aria-hidden="true" size={16} />
                </button>
                {action.requiresFullInterval ? <small>只允许针对完整有效区间执行。</small> : null}
                {!action.enabled && action.disabledReason ? <small className="room-status-action-disabled"><AlertTriangle aria-hidden="true" size={14} />{action.disabledReason}</small> : null}
              </li>
            ))}
          </ul>
        ) : <p className="room-status-context-empty">服务端未为当前对象下发可执行动作。</p>}
      </section>

      <footer className="room-status-context-freshness">
        <Clock3 aria-hidden="true" size={15} />
        <span>数据时点 {formatRoomStatusDateTime(board.asOf)}</span>
        <span>有效至 {formatRoomStatusDateTime(board.freshUntil)}</span>
        <code>{board.revision}</code>
      </footer>
    </aside>
  );
}
