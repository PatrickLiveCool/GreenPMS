import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarX2, Plus, RefreshCw, Search, SlidersHorizontal, UserPlus } from "lucide-react";
import { api } from "../api";
import { addLocalDateDays } from "../dates";
import { useWorkspace } from "../session";
import type { CommandRequest, EntitlementLotDto, MemberContractDto, MemberSummaryDto, MemberViewDto } from "../types";
import {
  CommandDialog,
  CommandRecoveryBar,
  EmptyState,
  formatDate,
  formatDateTime,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  Modal,
  recoveryCommandRequest,
  StatusBadge,
  usePersistentCommandRecovery
} from "../ui";

type MemberAction = "ADJUST_MEMBER_ENTITLEMENT" | "EXPIRE_MEMBER_ENTITLEMENT";

export function serverAvailableUnits(member: MemberViewDto, lotId: string): number {
  return member.lotBalances.find((balance) => balance.lotId === lotId)?.availableUnits ?? 0;
}

export function isNaturallyExpired(member: MemberViewDto, lot: EntitlementLotDto): boolean {
  return lot.expires_on < member.balanceAsOfDate;
}

export function entitlementLotUiState(member: MemberViewDto, lot: EntitlementLotDto, explicitlyExpired: boolean) {
  const naturallyExpired = isNaturallyExpired(member, lot);
  const expired = explicitlyExpired || naturallyExpired;
  return {
    expired,
    canAdjust: !expired,
    canRecordExpiration: naturallyExpired && !explicitlyExpired
  };
}

function CreateMemberDialog({ propertyId, onClose, onSubmit }: {
  propertyId: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [identityCardNumber, setIdentityCardNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [wechat, setWechat] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [sourceApplicationRecordId, setSourceApplicationRecordId] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      commandType: "CREATE_MEMBER",
      title: "登记会员档案与申请",
      description: "服务端按身份证号匹配：新会员创建档案与首个空合同；既有会员只关联申请，不覆盖档案或自动发放权益。",
      input: {
        propertyId,
        fullName: fullName.trim(),
        identityCardNumber: identityCardNumber.trim().toUpperCase(),
        phone: phone.trim(),
        wechat: wechat.trim(),
        validFrom,
        validUntil,
        ...(sourceApplicationRecordId.trim() ? { sourceApplicationRecordId: sourceApplicationRecordId.trim() } : {})
      }
    });
  }

  return <Modal title="登记会员" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <label>姓名<input value={fullName} onChange={(event) => setFullName(event.target.value)} required maxLength={200} autoFocus data-testid="member-full-name" /></label>
        <label>身份证号<input value={identityCardNumber} onChange={(event) => setIdentityCardNumber(event.target.value)} required maxLength={200} data-testid="member-identity-card" /></label>
        <label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} required maxLength={200} inputMode="tel" /></label>
        <label>微信号<input value={wechat} onChange={(event) => setWechat(event.target.value)} required maxLength={200} /></label>
        <label>初始合同开始日<input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} required /></label>
        <label>初始合同结束日<input type="date" min={validFrom || undefined} value={validUntil} onChange={(event) => setValidUntil(event.target.value)} required /></label>
        <label className="span-two">飞书申请 Record ID（可选）<input value={sourceApplicationRecordId} onChange={(event) => setSourceApplicationRecordId(event.target.value)} maxLength={200} data-testid="member-source-record" /></label>
      </div>
      <p className="member-form-note">合同日期仅在身份证号尚未登记、需要创建首个空合同时使用；申请记录只建立外部引用，不授予权益。</p>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">继续生成 Preview</button></div>
    </form>
  </Modal>;
}

function AddEntitlementLotDialog({ contract, propertyId, balanceAsOfDate, onClose, onSubmit }: {
  contract: MemberContractDto;
  propertyId: string;
  balanceAsOfDate: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const [unitKind, setUnitKind] = useState<"ROOM_NIGHT" | "BED_NIGHT">("ROOM_NIGHT");
  const [units, setUnits] = useState("1");
  const [expiresOn, setExpiresOn] = useState(contract.valid_until);
  const [validationError, setValidationError] = useState<unknown>();
  const minimumExpiryDate = contract.valid_from > balanceAsOfDate ? contract.valid_from : balanceAsOfDate;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedUnits = Number(units);
    if (!Number.isSafeInteger(parsedUnits) || parsedUnits <= 0) {
      setValidationError(new Error("新增权益单位必须是正整数"));
      return;
    }
    if (expiresOn < balanceAsOfDate) {
      setValidationError(new Error("到期日不能早于物业当前日期"));
      return;
    }
    onSubmit({
      commandType: "ADD_MEMBER_ENTITLEMENT_LOT",
      title: `新增会员权益批次 · ${unitKind}`,
      description: "确认后创建独立 entitlement lot 与不可变 ADJUST 账本事实，不改写旧余额。",
      input: { propertyId, memberContractId: contract.id, unitKind, units: parsedUnits, expiresOn }
    });
  }

  return <Modal title="新增会员权益批次" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <InlineError error={validationError} title="无法继续" />
      <div className="form-grid">
        <label>权益类型<select value={unitKind} onChange={(event) => setUnitKind(event.target.value as "ROOM_NIGHT" | "BED_NIGHT")}><option value="ROOM_NIGHT">ROOM_NIGHT</option><option value="BED_NIGHT">BED_NIGHT</option></select></label>
        <label>新增单位<input type="number" min="1" step="1" value={units} onChange={(event) => setUnits(event.target.value)} required inputMode="numeric" data-testid="add-entitlement-units" /></label>
        <label>到期日<input type="date" min={minimumExpiryDate} max={contract.valid_until} value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} required /></label>
      </div>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">继续生成 Preview</button></div>
    </form>
  </Modal>;
}

function signedQuantity(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function EntitlementActionDialog({ action, lot, propertyId, balanceAsOfDate, onClose, onSubmit }: {
  action: MemberAction;
  lot: EntitlementLotDto;
  propertyId: string;
  balanceAsOfDate: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const [quantityDelta, setQuantityDelta] = useState("1");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [asOfDate, setAsOfDate] = useState(balanceAsOfDate);
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
        input: { propertyId, entitlementLotId: lot.id, quantityDelta: parsedDelta, adjustmentReason: adjustmentReason.trim() }
      });
      return;
    }
    if (asOfDate <= lot.expires_on || asOfDate > balanceAsOfDate) {
      setValidationError(new Error("到期核算日期必须晚于 Lot 到期日，且不得晚于物业当前日期"));
      return;
    }
    onSubmit({
      commandType: action,
      title: `到期会员权益 · ${lot.unit_kind}`,
      description: "服务端将按 asOfDate 重新校验到期边界和可用余额，并追加不可变 EXPIRE 事实。",
      input: { propertyId, entitlementLotId: lot.id, asOfDate }
    });
  }

  return <Modal title={isAdjustment ? "调整会员权益" : "执行权益到期"} onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <dl className="member-action-context">
        <div><dt>Lot</dt><dd><code>{lot.id}</code></dd></div>
        <div><dt>权益类型</dt><dd>{lot.unit_kind}</dd></div>
        <div><dt>合同到期日</dt><dd>{formatDate(lot.expires_on)}</dd></div>
      </dl>
      <InlineError error={validationError} title="无法继续" />
      {isAdjustment ? <div className="form-grid">
        <label htmlFor="entitlement-quantity-delta">调整数量（正数增加，负数减少）<input id="entitlement-quantity-delta" type="number" step="1" value={quantityDelta} onChange={(event) => setQuantityDelta(event.target.value)} required inputMode="numeric" /></label>
        <label htmlFor="entitlement-adjustment-reason">调整原因<textarea id="entitlement-adjustment-reason" rows={3} value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} required maxLength={1000} /></label>
      </div> : <div className="form-grid">
        <label htmlFor="entitlement-as-of-date">到期核算日期<input id="entitlement-as-of-date" type="date" min={addLocalDateDays(lot.expires_on, 1)} max={balanceAsOfDate} value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} required /></label>
        <p className="member-form-note">核算日期必须晚于 Lot 到期日且不晚于物业当前日期；实际到期数量以服务端 Preview 为准。</p>
      </div>}
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">继续生成 Preview</button></div>
    </form>
  </Modal>;
}

export function MembersPage() {
  const { principal, propertyId, refreshMeta } = useWorkspace();
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
  const [searchInput, setSearchInput] = useState("");
  const [searchIdentity, setSearchIdentity] = useState("");
  const [members, setMembers] = useState<MemberSummaryDto[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [selectedContractId, setSelectedContractId] = useState("");
  const [member, setMember] = useState<MemberViewDto>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMember, setLoadingMember] = useState(false);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [action, setAction] = useState<{ type: MemberAction; lot: EntitlementLotDto }>();
  const [creatingMember, setCreatingMember] = useState(false);
  const [addingLot, setAddingLot] = useState(false);
  const [command, setCommand] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const commandsBlocked = commandRecovery.blocked;

  useEffect(() => {
    setAction(undefined);
    setCreatingMember(false);
    setAddingLot(false);
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    setRecoveryError(undefined);
  }, [propertyId]);

  const loadMembers = useCallback(async () => {
    setLoadingList(true);
    setError(undefined);
    try {
      const response = await api.members(propertyId, searchIdentity || undefined);
      setMembers(response.members);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoadingList(false);
    }
  }, [propertyId, searchIdentity]);

  useEffect(() => { void loadMembers(); }, [loadMembers, refreshToken]);

  const effectiveMemberId = members.some((summary) => summary.member.id === selectedMemberId)
    ? selectedMemberId
    : members[0]?.member.id ?? "";

  useEffect(() => {
    if (!effectiveMemberId) {
      setMember(undefined);
      setLoadingMember(false);
      return;
    }
    let current = true;
    setLoadingMember(true);
    setError(undefined);
    api.member(effectiveMemberId, propertyId)
      .then((response) => current && setMember(response))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoadingMember(false));
    return () => { current = false; };
  }, [effectiveMemberId, propertyId, refreshToken]);

  const activeContracts = member?.contracts.filter((contract) => contract.status === "ACTIVE") ?? [];
  const effectiveContract = activeContracts.find((contract) => contract.id === selectedContractId) ?? activeContracts[0];
  const expiredLotIds = useMemo(
    () => new Set((member?.ledger ?? []).filter((entry) => entry.entry_type === "EXPIRE").map((entry) => entry.lot_id)),
    [member?.ledger]
  );

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelectedMemberId("");
    setSearchIdentity(searchInput.trim().toUpperCase());
  }

  function refresh() {
    setRefreshToken((value) => value + 1);
    void refreshMeta();
  }

  function startCommand(request: CommandRequest) {
    if (commandsBlocked) return;
    setRecoveryDialogOpen(false);
    setCommand(request);
  }

  function applyCommittedReceipt(receipt: { result?: Record<string, unknown> }) {
    const nextMemberId = receipt.result && typeof receipt.result.memberId === "string" ? receipt.result.memberId : undefined;
    if (nextMemberId) setSelectedMemberId(nextMemberId);
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  function closeCommandDialog() {
    let refreshAfterClose = false;
    if (commandRecovery.pending && isTerminalCommandRecovery(commandRecovery.pending.state)) {
      refreshAfterClose = commandRecovery.pending.receipt?.businessCommitted === true;
      if (refreshAfterClose && commandRecovery.pending.receipt) applyCommittedReceipt(commandRecovery.pending.receipt);
      if (commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复权益写入，命令继续保持暂停"));
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) refresh();
  }

  return <div className="members-page">
    <header className="page-heading page-heading-actions">
      <div><p className="eyebrow">Membership</p><h1>会员权益</h1><p>身份证唯一匹配、服务端余额与不可变权益事实</p></div>
      <button className="button button-secondary" type="button" onClick={refresh} disabled={loadingList || loadingMember}><RefreshCw className={loadingList || loadingMember ? "spin" : ""} aria-hidden="true" size={17} />刷新</button>
      <button className="button button-secondary" type="button" onClick={() => setCreatingMember(true)} disabled={commandsBlocked} data-testid="create-member"><UserPlus aria-hidden="true" size={17} />登记会员</button>
      <button className="button button-primary" type="button" onClick={() => setAddingLot(true)} disabled={commandsBlocked || !effectiveContract || !member || effectiveContract.valid_until < member.balanceAsOfDate} data-testid="add-entitlement-lot"><Plus aria-hidden="true" size={17} />新增权益批次</button>
    </header>

    <InlineError error={recoveryError} title="恢复记录未收口" />
    <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />
    {commandRecovery.pending ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="member-command-recovery" /> : null}

    <form className="member-selector" role="search" aria-label="按身份证号搜索会员" onSubmit={search}>
      <label htmlFor="member-identity-search">身份证号<input id="member-identity-search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="精确身份证号；留空显示全部" data-testid="member-identity-search" /></label>
      <button className="button button-secondary" type="submit" disabled={loadingList}><Search aria-hidden="true" size={17} />搜索</button>
      {searchIdentity ? <button className="button button-secondary" type="button" onClick={() => { setSearchInput(""); setSearchIdentity(""); }}>清除</button> : null}
    </form>

    {members.length ? <section className="member-selector" aria-label="会员选择">
      <label htmlFor="member-select">会员<select id="member-select" value={effectiveMemberId} onChange={(event) => { setSelectedMemberId(event.target.value); setSelectedContractId(""); }}>
        {members.map((summary) => <option key={summary.member.id} value={summary.member.id}>{summary.member.full_name} · {summary.member.identity_card_number}</option>)}
      </select></label>
      {member?.contracts.length ? <label htmlFor="member-contract-select">有效合同<select id="member-contract-select" value={effectiveContract?.id ?? ""} onChange={(event) => setSelectedContractId(event.target.value)}>
        {activeContracts.map((contract) => <option key={contract.id} value={contract.id}>{formatDate(contract.valid_from)} 至 {formatDate(contract.valid_until)} · {contract.id}</option>)}
      </select></label> : null}
      {effectiveContract ? <StatusBadge value={effectiveContract.status} /> : null}
    </section> : null}

    <InlineError error={error} title="无法载入会员权益" />
    {loadingList || loadingMember ? <LoadingBlock label="正在载入会员权益" /> : !members.length ? <EmptyState title="未找到会员" detail="可按身份证号登记新会员，或清除搜索条件查看全部。" /> : member ? <>
      <section className="member-contract-band" aria-labelledby="member-profile-heading">
        <div><span>会员档案</span><strong id="member-profile-heading">{member.member.full_name}</strong><code>{member.member.id}</code></div>
        <div><span>身份证号</span><strong>{member.member.identity_card_number}</strong><small>唯一业务键</small></div>
        <div><span>联系方式</span><strong>{member.member.phone}</strong><small>{member.member.wechat}</small></div>
        <div><span>合同</span><strong>{member.contracts.length}</strong><small>{effectiveContract ? `${formatDate(effectiveContract.valid_from)} 至 ${formatDate(effectiveContract.valid_until)}` : "无有效合同"}</small></div>
      </section>

      <section className="member-summary" aria-label="会员权益汇总">
        <div><span>余额日期</span><strong>{formatDate(member.balanceAsOfDate)}</strong></div>
        <div><span>可用 ROOM_NIGHT</span><strong>{member.availableBalance.ROOM_NIGHT}</strong></div>
        <div><span>可用 BED_NIGHT</span><strong>{member.availableBalance.BED_NIGHT}</strong></div>
        <div><span>权益 Lot</span><strong>{member.lots.length}</strong></div>
        <div><span>权益事实</span><strong>{member.ledger.length}</strong></div>
      </section>

      {member.externalReferences.length ? <section className="member-section" aria-labelledby="member-references-heading">
        <div className="section-title-row"><h2 id="member-references-heading">外部申请引用</h2><span>{member.externalReferences.length}</span></div>
        <div className="compact-list">{member.externalReferences.map((reference) => <div key={reference.id}><span>{reference.provider}</span><code>{reference.external_record_id}</code><small>{reference.source_container_id} · {reference.source_table_id}</small></div>)}</div>
      </section> : null}

      <section className="member-section" aria-labelledby="entitlement-lots-heading">
        <div className="section-title-row"><h2 id="entitlement-lots-heading">权益 Lots</h2><span>{member.lots.length}</span></div>
        {member.lots.length ? <div className="table-region" role="region" aria-label="会员权益 Lots" tabIndex={0}>
          <table className="data-table member-lots-table">
            <thead><tr><th scope="col">Lot / 类型</th><th scope="col">Lot 初始基数</th><th scope="col">服务端可用余额</th><th scope="col">到期日</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
            <tbody>{member.lots.map((lot) => {
              const explicitlyExpired = expiredLotIds.has(lot.id);
              const lotUiState = entitlementLotUiState(member, lot, explicitlyExpired);
              return <tr key={lot.id}>
                <th scope="row"><strong>{lot.unit_kind}</strong><code>{lot.id}</code></th>
                <td>{lot.total_units}</td>
                <td><strong className="tabular-number">{serverAvailableUnits(member, lot.id)}</strong></td>
                <td>{formatDate(lot.expires_on)}</td>
                <td><StatusBadge value={lotUiState.expired ? "EXPIRED" : "ACTIVE"} /></td>
                <td><div className="row-actions"><button className="button button-compact button-secondary" type="button" onClick={() => setAction({ type: "ADJUST_MEMBER_ENTITLEMENT", lot })} disabled={commandsBlocked || !lotUiState.canAdjust}><SlidersHorizontal aria-hidden="true" size={16} />调整</button><button className="icon-button danger-icon" type="button" onClick={() => setAction({ type: "EXPIRE_MEMBER_ENTITLEMENT", lot })} disabled={commandsBlocked || !lotUiState.canRecordExpiration} aria-label={`记录到期权益 lot ${lot.id}`} title={lotUiState.canRecordExpiration ? "记录自然到期事实" : explicitlyExpired ? "已记录到期事实" : "尚未自然到期"}><CalendarX2 aria-hidden="true" size={17} /></button></div></td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <EmptyState title="该会员没有权益 Lot" detail="选择有效合同后可新增独立权益批次。" />}
      </section>

      <section className="member-section" aria-labelledby="entitlement-ledger-heading">
        <div className="section-title-row"><h2 id="entitlement-ledger-heading">权益 Ledger</h2><span>{member.ledger.length}</span></div>
        {member.ledger.length ? <div className="table-region" role="region" aria-label="会员权益事实" tabIndex={0}>
          <table className="data-table member-ledger-table">
            <thead><tr><th scope="col">Fact ID</th><th scope="col">类型</th><th scope="col">数量变化</th><th scope="col">服务日期</th><th scope="col">订单 / Coverage</th><th scope="col">原因</th></tr></thead>
            <tbody>{member.ledger.map((entry) => <tr key={entry.fact_id}><th scope="row"><code>{entry.fact_id}</code><small>{formatDateTime(entry.created_at)}</small></th><td><StatusBadge value={entry.entry_type} /></td><td><strong className={entry.quantity_delta < 0 ? "quantity-negative" : "quantity-positive"}>{signedQuantity(entry.quantity_delta)}</strong></td><td>{entry.service_date ?? "-"}</td><td><code>{entry.order_id ?? "-"}</code><small>{entry.coverage_id ?? "-"}</small></td><td className="member-ledger-reason">{entry.reason}</td></tr>)}</tbody>
          </table>
        </div> : <EmptyState title="尚无权益事实" detail="冻结、释放、核销、调整或到期后会在此形成永久事实。" />}
      </section>
    </> : null}

    {creatingMember ? <CreateMemberDialog propertyId={propertyId} onClose={() => setCreatingMember(false)} onSubmit={(request) => { if (commandsBlocked) return; setCreatingMember(false); startCommand(request); }} /> : null}
    {action && member ? <EntitlementActionDialog action={action.type} lot={action.lot} propertyId={propertyId} balanceAsOfDate={member.balanceAsOfDate} onClose={() => setAction(undefined)} onSubmit={(request) => { if (commandsBlocked) return; setAction(undefined); startCommand(request); }} /> : null}
    {addingLot && effectiveContract && member ? <AddEntitlementLotDialog contract={effectiveContract} propertyId={propertyId} balanceAsOfDate={member.balanceAsOfDate} onClose={() => setAddingLot(false)} onSubmit={(request) => { if (commandsBlocked) return; setAddingLot(false); startCommand(request); }} /> : null}
    {command ? <CommandDialog
      key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}` : "new-member-command"}
      request={command}
      onClose={closeCommandDialog}
      {...(recoveryDialogOpen && commandRecovery.pending ? {
        initialConfirmationKey: commandRecovery.pending.confirmationKey,
        ...(commandRecovery.pending.receipt ? { initialReceipt: commandRecovery.pending.receipt } : {})
      } : {})}
      onProgress={(progress) => commandRecovery.track(command, progress)}
    /> : null}
  </div>;
}
