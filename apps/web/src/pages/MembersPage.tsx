import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarX2, RefreshCw, SlidersHorizontal } from "lucide-react";
import { api } from "../api";
import { addLocalDateDays } from "../dates";
import { useWorkspace } from "../session";
import type { CommandRequest, EntitlementLedgerDto, EntitlementLotDto, MemberViewDto } from "../types";
import { CommandDialog, EmptyState, formatDate, formatDateTime, InlineError, LoadingBlock, Modal, StatusBadge } from "../ui";

type MemberAction = "ADJUST_MEMBER_ENTITLEMENT" | "EXPIRE_MEMBER_ENTITLEMENT";

export function availableUnits(lot: EntitlementLotDto, ledger: EntitlementLedgerDto[]): number {
  return lot.total_units + ledger
    .filter((entry) => entry.lot_id === lot.id)
    .reduce((total, entry) => total + entry.quantity_delta, 0);
}

function signedQuantity(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function EntitlementActionDialog({ action, lot, propertyId, onClose, onSubmit }: {
  action: MemberAction;
  lot: EntitlementLotDto;
  propertyId: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const [quantityDelta, setQuantityDelta] = useState("1");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [asOfDate, setAsOfDate] = useState(() => addLocalDateDays(lot.expires_on, 1));
  const [validationError, setValidationError] = useState<unknown>();
  const isAdjustment = action === "ADJUST_MEMBER_ENTITLEMENT";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    if (isAdjustment) {
      const parsedDelta = Number(quantityDelta);
      if (!Number.isSafeInteger(parsedDelta) || parsedDelta === 0) {
        setValidationError(new Error("调整数量必须是非零整数"));
        return;
      }
      if (!adjustmentReason.trim()) {
        setValidationError(new Error("请填写调整原因"));
        return;
      }
      onSubmit({
        commandType: action,
        title: `调整会员权益 · ${lot.unit_kind}`,
        description: "服务端将重新校验权益余额和 lot 版本，并追加不可变 ADJUST 事实。",
        input: {
          propertyId,
          entitlementLotId: lot.id,
          quantityDelta: parsedDelta,
          adjustmentReason: adjustmentReason.trim()
        }
      });
      return;
    }
    onSubmit({
      commandType: action,
      title: `到期会员权益 · ${lot.unit_kind}`,
      description: "服务端将按 asOfDate 重新校验到期边界和可用余额，并追加不可变 EXPIRE 事实。",
      input: { propertyId, entitlementLotId: lot.id, asOfDate }
    });
  }

  return (
    <Modal title={isAdjustment ? "调整会员权益" : "执行权益到期"} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        <dl className="member-action-context">
          <div><dt>Lot</dt><dd><code>{lot.id}</code></dd></div>
          <div><dt>权益类型</dt><dd>{lot.unit_kind}</dd></div>
          <div><dt>合同到期日</dt><dd>{formatDate(lot.expires_on)}</dd></div>
        </dl>
        <InlineError error={validationError} title="无法继续" />
        {isAdjustment ? (
          <div className="form-grid">
            <label htmlFor="entitlement-quantity-delta">调整数量（正数增加，负数减少）
              <input id="entitlement-quantity-delta" type="number" step="1" value={quantityDelta} onChange={(event) => setQuantityDelta(event.target.value)} required inputMode="numeric" />
            </label>
            <label htmlFor="entitlement-adjustment-reason">调整原因
              <textarea id="entitlement-adjustment-reason" rows={3} value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} required maxLength={1000} />
            </label>
          </div>
        ) : (
          <div className="form-grid">
            <label htmlFor="entitlement-as-of-date">到期核算日期
              <input id="entitlement-as-of-date" type="date" min={addLocalDateDays(lot.expires_on, 1)} value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} required />
            </label>
            <p className="member-form-note">核算日期必须晚于 lot 到期日；实际到期数量以服务端 Preview 为准。</p>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="button button-primary">继续生成 Preview</button>
        </div>
      </form>
    </Modal>
  );
}

export function MembersPage() {
  const { meta, propertyId } = useWorkspace();
  const contracts = useMemo(
    () => meta.memberContracts.filter((contract) => contract.property_id === propertyId),
    [meta.memberContracts, propertyId]
  );
  const [selectedContractId, setSelectedContractId] = useState("");
  const effectiveContractId = contracts.some((contract) => contract.id === selectedContractId)
    ? selectedContractId
    : contracts[0]?.id ?? "";
  const [member, setMember] = useState<MemberViewDto>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [action, setAction] = useState<{ type: MemberAction; lot: EntitlementLotDto }>();
  const [command, setCommand] = useState<CommandRequest>();

  useEffect(() => {
    if (!effectiveContractId) {
      setMember(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    setError(undefined);
    setMember(undefined);
    api.member(effectiveContractId)
      .then((response) => current && setMember(response))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [effectiveContractId, refreshToken]);

  const ledger = member?.ledger ?? [];
  const expiredLotIds = useMemo(
    () => new Set(ledger.filter((entry) => entry.entry_type === "EXPIRE").map((entry) => entry.lot_id)),
    [ledger]
  );
  const totalAvailable = member?.lots.reduce((sum, lot) => sum + availableUnits(lot, ledger), 0) ?? 0;

  function startAction(type: MemberAction, lot: EntitlementLotDto) {
    setAction({ type, lot });
  }

  return (
    <div className="members-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">Membership</p><h1>会员权益</h1><p>ROOM_NIGHT / BED_NIGHT lot、余额与不可变事实</p></div>
        <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading || !effectiveContractId}>
          <RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新
        </button>
      </header>

      {contracts.length ? (
        <section className="member-selector" aria-label="会员合同选择">
          <label htmlFor="member-contract-select">会员合同
            <select id="member-contract-select" value={effectiveContractId} onChange={(event) => setSelectedContractId(event.target.value)}>
              {contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.member_name} · {contract.id}</option>)}
            </select>
          </label>
          {member ? <StatusBadge value={member.contract.status} /> : null}
        </section>
      ) : null}

      <InlineError error={error} title="无法载入会员权益" />
      {!contracts.length ? <EmptyState title="当前物业没有会员合同" detail="会员合同创建后会在此显示 lot 和权益事实。" /> : loading ? <LoadingBlock label="正在载入会员权益" /> : member ? (
        <>
          <section className="member-contract-band" aria-labelledby="member-contract-heading">
            <div><span>会员</span><strong id="member-contract-heading">{member.contract.member_name}</strong><code>{member.contract.id}</code></div>
            <div><span>合同周期</span><strong>{formatDate(member.contract.valid_from)} 至 {formatDate(member.contract.valid_until)}</strong><small>版本 v{member.contract.version}</small></div>
          </section>

          <section className="member-summary" aria-label="会员权益汇总">
            <div><span>权益 lot</span><strong>{member.lots.length}</strong></div>
            <div><span>当前可用单位</span><strong>{totalAvailable}</strong></div>
            <div><span>权益事实</span><strong>{ledger.length}</strong></div>
          </section>

          <section className="member-section" aria-labelledby="entitlement-lots-heading">
            <div className="section-title-row"><h2 id="entitlement-lots-heading">权益 Lots</h2><span>{member.lots.length}</span></div>
            {member.lots.length ? (
              <div className="table-region" role="region" aria-label="会员权益 Lots" tabIndex={0}>
                <table className="data-table member-lots-table">
                  <thead><tr><th scope="col">Lot / 类型</th><th scope="col">初始单位</th><th scope="col">当前可用</th><th scope="col">到期日</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
                  <tbody>{member.lots.map((lot) => {
                    const expired = expiredLotIds.has(lot.id);
                    return <tr key={lot.id}>
                      <th scope="row"><strong>{lot.unit_kind}</strong><code>{lot.id}</code></th>
                      <td>{lot.total_units}</td>
                      <td><strong className="tabular-number">{availableUnits(lot, ledger)}</strong></td>
                      <td>{formatDate(lot.expires_on)}</td>
                      <td><StatusBadge value={expired ? "EXPIRED" : "ACTIVE"} /></td>
                      <td><div className="row-actions">
                        <button className="button button-compact button-secondary" type="button" onClick={() => startAction("ADJUST_MEMBER_ENTITLEMENT", lot)} disabled={expired}><SlidersHorizontal aria-hidden="true" size={16} />调整</button>
                        <button className="icon-button danger-icon" type="button" onClick={() => startAction("EXPIRE_MEMBER_ENTITLEMENT", lot)} disabled={expired} aria-label={`到期权益 lot ${lot.id}`} title="执行到期"><CalendarX2 aria-hidden="true" size={17} /></button>
                      </div></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            ) : <EmptyState title="该合同没有权益 lot" detail="可用权益 lot 建立后会在此显示。" />}
          </section>

          <section className="member-section" aria-labelledby="entitlement-ledger-heading">
            <div className="section-title-row"><h2 id="entitlement-ledger-heading">权益 Ledger</h2><span>{ledger.length}</span></div>
            {ledger.length ? (
              <div className="table-region" role="region" aria-label="会员权益事实" tabIndex={0}>
                <table className="data-table member-ledger-table">
                  <thead><tr><th scope="col">Fact ID</th><th scope="col">类型</th><th scope="col">数量变化</th><th scope="col">服务日期</th><th scope="col">订单 / Coverage</th><th scope="col">原因</th></tr></thead>
                  <tbody>{ledger.map((entry) => <tr key={entry.fact_id}>
                    <th scope="row"><code>{entry.fact_id}</code><small>{formatDateTime(entry.created_at)}</small></th>
                    <td><StatusBadge value={entry.entry_type} /></td>
                    <td><strong className={entry.quantity_delta < 0 ? "quantity-negative" : "quantity-positive"}>{signedQuantity(entry.quantity_delta)}</strong></td>
                    <td>{entry.service_date ?? "-"}</td>
                    <td><code>{entry.order_id ?? "-"}</code><small>{entry.coverage_id ?? "-"}</small></td>
                    <td className="member-ledger-reason">{entry.reason}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            ) : <EmptyState title="尚无权益事实" detail="冻结、释放、核销、调整或到期后会在此形成永久事实。" />}
          </section>
        </>
      ) : null}

      {action && member ? <EntitlementActionDialog action={action.type} lot={action.lot} propertyId={member.contract.property_id} onClose={() => setAction(undefined)} onSubmit={(request) => { setAction(undefined); setCommand(request); }} /> : null}
      {command ? <CommandDialog request={command} onClose={() => setCommand(undefined)} onCommitted={() => setRefreshToken((value) => value + 1)} /> : null}
    </div>
  );
}
