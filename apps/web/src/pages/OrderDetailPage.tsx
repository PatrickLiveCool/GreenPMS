import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRightLeft,
  Calculator,
  CalendarMinus2,
  CalendarPlus2,
  CircleDollarSign,
  LogIn,
  LogOut,
  RotateCcw,
  Undo2,
  UserX,
  XCircle
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CommandType } from "@qintopia/contracts";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { CollectionFactDto, CommandRequest, OrderViewDto } from "../types";
import {
  CommandDialog,
  EmptyState,
  formatDate,
  formatDateTime,
  formatMinor,
  formatMoney,
  guestName,
  InlineError,
  LoadingBlock,
  Modal,
  StatusBadge
} from "../ui";

type FormAction = "RECORD_COLLECTION" | "RECORD_REFUND" | "SHORTEN_STAY" | "EXTEND_STAY" | "MOVE_UNIT" | "REPRICE_ORDER" | "REVERSE_FACT";

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const formTitles: Record<FormAction, string> = {
  RECORD_COLLECTION: "记录收款事实",
  RECORD_REFUND: "引用原收款退款",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "续住",
  MOVE_UNIT: "换房",
  REPRICE_ORDER: "手工调价",
  REVERSE_FACT: "冲销事实"
};

function ActionFormDialog({ action, view, initialFactId, onClose, onSubmit }: {
  action: FormAction;
  view: OrderViewDto;
  initialFactId?: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const { meta } = useWorkspace();
  const collections = view.collectionFacts.filter((fact) => fact.fact_type === "COLLECTION");
  const reversibleFacts = view.collectionFacts.filter((fact) => fact.fact_type !== "REVERSAL" && !view.collectionFacts.some((candidate) => candidate.reverses_fact_id === fact.fact_id));
  const currentUnit = meta.inventoryUnits.find((unit) => unit.id === view.currentSegment.inventoryUnitId);
  const moveCandidates = meta.inventoryUnits.filter((unit) => (
    unit.property_id === view.order.property_id
    && unit.id !== view.currentSegment.inventoryUnitId
    && (!view.order.member_contract_id || unit.kind === currentUnit?.kind)
  ));
  const [amountMinor, setAmountMinor] = useState(action === "RECORD_REFUND" ? "3000" : "6000");
  const [method, setMethod] = useState("CASH");
  const [note, setNote] = useState("");
  const [factId, setFactId] = useState(initialFactId ?? (action === "REVERSE_FACT" ? reversibleFacts[0]?.fact_id : collections[0]?.fact_id) ?? "");
  const [newDepartureDate, setNewDepartureDate] = useState(action === "SHORTEN_STAY" ? shiftDate(view.order.departure_date, -1) : shiftDate(view.order.departure_date, 1));
  const [newUnitId, setNewUnitId] = useState(moveCandidates[0]?.id ?? "");
  const [effectiveDate, setEffectiveDate] = useState(view.order.arrival_date);
  const [manualAdjustmentMinor, setManualAdjustmentMinor] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const base: Record<string, unknown> = { propertyId: view.order.property_id, orderId: view.order.id };
    let description = "服务端将重新校验订单版本与操作影响。";
    if (action === "RECORD_COLLECTION") Object.assign(base, { amountMinor: Number(amountMinor), method, note });
    if (action === "RECORD_REFUND") {
      Object.assign(base, { amountMinor: Number(amountMinor), referencesFactId: factId, method, note });
      description = "退款事实必须引用同订单的一笔原收款，服务端将校验可退上限。";
    }
    if (action === "REVERSE_FACT") Object.assign(base, { reversesFactId: factId, note });
    if (action === "SHORTEN_STAY" || action === "EXTEND_STAY") {
      Object.assign(base, { newDepartureDate });
      if (manualAdjustmentMinor !== "") base.manualAdjustmentMinor = Number(manualAdjustmentMinor);
      description = "服务端使用订单锁定的政策版本重算，并追加 amendment 与 pricing revision。";
    }
    if (action === "MOVE_UNIT") {
      Object.assign(base, { newInventoryUnitId: newUnitId, effectiveDate });
      if (manualAdjustmentMinor !== "") base.manualAdjustmentMinor = Number(manualAdjustmentMinor);
      description = "服务端重新校验目标库存并使用成交时锁定政策重算。";
    }
    if (action === "REPRICE_ORDER") {
      Object.assign(base, { manualAdjustmentMinor: Number(manualAdjustmentMinor) });
      description = "服务端使用订单锁定的政策版本重算并追加单一 pricing revision；后续 revision 不会自动继承本次调整。";
    }
    onSubmit({ commandType: action, title: formTitles[action], description, input: base });
  }

  return (
    <Modal title={formTitles[action]} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        {(action === "RECORD_COLLECTION" || action === "RECORD_REFUND") ? (
          <div className="form-grid form-grid-two">
            {action === "RECORD_REFUND" ? <label className="span-two">引用原收款<select value={factId} onChange={(event) => setFactId(event.target.value)} required>{collections.map((fact) => <option key={fact.fact_id} value={fact.fact_id}>{fact.fact_id} · {formatMinor(fact.amount_minor, fact.currency)} · {fact.method}</option>)}</select></label> : null}
            <label>金额（最小货币单位）<input type="number" min="1" step="1" value={amountMinor} onChange={(event) => setAmountMinor(event.target.value)} required inputMode="numeric" data-testid="fact-amount-minor" /></label>
            <label>方式<select value={method} onChange={(event) => setMethod(event.target.value)}><option value="CASH">CASH</option><option value="BANK_TRANSFER">BANK TRANSFER</option><option value="CARD">CARD</option><option value="OTHER">OTHER</option></select></label>
            <label className="span-two">备注<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></label>
          </div>
        ) : null}
        {(action === "SHORTEN_STAY" || action === "EXTEND_STAY") ? (
          <div className="form-grid">
            <label>新离店日期<input type="date" value={newDepartureDate} min={view.order.arrival_date} onChange={(event) => setNewDepartureDate(event.target.value)} required data-testid="new-departure-date" /></label>
            <label>本 revision 手工调整（最小货币单位）<input type="number" step="1" value={manualAdjustmentMinor} onChange={(event) => setManualAdjustmentMinor(event.target.value)} placeholder="0" inputMode="numeric" /></label>
          </div>
        ) : null}
        {action === "MOVE_UNIT" ? (
          <div className="form-grid form-grid-two">
            <label>目标库存<select value={newUnitId} onChange={(event) => setNewUnitId(event.target.value)} required data-testid="move-unit-id">{moveCandidates.map((unit) => <option key={unit.id} value={unit.id}>{unit.code} · {unit.name} · {unit.kind}</option>)}</select></label>
            <label>生效日期<input type="date" min={view.order.arrival_date} max={shiftDate(view.order.departure_date, -1)} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} required data-testid="move-effective-date" /></label>
            <label className="span-two">本 revision 手工调整（最小货币单位）<input type="number" step="1" value={manualAdjustmentMinor} onChange={(event) => setManualAdjustmentMinor(event.target.value)} placeholder="0" inputMode="numeric" /></label>
          </div>
        ) : null}
        {action === "REPRICE_ORDER" ? (
          <div className="form-grid">
            <label>本 revision 手工调整（最小货币单位）<input type="number" step="1" value={manualAdjustmentMinor} onChange={(event) => setManualAdjustmentMinor(event.target.value)} required inputMode="numeric" data-testid="reprice-adjustment-minor" /></label>
          </div>
        ) : null}
        {action === "REVERSE_FACT" ? (
          <div className="form-grid"><label>冲销事实<select value={factId} onChange={(event) => setFactId(event.target.value)} required>{reversibleFacts.map((fact) => <option key={fact.fact_id} value={fact.fact_id}>{fact.fact_id} · {fact.fact_type} · {formatMinor(fact.amount_minor, fact.currency)}</option>)}</select></label><label>冲销备注<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} required maxLength={1000} /></label></div>
        ) : null}
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">继续生成 Preview</button></div>
      </form>
    </Modal>
  );
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return <details className="table-details"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function FactActions({ fact, canReverse, onRefund, onReverse }: { fact: CollectionFactDto; canReverse: boolean; onRefund: () => void; onReverse: () => void }) {
  return (
    <div className="row-actions">
      {fact.fact_type === "COLLECTION" ? <button className="icon-button" type="button" onClick={onRefund} title="引用退款" aria-label={`引用事实 ${fact.fact_id} 退款`}><Undo2 aria-hidden="true" size={16} /></button> : null}
      {canReverse ? <button className="icon-button" type="button" onClick={onReverse} title="冲销" aria-label={`冲销事实 ${fact.fact_id}`}><RotateCcw aria-hidden="true" size={16} /></button> : null}
    </div>
  );
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { meta, propertyId } = useWorkspace();
  const [view, setView] = useState<OrderViewDto>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [formAction, setFormAction] = useState<FormAction>();
  const [initialFactId, setInitialFactId] = useState<string>();
  const [command, setCommand] = useState<CommandRequest>();
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!orderId) return;
    let current = true;
    setLoading(true);
    setError(undefined);
    api.order(orderId)
      .then((response) => current && setView(response))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [orderId, refreshToken]);

  useEffect(() => {
    if (view && view.order.property_id !== propertyId) navigate("/orders", { replace: true });
  }, [navigate, propertyId, view]);

  const unitMap = useMemo(() => new Map(meta.inventoryUnits.map((unit) => [unit.id, unit])), [meta.inventoryUnits]);

  function openForm(action: FormAction, factId?: string) {
    setInitialFactId(factId);
    setFormAction(action);
  }

  function directCommand(commandType: CommandType, title: string, description: string) {
    if (!view) return;
    setCommand({ commandType, title, description, input: { propertyId: view.order.property_id, orderId: view.order.id } });
  }

  if (loading) return <LoadingBlock label="正在载入订单详情" />;
  if (error || !view) return <div><Link className="back-link" to="/orders"><ArrowLeft aria-hidden="true" size={17} />返回订单</Link><InlineError error={error ?? new Error("Order not found")} title="无法载入订单" /></div>;

  const currentUnit = unitMap.get(view.currentSegment.inventoryUnitId);

  return (
    <div className="order-detail-page">
      <Link className="back-link" to="/orders"><ArrowLeft aria-hidden="true" size={17} />返回订单</Link>
      <header className="order-heading">
        <div><div className="order-title-row"><h1>{guestName(view.order.primary_guest_snapshot)}</h1><StatusBadge value={view.order.status} /></div><code>{view.order.id}</code></div>
        <div className="order-unit"><span>当前库存</span><strong>{currentUnit ? `${currentUnit.code} · ${currentUnit.name}` : view.currentSegment.inventoryUnitId}</strong></div>
      </header>

      <section className="amount-strip" aria-label="订单可复算金额" data-testid="order-amounts">
        <div><span>currentContractAmount</span><strong>{formatMoney(view.amounts.currentContractAmount)}</strong></div>
        <div><span>netRecordedCollection</span><strong>{formatMoney(view.amounts.netRecordedCollection)}</strong></div>
        <div><span>collectionDifference</span><strong>{formatMoney(view.amounts.collectionDifference)}</strong></div>
      </section>

      <section className="action-band" aria-labelledby="order-actions-heading">
        <div><h2 id="order-actions-heading">订单操作</h2><p>所有写入均经过 Preview / Confirm</p></div>
        <div className="action-toolbar">
          <button className="button button-secondary" type="button" onClick={() => openForm("RECORD_COLLECTION")} data-testid="record-collection"><CircleDollarSign aria-hidden="true" size={17} />收款</button>
          <button className="button button-secondary" type="button" onClick={() => openForm("RECORD_REFUND")} disabled={!view.collectionFacts.some((fact) => fact.fact_type === "COLLECTION")}><Undo2 aria-hidden="true" size={17} />退款</button>
          <button className="button button-secondary" type="button" onClick={() => openForm("SHORTEN_STAY")}><CalendarMinus2 aria-hidden="true" size={17} />缩短</button>
          <button className="button button-secondary" type="button" onClick={() => openForm("EXTEND_STAY")}><CalendarPlus2 aria-hidden="true" size={17} />续住</button>
          <button className="button button-secondary" type="button" onClick={() => openForm("MOVE_UNIT")}><ArrowRightLeft aria-hidden="true" size={17} />换房</button>
          <button className="button button-secondary" type="button" onClick={() => openForm("REPRICE_ORDER")} data-testid="reprice-order"><Calculator aria-hidden="true" size={17} />调价</button>
          <button className="button button-primary" type="button" onClick={() => directCommand("CHECK_IN", "办理入住", "服务端将重新校验订单状态后办理入住。") } data-testid="check-in"><LogIn aria-hidden="true" size={17} />入住</button>
          <button className="button button-primary" type="button" onClick={() => directCommand("CHECK_OUT", "办理退房", "服务端将重新校验订单状态、核销权益并释放库存。") } data-testid="check-out"><LogOut aria-hidden="true" size={17} />退房</button>
          <div className="action-separator" aria-hidden="true" />
          <button className="icon-button danger-icon" type="button" onClick={() => directCommand("CANCEL_ORDER", "取消订单", "确认取消订单并释放服务端库存与会员覆盖。") } aria-label="取消订单" title="取消订单"><XCircle aria-hidden="true" size={18} /></button>
          <button className="icon-button danger-icon" type="button" onClick={() => directCommand("MARK_NO_SHOW", "标记未到", "确认标记未到并释放服务端库存与会员覆盖。") } aria-label="标记未到" title="标记未到"><UserX aria-hidden="true" size={18} /></button>
        </div>
      </section>

      <div className="detail-grid">
        <section className="detail-section" aria-labelledby="guest-snapshot-heading"><div className="section-title-row"><h2 id="guest-snapshot-heading">主要居住人快照</h2><span>不可变快照</span></div><dl className="detail-list">{Object.entries(view.order.primary_guest_snapshot).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></section>
        <section className="detail-section" aria-labelledby="stay-heading"><div className="section-title-row"><h2 id="stay-heading">Stay</h2><StatusBadge value={view.stay.status} /></div><dl className="detail-list"><div><dt>Stay ID</dt><dd><code>{view.stay.id}</code></dd></div><div><dt>住宿周期</dt><dd>{formatDate(view.order.arrival_date)} 至 {formatDate(view.order.departure_date)}</dd></div><div><dt>住宿类型</dt><dd>{view.order.stay_type}</dd></div><div><dt>政策版本</dt><dd><code>{view.order.pricing_policy_version_id}</code></dd></div><div><dt>会员合同</dt><dd><code>{view.order.member_contract_id ?? "-"}</code></dd></div></dl></section>
      </div>

      <section className="detail-section full-detail" aria-labelledby="segments-heading"><div className="section-title-row"><h2 id="segments-heading">住宿分段</h2><span>{view.segments.length}</span></div><div className="table-region" role="region" aria-label="住宿分段" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">序号</th><th scope="col">库存单元</th><th scope="col">周期</th><th scope="col">类型</th><th scope="col">Segment ID</th></tr></thead><tbody>{view.segments.map((segment) => { const unit = unitMap.get(segment.inventory_unit_id); return <tr key={segment.id}><td>{segment.sequence}</td><th scope="row">{unit ? `${unit.code} · ${unit.name}` : segment.inventory_unit_id}</th><td>{formatDate(segment.arrival_date)} 至 {formatDate(segment.departure_date)}</td><td>{segment.segment_type}</td><td><code>{segment.id}</code></td></tr>; })}</tbody></table></div></section>

      <section className="detail-section full-detail" aria-labelledby="revisions-heading"><div className="section-title-row"><h2 id="revisions-heading">Pricing revisions</h2><span>{view.pricingRevisions.length}</span></div><div className="table-region" role="region" aria-label="计价修订" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">Revision</th><th scope="col">锁定政策</th><th scope="col">周期</th><th scope="col">Coverage</th><th scope="col">手工调整</th><th scope="col">currentContractAmount</th><th scope="col">明细</th></tr></thead><tbody>{view.pricingRevisions.map((revision) => <tr key={revision.id}><th scope="row">#{revision.revision_no}<code>{revision.id}</code></th><td><code>{revision.policy_version_id}</code></td><td>{formatDate(revision.arrival_date)} 至 {formatDate(revision.departure_date)}</td><td>{countArray(revision.coverage_set)}</td><td>{formatMinor(revision.manual_adjustment_minor, revision.currency)}</td><td><strong>{formatMinor(revision.current_contract_amount_minor, revision.currency)}</strong></td><td><JsonDetails label="查看" value={{ coverageSet: revision.coverage_set, cashLines: revision.cash_lines }} /></td></tr>)}</tbody></table></div></section>

      <section className="detail-section full-detail" aria-labelledby="coverage-table-heading"><div className="section-title-row"><h2 id="coverage-table-heading">Coverage set</h2><span>{view.coverageSet.length}</span></div>{view.coverageSet.length ? <div className="table-region" role="region" aria-label="会员覆盖" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">服务日期</th><th scope="col">库存单元</th><th scope="col">权益类型</th><th scope="col">Lot</th><th scope="col">状态</th><th scope="col">Fact ID</th></tr></thead><tbody>{view.coverageSet.map((coverage) => <tr key={coverage.id}><td>{coverage.service_date}</td><td>{unitMap.get(coverage.inventory_unit_id)?.code ?? coverage.inventory_unit_id}</td><td>{coverage.unit_kind}</td><td><code>{coverage.lot_id}</code></td><td><StatusBadge value={coverage.status} /></td><td><code>{coverage.id}</code></td></tr>)}</tbody></table></div> : <EmptyState title="没有会员覆盖" detail="此订单未使用 ROOM_NIGHT 或 BED_NIGHT 权益。" />}</section>

      <section className="detail-section full-detail" aria-labelledby="facts-heading"><div className="section-title-row"><h2 id="facts-heading">收退款与冲销事实</h2><span>{view.collectionFacts.length}</span></div>{view.collectionFacts.length ? <div className="table-region" role="region" aria-label="收退款事实" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">Fact ID</th><th scope="col">类型</th><th scope="col">事实金额</th><th scope="col">净影响</th><th scope="col">引用 / 冲销</th><th scope="col">方式与备注</th><th scope="col">操作</th></tr></thead><tbody>{view.collectionFacts.map((fact) => <tr key={fact.fact_id}><th scope="row"><code>{fact.fact_id}</code><small>{formatDateTime(fact.created_at)}</small></th><td><StatusBadge value={fact.fact_type} /></td><td>{formatMinor(fact.amount_minor, fact.currency)}</td><td>{formatMinor(fact.net_effect_minor, fact.currency)}</td><td><code>{fact.references_fact_id ?? fact.reverses_fact_id ?? "-"}</code></td><td><strong>{fact.method}</strong><small>{fact.note || "-"}</small></td><td><FactActions fact={fact} canReverse={fact.fact_type !== "REVERSAL" && !view.collectionFacts.some((candidate) => candidate.reverses_fact_id === fact.fact_id)} onRefund={() => openForm("RECORD_REFUND", fact.fact_id)} onReverse={() => openForm("REVERSE_FACT", fact.fact_id)} /></td></tr>)}</tbody></table></div> : <EmptyState title="尚无收退款事实" detail="使用订单操作记录第一笔独立收款。" />}</section>

      <section className="detail-section full-detail" aria-labelledby="amendments-heading"><div className="section-title-row"><h2 id="amendments-heading">Amendments</h2><span>{view.amendments.length}</span></div><div className="amendment-list">{view.amendments.map((amendment) => <article key={amendment.id}><div><strong>#{amendment.sequence} · {amendment.amendment_type}</strong><code>{amendment.id}</code></div><div><span>{amendment.reason_code}</span><p>{amendment.reason_note}</p></div><div><span>v{amendment.prior_version} → v{amendment.new_version}</span><JsonDetails label="payload" value={amendment.payload} /></div></article>)}</div></section>

      {formAction ? <ActionFormDialog action={formAction} view={view} {...(initialFactId ? { initialFactId } : {})} onClose={() => { setFormAction(undefined); setInitialFactId(undefined); }} onSubmit={(request) => { setFormAction(undefined); setInitialFactId(undefined); setCommand(request); }} /> : null}
      {command ? <CommandDialog request={command} onClose={() => { setCommand(undefined); setRefreshToken((value) => value + 1); }} /> : null}
    </div>
  );
}
