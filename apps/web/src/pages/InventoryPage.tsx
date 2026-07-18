import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CalendarDays, FilePlus2, Filter, LockOpen, RefreshCw, Search, ShieldCheck, Wrench } from "lucide-react";
import { api, ApiError, type ClientCommandMetadata } from "../api";
import { addLocalDateDays, defaultInventoryDates } from "../dates";
import { useWorkspace } from "../session";
import type {
  CommandRequest,
  InventoryUnitDto,
  MaintenanceLockDto,
  PricingPolicyVersionDto,
  QuoteDto,
  ReceiptDto,
  StayType,
  UnitAvailabilityDto
} from "../types";
import { CommandDialog, EmptyState, formatDateTime, formatMoney, InlineError, LoadingBlock, Modal, StatusBadge } from "../ui";

const stayLabels: Record<StayType, string> = {
  TRANSIENT: "临住",
  WEEKLY: "周住",
  MONTHLY: "月住",
  CUSTOM: "自定义周期",
  FIXED_TERM: "固定期限",
  ROLLING: "滚动续期",
  FREE: "免费住宿"
};

interface QuoteCommandInput {
  propertyId: string;
  inventoryUnitId: string;
  stayType: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberContractId?: string;
}

interface PendingQuoteCommand {
  input: QuoteCommandInput;
  inputSignature: string;
  metadata: ClientCommandMetadata;
  state: "SENDING" | "UNKNOWN";
}

function quoteInputSignature(input: QuoteCommandInput): string {
  return JSON.stringify(input);
}

function quoteFromReceipt(receipt: ReceiptDto): QuoteDto {
  const quote = receipt.result?.quote;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new Error("Recovered CREATE_QUOTE Receipt does not contain a valid Quote");
  }
  const record = quote as Record<string, unknown>;
  if (typeof record.quoteId !== "string") {
    throw new Error("Recovered CREATE_QUOTE Receipt does not contain a valid Quote");
  }
  return record as unknown as QuoteDto;
}

function unitName(unit: UnitAvailabilityDto | InventoryUnitDto | undefined) {
  return unit ? `${unit.code} · ${unit.name}` : "未选择库存单元";
}

function MaintenanceDialog({ unit, arrivalDate, departureDate, onClose, onSubmit }: {
  unit: UnitAvailabilityDto;
  arrivalDate: string;
  departureDate: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const { propertyId } = useWorkspace();
  const [from, setFrom] = useState(arrivalDate);
  const [to, setTo] = useState(departureDate);
  const [reason, setReason] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      commandType: "LOCK_MAINTENANCE",
      title: `维修锁房 · ${unit.code}`,
      description: "服务端将重新校验整房与子床位互斥后生成维修锁房 Preview。",
      input: { propertyId, inventoryUnitId: unit.id, arrivalDate: from, departureDate: to, reason }
    });
  }

  return (
    <Modal title={`维修锁房 · ${unitName(unit)}`} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        <div className="form-grid form-grid-two">
          <label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label>
          <label>结束日期<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} required /></label>
          <label className="span-two">维修原因<textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} /></label>
        </div>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">继续生成 Preview</button></div>
      </form>
    </Modal>
  );
}

function QuoteWorkbench({
  unit,
  arrivalDate,
  departureDate,
  policies,
  onCommand
}: {
  unit: UnitAvailabilityDto | undefined;
  arrivalDate: string;
  departureDate: string;
  policies: PricingPolicyVersionDto[];
  onCommand: (request: CommandRequest) => void;
}) {
  const { meta, propertyId } = useWorkspace();
  const stayTypes = useMemo(() => [...new Set(policies.map((policy) => policy.stay_type))], [policies]);
  const [stayType, setStayType] = useState<StayType>(stayTypes[0] ?? "TRANSIENT");
  const matchingPolicies = policies.filter((policy) => policy.stay_type === stayType);
  const [policyId, setPolicyId] = useState(matchingPolicies[0]?.id ?? "");
  const [memberContractId, setMemberContractId] = useState("");
  const [quote, setQuote] = useState<QuoteDto>();
  const [quoteReceipt, setQuoteReceipt] = useState<ReceiptDto>();
  const [pendingQuote, setPendingQuote] = useState<PendingQuoteCommand>();
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestDocument, setGuestDocument] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const latestQuoteSignature = useRef("");

  useEffect(() => {
    const firstStay = stayTypes[0];
    if (firstStay && !stayTypes.includes(stayType)) setStayType(firstStay);
  }, [stayType, stayTypes]);

  useEffect(() => {
    const firstPolicy = policies.find((policy) => policy.stay_type === stayType);
    if (!policies.some((policy) => policy.id === policyId && policy.stay_type === stayType)) setPolicyId(firstPolicy?.id ?? "");
  }, [policies, policyId, stayType]);

  useEffect(() => {
    setQuote(undefined);
    setQuoteReceipt(undefined);
    setError(undefined);
  }, [unit?.id, arrivalDate, departureDate, stayType, policyId, memberContractId]);

  const selectedPolicy = policies.find((policy) => policy.id === policyId);
  const members = meta.memberContracts.filter((member) => member.property_id === propertyId && member.status === "ACTIVE");
  const currentQuoteInput: QuoteCommandInput | undefined = unit && policyId ? {
    propertyId,
    inventoryUnitId: unit.id,
    stayType,
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: policyId,
    ...(memberContractId ? { memberContractId } : {})
  } : undefined;
  latestQuoteSignature.current = currentQuoteInput ? quoteInputSignature(currentQuoteInput) : "";

  async function createQuote() {
    if (!currentQuoteInput || pendingQuote) return;
    const input = currentQuoteInput;
    const inputSignature = quoteInputSignature(input);
    const metadata = api.commandMetadata("create-quote");
    setPendingQuote({ input, inputSignature, metadata, state: "SENDING" });
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.quote(input, metadata);
      if (latestQuoteSignature.current === inputSignature) {
        setQuote(response.quote);
        setQuoteReceipt(response.receipt);
      } else {
        setError(new Error("报价已完成，但筛选条件在请求期间发生变化；旧结果未应用，请重新报价。"));
      }
      setPendingQuote(undefined);
    } catch (nextError) {
      setError(nextError);
      const uncertain = !(nextError instanceof ApiError)
        || nextError.status >= 500
        || nextError.code === "COMMAND_STATUS_UNKNOWN";
      setPendingQuote((current) => current?.metadata.idempotencyKey === metadata.idempotencyKey
        ? uncertain ? { ...current, state: "UNKNOWN" } : undefined
        : current);
    } finally {
      setBusy(false);
    }
  }

  async function recoverQuote() {
    if (!pendingQuote) return;
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await api.commandResult(
        pendingQuote.input.propertyId,
        "CREATE_QUOTE",
        pendingQuote.metadata.idempotencyKey
      );
      if (receipt.executionStatus === "UNKNOWN") {
        setPendingQuote((current) => current ? { ...current, state: "UNKNOWN" } : current);
        setError(new Error("报价命令仍在执行或状态未知，请保留原幂等键后再次查询。"));
        return;
      }
      setPendingQuote(undefined);
      if (!receipt.businessCommitted) {
        setError(new Error("服务端确认该报价命令未执行，可以重新报价。"));
        return;
      }
      const recoveredQuote = quoteFromReceipt(receipt);
      if (latestQuoteSignature.current !== pendingQuote.inputSignature) {
        setError(new Error("报价已恢复，但当前筛选条件已变化；旧结果未应用，请重新报价。"));
        return;
      }
      setQuote(recoveredQuote);
      setQuoteReceipt(receipt);
    } catch (nextError) {
      setError(nextError);
      setPendingQuote((current) => current ? { ...current, state: "UNKNOWN" } : current);
    } finally {
      setBusy(false);
    }
  }

  function createOrder() {
    if (!quote || !guestName.trim()) return;
    const primaryGuest: Record<string, unknown> = { fullName: guestName.trim() };
    if (guestPhone.trim()) primaryGuest.phone = guestPhone.trim();
    if (guestDocument.trim()) primaryGuest.documentNumber = guestDocument.trim();
    onCommand({
      commandType: "CREATE_ORDER",
      title: "创建订单",
      description: "确认主要居住人快照、锁定计价政策版本、库存及会员覆盖差异。",
      input: { propertyId, quoteId: quote.quoteId, primaryGuest }
    });
  }

  return (
    <aside className="quote-workbench" aria-labelledby="quote-heading">
      <header className="panel-heading">
        <div><p className="eyebrow">Quote</p><h2 id="quote-heading">报价工作区</h2></div>
        {unit ? <span className={`unit-kind kind-${unit.kind.toLowerCase()}`}>{unit.kind === "ROOM" ? "整房" : "床位"}</span> : null}
      </header>
      {!unit ? <EmptyState title="选择可售库存" detail="在房态表中选择整房或床位后开始报价。" /> : (
        <>
          <div className="selected-unit"><strong>{unitName(unit)}</strong><span>{arrivalDate} 至 {departureDate}</span></div>
          <div className="form-grid quote-form">
            <label>住宿类型
              <select value={stayType} onChange={(event) => setStayType(event.target.value as StayType)} disabled={busy || Boolean(pendingQuote)}>
                {stayTypes.map((type) => <option key={type} value={type}>{stayLabels[type]}</option>)}
              </select>
            </label>
            <label>计价政策版本
              <select value={policyId} onChange={(event) => setPolicyId(event.target.value)} required disabled={busy || Boolean(pendingQuote)}>
                {matchingPolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.code} · v{policy.version}</option>)}
              </select>
            </label>
            <label>会员合同
              <select value={memberContractId} onChange={(event) => setMemberContractId(event.target.value)} disabled={busy || Boolean(pendingQuote)}>
                <option value="">不使用会员权益</option>
                {members.map((member) => <option key={member.id} value={member.id}>{member.member_name} · {member.id}</option>)}
              </select>
            </label>
            <button className="button button-primary" type="button" onClick={() => void createQuote()} disabled={busy || Boolean(pendingQuote) || !policyId || !unit.available} data-testid="request-quote">
              <Search aria-hidden="true" size={17} />{busy ? "正在报价" : "获取服务端报价"}
            </button>
          </div>
          <InlineError error={error} title="报价失败" />
          {pendingQuote ? (
            <div className="recovery-bar" data-testid="quote-recovery">
              <div><strong>{pendingQuote.state === "SENDING" ? "报价命令处理中" : "报价命令结果待恢复"}</strong><p>保留原幂等键，只查询执行结果，不创建第二个 Quote。</p></div>
              <button className="button button-secondary" type="button" onClick={() => void recoverQuote()} disabled={busy || pendingQuote.state === "SENDING"}>
                <RefreshCw aria-hidden="true" size={17} />查询命令结果
              </button>
            </div>
          ) : null}
          {quote ? (
            <div className="quote-result" data-testid="quote-result">
              <section className="locked-policy" aria-label="锁定计价政策">
                <ShieldCheck aria-hidden="true" size={19} />
                <div><span>锁定政策版本</span><strong>{selectedPolicy?.code} · v{selectedPolicy?.version}</strong><code>{quote.pricingPolicyVersionId}</code></div>
              </section>
              <div className="quote-amounts">
                <div><span>cashRemainder</span><strong>{formatMoney(quote.cashRemainder)}</strong></div>
                <div><span>currentContractAmount</span><strong>{formatMoney(quote.currentContractAmount)}</strong></div>
              </div>
              <section className="quote-lines" aria-labelledby="coverage-heading">
                <div className="section-title-row"><h3 id="coverage-heading">coverageSet</h3><span>{quote.coverageSet.length} 晚</span></div>
                {quote.coverageSet.length ? (
                  <div className="compact-list">
                    {quote.coverageSet.map((item) => <div key={`${item.serviceDate}-${item.inventoryUnitId}`}><span>{item.serviceDate}</span><span>{item.unitKind}</span><code>{item.entitlementLotId}</code></div>)}
                  </div>
                ) : <p className="muted compact">本次报价没有会员覆盖。</p>}
              </section>
              <section className="quote-lines" aria-labelledby="cash-lines-heading">
                <div className="section-title-row"><h3 id="cash-lines-heading">现金计价行</h3><span>{quote.cashLines.length}</span></div>
                {quote.cashLines.map((line) => <div className="cash-line" key={`${line.serviceDate}-${line.inventoryUnitId}`}><span>{line.serviceDate}</span><span>{line.description}</span><strong>{formatMoney(line.amount)}</strong></div>)}
              </section>
              <div className="quote-expiry">Quote ID <code>{quote.quoteId}</code><span>有效至 {formatDateTime(quote.expiresAt)}</span>{quoteReceipt ? <><span>Receipt</span><code>{quoteReceipt.receiptId}</code></> : null}</div>
              <section className="guest-section" aria-labelledby="guest-heading">
                <h3 id="guest-heading">主要居住人快照</h3>
                <div className="form-grid">
                  <label>姓名<input value={guestName} onChange={(event) => setGuestName(event.target.value)} required maxLength={160} data-testid="primary-guest-name" /></label>
                  <label>联系电话<input value={guestPhone} onChange={(event) => setGuestPhone(event.target.value)} inputMode="tel" maxLength={80} /></label>
                  <label>证件号码<input value={guestDocument} onChange={(event) => setGuestDocument(event.target.value)} maxLength={120} /></label>
                </div>
                <button className="button button-primary full-width" type="button" onClick={createOrder} disabled={!guestName.trim()} data-testid="create-order">
                  <FilePlus2 aria-hidden="true" size={17} />Preview 创建订单
                </button>
              </section>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

export function InventoryPage() {
  const { meta, propertyId } = useWorkspace();
  const propertyTimezone = meta.properties.find((property) => property.id === propertyId)?.timezone ?? "UTC";
  const [searchDates, setSearchDates] = useState(() => defaultInventoryDates(propertyTimezone));
  const { arrivalDate, departureDate } = searchDates;
  const datesEdited = useRef(false);
  const previousPropertyId = useRef(propertyId);
  const [unitKind, setUnitKind] = useState<"ALL" | "ROOM" | "BED">("ALL");
  const [units, setUnits] = useState<UnitAvailabilityDto[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [command, setCommand] = useState<CommandRequest>();
  const [maintenanceUnit, setMaintenanceUnit] = useState<UnitAvailabilityDto>();
  const [maintenanceLocks, setMaintenanceLocks] = useState<MaintenanceLockDto[]>([]);
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [maintenanceError, setMaintenanceError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (previousPropertyId.current === propertyId) return;
    previousPropertyId.current = propertyId;
    if (!datesEdited.current) setSearchDates(defaultInventoryDates(propertyTimezone));
  }, [propertyId, propertyTimezone]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    api.availability(propertyId, arrivalDate, departureDate, unitKind === "ALL" ? undefined : unitKind)
      .then((response) => {
        if (!current) return;
        setUnits(response.units);
        setSelectedUnitId((selected) => response.units.some((unit) => unit.id === selected) ? selected : undefined);
      })
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [arrivalDate, departureDate, propertyId, refreshToken, unitKind]);

  useEffect(() => {
    let current = true;
    setMaintenanceLoading(true);
    setMaintenanceError(undefined);
    setMaintenanceLocks([]);
    api.maintenanceLocks(propertyId)
      .then((response) => current && setMaintenanceLocks(response.maintenanceLocks))
      .catch((nextError) => current && setMaintenanceError(nextError))
      .finally(() => current && setMaintenanceLoading(false));
    return () => { current = false; };
  }, [propertyId, refreshToken]);

  const selectedUnit = units.find((unit) => unit.id === selectedUnitId);
  const policies = meta.pricingPolicyVersions.filter((policy) => policy.property_id === propertyId && policy.status === "PUBLISHED");
  const nights = units[0]?.nights ?? [];
  const inventoryUnitMap = new Map(meta.inventoryUnits.map((unit) => [unit.id, unit]));

  function updateArrival(next: string) {
    datesEdited.current = true;
    let nextDeparture = departureDate;
    if (departureDate <= next) {
      nextDeparture = addLocalDateDays(next, 1);
    }
    setSearchDates({ arrivalDate: next, departureDate: nextDeparture });
  }

  function releaseMaintenance(lock: MaintenanceLockDto) {
    const unit = inventoryUnitMap.get(lock.inventory_unit_id);
    setCommand({
      commandType: "RELEASE_MAINTENANCE",
      title: `释放维修锁 · ${unit?.code ?? lock.inventory_unit_id}`,
      description: "服务端将重新校验维修锁版本，确认后释放对应日期范围的库存 claim。",
      input: { propertyId, maintenanceLockId: lock.id }
    });
  }

  return (
    <div className="inventory-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">Inventory</p><h1>房态与可售</h1><p>整房 / 子床位逐日互斥视图</p></div>
        <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新
        </button>
      </header>

      <section className="inventory-filters" aria-label="房态筛选">
        <div className="date-control"><CalendarDays aria-hidden="true" size={17} /><label>到店<input type="date" value={arrivalDate} onChange={(event) => updateArrival(event.target.value)} data-testid="arrival-date" /></label></div>
        <div className="date-control"><label>离店<input type="date" value={departureDate} min={arrivalDate} onChange={(event) => { datesEdited.current = true; setSearchDates({ arrivalDate, departureDate: event.target.value }); }} data-testid="departure-date" /></label></div>
        <fieldset className="segmented-control"><legend className="sr-only">库存类型</legend><Filter aria-hidden="true" size={16} />
          {(["ALL", "ROOM", "BED"] as const).map((kind) => <label key={kind}><input type="radio" name="unitKind" value={kind} checked={unitKind === kind} onChange={() => setUnitKind(kind)} /><span>{kind === "ALL" ? "全部" : kind === "ROOM" ? "整房" : "床位"}</span></label>)}
        </fieldset>
      </section>

      <InlineError error={error} title="无法查询房态" />
      <div className="inventory-workspace">
        <section className="inventory-board" aria-labelledby="inventory-table-heading">
          <div className="panel-heading inventory-board-heading"><div><h2 id="inventory-table-heading">逐日库存</h2><p>{units.length} 个库存单元 · {nights.length} 晚</p></div><div className="board-legend"><span><i className="legend-available" />可售</span><span><i className="legend-blocked" />占用</span></div></div>
          {loading ? <LoadingBlock label="正在查询可售库存" /> : units.length === 0 ? <EmptyState title="没有库存结果" detail="调整日期或库存类型后重新查询。" /> : (
            <div className="table-region" role="region" aria-label="房间和床位逐日可售表" tabIndex={0}>
              <table className="inventory-table" data-testid="inventory-board">
                <thead><tr><th scope="col" className="sticky-column">库存单元</th>{nights.map((night) => <th scope="col" key={night.serviceDate}><span>{night.serviceDate.slice(5)}</span></th>)}<th scope="col">操作</th></tr></thead>
                <tbody>
                  {units.map((unit) => (
                    <tr key={unit.id} className={selectedUnitId === unit.id ? "selected-row" : undefined}>
                      <th scope="row" className={`sticky-column unit-cell ${unit.kind === "BED" ? "child-unit" : ""}`}><span className="unit-code">{unit.code}</span><span>{unit.name}</span><small>{unit.kind === "ROOM" ? "整房" : "床位"}</small></th>
                      {unit.nights.map((night) => <td key={night.serviceDate}><span className={`availability-cell ${night.available ? "available" : "blocked"}`} aria-label={`${night.serviceDate} ${night.available ? "可售" : "占用"}`}>{night.available ? "可售" : "占用"}</span></td>)}
                      <td className="row-actions"><button className="icon-button" type="button" onClick={() => setMaintenanceUnit(unit)} aria-label={`维修锁房 ${unit.code}`} title="维修锁房"><Wrench aria-hidden="true" size={17} /></button><button className="button button-compact button-secondary" type="button" onClick={() => setSelectedUnitId(unit.id)} disabled={!unit.available} data-testid={`quote-unit-${unit.code}`}>报价</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <QuoteWorkbench unit={selectedUnit} arrivalDate={arrivalDate} departureDate={departureDate} policies={policies} onCommand={setCommand} />
      </div>

      <section className="maintenance-locks-panel" aria-labelledby="maintenance-locks-heading" data-testid="maintenance-locks">
        <header className="panel-heading inventory-board-heading">
          <div><p className="eyebrow">Maintenance</p><h2 id="maintenance-locks-heading">有效维修锁</h2></div>
          <span className="maintenance-lock-count">{maintenanceLocks.length} 条</span>
        </header>
        <InlineError error={maintenanceError} title="无法载入维修锁" />
        {maintenanceLoading ? <LoadingBlock label="正在载入维修锁" /> : maintenanceLocks.length === 0 ? <EmptyState title="没有有效维修锁" detail="新建维修锁后会在此显示并提供释放入口。" /> : (
          <div className="table-region" role="region" aria-label="有效维修锁列表" tabIndex={0}>
            <table className="data-table maintenance-locks-table">
              <thead><tr><th scope="col">维修锁</th><th scope="col">库存单元</th><th scope="col">锁房周期</th><th scope="col">原因</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
              <tbody>{maintenanceLocks.map((lock) => {
                const unit = inventoryUnitMap.get(lock.inventory_unit_id);
                return <tr key={lock.id}><th scope="row"><code>{lock.id}</code><small>{formatDateTime(lock.created_at)}</small></th><td><strong>{unit ? `${unit.code} · ${unit.name}` : lock.inventory_unit_id}</strong></td><td>{lock.arrival_date} 至 {lock.departure_date}</td><td className="maintenance-reason">{lock.reason}</td><td><StatusBadge value={lock.status} /></td><td><button className="button button-compact button-secondary" type="button" onClick={() => releaseMaintenance(lock)} aria-label={`释放维修锁 ${unit?.code ?? lock.id}`}><LockOpen aria-hidden="true" size={16} />释放</button></td></tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      {maintenanceUnit ? <MaintenanceDialog unit={maintenanceUnit} arrivalDate={arrivalDate} departureDate={departureDate} onClose={() => setMaintenanceUnit(undefined)} onSubmit={(request) => { setMaintenanceUnit(undefined); setCommand(request); }} /> : null}
      {command ? <CommandDialog request={command} onClose={() => setCommand(undefined)} onCommitted={() => setRefreshToken((value) => value + 1)} /> : null}
    </div>
  );
}
