import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CalendarDays, FilePlus2, Filter, LockOpen, RefreshCw, Search, ShieldCheck, Wrench } from "lucide-react";
import { api, type ClientCommandMetadata } from "../api";
import { addLocalDateDays, defaultInventoryDates } from "../dates";
import { useWorkspace } from "../session";
import type {
  BookingChannelCode,
  CommandRequest,
  InventoryUnitDto,
  MaintenanceLockDto,
  PricingPolicyVersionDto,
  QuoteDto,
  ReceiptDto,
  StayType,
  UnitAvailabilityDto
} from "../types";
import {
  CommandDialog,
  type CommandRecoveryStorage,
  CommandRecoveryBar,
  EmptyState,
  formatDateTime,
  formatMoney,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  Modal,
  recoveryCommandRequest,
  StatusBadge,
  usePersistentCommandRecovery
} from "../ui";

const stayLabels: Record<StayType, string> = {
  TRANSIENT: "临住",
  WEEKLY: "周住",
  MONTHLY: "月住",
  CUSTOM: "自定义周期",
  FIXED_TERM: "固定期限",
  ROLLING: "滚动续期",
  FREE: "免费住宿"
};
const paidStayTypes: StayType[] = ["TRANSIENT", "WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING"];

const bookingChannelLabels: Record<BookingChannelCode, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
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
  version: 1;
  subjectId: string;
  propertyId: string;
  input: QuoteCommandInput;
  inputSignature: string;
  metadata: ClientCommandMetadata;
  state: "SENDING" | "UNKNOWN";
}

type QuoteRecoveryReadResult =
  | { kind: "ABSENT" }
  | { kind: "VALID"; pending: PendingQuoteCommand }
  | { kind: "CORRUPT"; error: Error }
  | { kind: "READ_ERROR"; error: Error };

const QUOTE_RECOVERY_STORAGE_PREFIX = "qintopia.quote-command-recovery.v1";

export interface QuoteRequestLease {
  scope: string;
  generation: number;
}

export class QuoteRequestGuard {
  private mounted = false;
  private scope: string;
  private generation = 0;

  constructor(initialScope: string) {
    this.scope = initialScope;
  }

  mount() {
    this.mounted = true;
  }

  unmount() {
    this.mounted = false;
    this.generation += 1;
  }

  enterScope(scope: string) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation += 1;
  }

  begin(scope: string): QuoteRequestLease {
    this.enterScope(scope);
    this.generation += 1;
    return { scope, generation: this.generation };
  }

  isActive(lease: QuoteRequestLease): boolean {
    return this.mounted && lease.scope === this.scope && lease.generation === this.generation;
  }
}

export function quoteRecoveryStorageKey(subjectId: string, propertyId: string): string {
  return `${QUOTE_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(propertyId)}`;
}

function validQuoteInput(value: unknown): value is QuoteCommandInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.propertyId === "string"
    && typeof input.inventoryUnitId === "string"
    && typeof input.stayType === "string"
    && typeof input.arrivalDate === "string"
    && typeof input.departureDate === "string"
    && typeof input.pricingPolicyVersionId === "string"
    && (input.memberContractId === undefined || typeof input.memberContractId === "string");
}

export function readQuoteCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, propertyId: string): QuoteRecoveryReadResult {
  let serialized: string | null;
  try {
    serialized = storage.getItem(quoteRecoveryStorageKey(subjectId, propertyId));
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法读取本地报价恢复记录；已暂停新报价和订单写入") };
  }
  if (serialized === null) return { kind: "ABSENT" };
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录已损坏；无法确认原报价命令是否执行") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录结构无效") };
  }
  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  if (record.version !== 1
    || record.subjectId !== subjectId
    || record.propertyId !== propertyId
    || !validQuoteInput(record.input)
    || record.input.propertyId !== propertyId
    || typeof record.inputSignature !== "string"
    || record.inputSignature !== quoteInputSignature(record.input)
    || !metadata
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || typeof (metadata as Record<string, unknown>).idempotencyKey !== "string"
    || !(metadata as Record<string, unknown>).idempotencyKey
    || typeof (metadata as Record<string, unknown>).correlationId !== "string"
    || (record.state !== "SENDING" && record.state !== "UNKNOWN")) {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录版本或字段无效；已暂停新报价和订单写入") };
  }
  return { kind: "VALID", pending: record as unknown as PendingQuoteCommand };
}

export function saveQuoteCommandRecovery(storage: CommandRecoveryStorage, pending: PendingQuoteCommand): boolean {
  try {
    storage.setItem(quoteRecoveryStorageKey(pending.subjectId, pending.propertyId), JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

function clearQuoteCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, propertyId: string): boolean {
  try {
    storage.removeItem(quoteRecoveryStorageKey(subjectId, propertyId));
    return true;
  } catch {
    return false;
  }
}

function browserQuoteRecovery(subjectId: string, propertyId: string, storageFactory: () => Storage = () => window.sessionStorage): { storage?: CommandRecoveryStorage; read: QuoteRecoveryReadResult } {
  try {
    const storage = storageFactory();
    return { storage, read: readQuoteCommandRecovery(storage, subjectId, propertyId) };
  } catch {
    return { read: { kind: "READ_ERROR", error: new Error("无法访问浏览器 sessionStorage；已暂停新报价和订单写入") } };
  }
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
  commandsBlocked,
  resetToken,
  onCommand
}: {
  unit: UnitAvailabilityDto | undefined;
  arrivalDate: string;
  departureDate: string;
  policies: PricingPolicyVersionDto[];
  commandsBlocked: boolean;
  resetToken: number;
  onCommand: (request: CommandRequest) => void;
}) {
  const { meta, principal, propertyId } = useWorkspace();
  const quoteRecoveryScope = quoteRecoveryStorageKey(principal.subjectId, propertyId);
  const productPolicies = policies;
  const stayTypes = useMemo(() => {
    const supported = new Set(productPolicies.flatMap((policy) => policy.stay_type ? [policy.stay_type] : []));
    if (productPolicies.some((policy) => policy.stay_type === null)) paidStayTypes.forEach((stayType) => supported.add(stayType));
    const ordered = paidStayTypes.filter((stayType) => supported.has(stayType));
    if (supported.has("FREE")) ordered.push("FREE");
    return ordered;
  }, [productPolicies]);
  const [stayType, setStayType] = useState<StayType>(stayTypes[0] ?? "TRANSIENT");
  const matchingPolicies = productPolicies.filter((policy) => policy.stay_type === stayType || (policy.stay_type === null && stayType !== "FREE"));
  const [policyId, setPolicyId] = useState(matchingPolicies[0]?.id ?? "");
  const [memberContractId, setMemberContractId] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [quote, setQuote] = useState<QuoteDto>();
  const [quoteReceipt, setQuoteReceipt] = useState<ReceiptDto>();
  const [quoteRecoverySnapshot, setQuoteRecoverySnapshot] = useState<{ scope: string; read: QuoteRecoveryReadResult }>(() => ({
    scope: quoteRecoveryScope,
    read: browserQuoteRecovery(principal.subjectId, propertyId).read
  }));
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestDocument, setGuestDocument] = useState("");
  const [bookingChannelCode, setBookingChannelCode] = useState<BookingChannelCode | "">("");
  const [channelOrderReference, setChannelOrderReference] = useState("");
  const [freeStayReason, setFreeStayReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const latestQuoteSignature = useRef("");
  const quoteRequestGuardRef = useRef<QuoteRequestGuard | null>(null);
  if (!quoteRequestGuardRef.current) quoteRequestGuardRef.current = new QuoteRequestGuard(quoteRecoveryScope);
  const quoteRequestGuard = quoteRequestGuardRef.current;
  quoteRequestGuard.enterScope(quoteRecoveryScope);
  const quoteRecoveryReady = quoteRecoverySnapshot.scope === quoteRecoveryScope;
  const quoteRecoveryRead = quoteRecoveryReady
    ? quoteRecoverySnapshot.read
    : { kind: "READ_ERROR", error: new Error("正在核对本地报价恢复记录") } as const;
  const pendingQuote = quoteRecoveryRead.kind === "VALID" ? quoteRecoveryRead.pending : undefined;
  const quoteRecoveryError = quoteRecoveryRead.kind === "CORRUPT" || quoteRecoveryRead.kind === "READ_ERROR" ? quoteRecoveryRead.error : undefined;
  const quoteCommandsBlocked = commandsBlocked || !quoteRecoveryReady || quoteRecoveryRead.kind !== "ABSENT";

  useEffect(() => {
    quoteRequestGuard.mount();
    return () => quoteRequestGuard.unmount();
  }, [quoteRequestGuard]);

  useEffect(() => {
    setBusy(false);
    setQuoteRecoverySnapshot({
      scope: quoteRecoveryScope,
      read: browserQuoteRecovery(principal.subjectId, propertyId).read
    });
  }, [principal.subjectId, propertyId, quoteRecoveryScope]);

  useEffect(() => {
    if (resetToken === 0) return;
    setQuote(undefined);
    setQuoteReceipt(undefined);
    setGuestName("");
    setGuestPhone("");
    setGuestDocument("");
    setBookingChannelCode("");
    setChannelOrderReference("");
    setFreeStayReason("");
    setError(undefined);
  }, [resetToken]);

  useEffect(() => {
    const firstStay = stayTypes[0];
    if (firstStay && !stayTypes.includes(stayType)) setStayType(firstStay);
  }, [stayType, stayTypes]);

  useEffect(() => {
    const firstPolicy = matchingPolicies[0];
    if (!matchingPolicies.some((policy) => policy.id === policyId)) setPolicyId(firstPolicy?.id ?? "");
  }, [matchingPolicies, policyId]);

  useEffect(() => {
    if (stayType === "FREE") setMemberContractId("");
  }, [stayType]);

  useEffect(() => {
    setQuote(undefined);
    setQuoteReceipt(undefined);
    setError(undefined);
  }, [unit?.id, arrivalDate, departureDate, stayType, policyId, memberContractId]);

  const selectedPolicy = policies.find((policy) => policy.id === policyId);
  const memberProfiles = new Map(meta.members.map((member) => [member.id, member]));
  const normalizedMemberSearch = memberSearch.trim().toUpperCase();
  const memberContracts = meta.memberContracts.filter((contract) => {
    if (contract.property_id !== propertyId || contract.status !== "ACTIVE") return false;
    if (!normalizedMemberSearch) return true;
    const member = contract.member_id ? memberProfiles.get(contract.member_id) : undefined;
    return contract.id.toUpperCase().includes(normalizedMemberSearch)
      || contract.member_name.toUpperCase().includes(normalizedMemberSearch)
      || Boolean(member?.identity_card_number.toUpperCase().includes(normalizedMemberSearch));
  });
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
    if (!currentQuoteInput || quoteCommandsBlocked) return;
    const input = currentQuoteInput;
    const inputSignature = quoteInputSignature(input);
    const metadata = api.commandMetadata("create-quote");
    const pending: PendingQuoteCommand = {
      version: 1,
      subjectId: principal.subjectId,
      propertyId,
      input,
      inputSignature,
      metadata,
      state: "SENDING"
    };
    const beforeSend = browserQuoteRecovery(principal.subjectId, propertyId);
    if (!beforeSend.storage || beforeSend.read.kind !== "ABSENT") {
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: beforeSend.read });
      setError(beforeSend.read.kind === "ABSENT" ? new Error("无法访问本地报价恢复存储，报价命令尚未发送") : undefined);
      return;
    }
    if (!saveQuoteCommandRecovery(beforeSend.storage, pending)) {
      const read = { kind: "READ_ERROR", error: new Error("无法保存本地报价恢复记录，报价命令尚未发送") } as const;
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read });
      setError(read.error);
      return;
    }
    setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "VALID", pending } });
    const requestLease = quoteRequestGuard.begin(quoteRecoveryScope);
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.quote(input, metadata);
      if (!quoteRequestGuard.isActive(requestLease)) return;
      const completed = browserQuoteRecovery(principal.subjectId, propertyId);
      if (completed.storage && completed.read.kind === "VALID" && completed.read.pending.metadata.idempotencyKey === metadata.idempotencyKey) {
        if (clearQuoteCommandRecovery(completed.storage, principal.subjectId, propertyId)) {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
        } else {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("报价已返回，但无法清除本地恢复记录；新报价和订单写入继续暂停") } });
        }
      } else if (completed.read.kind !== "ABSENT") {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: completed.read });
      } else {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
      }
      if (latestQuoteSignature.current === inputSignature) {
        setQuote(response.quote);
        setQuoteReceipt(response.receipt);
      } else {
        setError(new Error("报价已完成，但筛选条件在请求期间发生变化；旧结果未应用，请重新报价。"));
      }
    } catch (nextError) {
      if (!quoteRequestGuard.isActive(requestLease)) return;
      setError(nextError);
      const current = browserQuoteRecovery(principal.subjectId, propertyId);
      if (current.storage && current.read.kind === "VALID" && current.read.pending.metadata.idempotencyKey === metadata.idempotencyKey) {
        const unknown = { ...current.read.pending, state: "UNKNOWN" as const };
        if (saveQuoteCommandRecovery(current.storage, unknown)) {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "VALID", pending: unknown } });
        } else {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("报价响应未知且无法更新本地恢复记录；写入口继续暂停") } });
        }
      } else if (current.read.kind !== "ABSENT") {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: current.read });
      } else {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
      }
    } finally {
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  async function recoverQuote() {
    if (!pendingQuote) return;
    const requestLease = quoteRequestGuard.begin(quoteRecoveryScope);
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await api.commandResult(
        pendingQuote.input.propertyId,
        "CREATE_QUOTE",
        pendingQuote.metadata.idempotencyKey
      );
      if (!quoteRequestGuard.isActive(requestLease)) return;
      if (receipt.executionStatus === "UNKNOWN") {
        const current = browserQuoteRecovery(principal.subjectId, propertyId);
        if (current.storage && current.read.kind === "VALID" && current.read.pending.metadata.idempotencyKey === pendingQuote.metadata.idempotencyKey) {
          const unknown = { ...current.read.pending, state: "UNKNOWN" as const };
          if (saveQuoteCommandRecovery(current.storage, unknown)) setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "VALID", pending: unknown } });
          else setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("无法更新本地报价恢复记录；写入口继续暂停") } });
        }
        setError(new Error("报价命令仍在执行或状态未知，请保留原幂等键后再次查询。"));
        return;
      }
      const completed = browserQuoteRecovery(principal.subjectId, propertyId);
      if (!completed.storage || completed.read.kind !== "VALID" || completed.read.pending.metadata.idempotencyKey !== pendingQuote.metadata.idempotencyKey) {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: completed.read });
        setError(new Error("命令结果已返回，但本地报价恢复记录无法安全收口"));
        return;
      }
      if (!clearQuoteCommandRecovery(completed.storage, principal.subjectId, propertyId)) {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("无法清除已收口的本地报价恢复记录；写入口继续暂停") } });
        return;
      }
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
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
      if (!quoteRequestGuard.isActive(requestLease)) return;
      setError(nextError);
      const current = browserQuoteRecovery(principal.subjectId, propertyId);
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: current.read });
    } finally {
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  function createOrder() {
    if (quoteCommandsBlocked || !quote || !guestName.trim() || !bookingChannelCode || (quote.stayType === "FREE" && !freeStayReason.trim())) return;
    const primaryGuest: Record<string, unknown> = { fullName: guestName.trim() };
    if (guestPhone.trim()) primaryGuest.phone = guestPhone.trim();
    if (guestDocument.trim()) primaryGuest.documentNumber = guestDocument.trim();
    onCommand({
      commandType: "CREATE_ORDER",
      title: "创建订单",
      description: "确认主要居住人快照、锁定计价政策版本、库存及会员覆盖差异。",
      input: {
        propertyId,
        quoteId: quote.quoteId,
        primaryGuest,
        bookingChannelCode,
        channelOrderReference: bookingChannelCode === "WECOM" ? null : channelOrderReference.trim() || null,
        ...(quote.stayType === "FREE" ? { freeStayReason: freeStayReason.trim() } : {})
      }
    });
  }

  return (
    <aside className="quote-workbench" aria-labelledby="quote-heading">
      <header className="panel-heading">
        <div><p className="eyebrow">Quote</p><h2 id="quote-heading">报价工作区</h2></div>
        {unit ? <span className={`unit-kind kind-${unit.kind.toLowerCase()}`}>{unit.kind === "ROOM" ? "整房" : "床位"}</span> : null}
      </header>
      <InlineError error={error} title="报价失败" />
      <InlineError error={quoteRecoveryError} title="本地报价恢复记录不可用" />
      {pendingQuote ? (
        <div className="recovery-bar" data-testid="quote-recovery">
          <div><strong>{pendingQuote.state === "SENDING" ? "报价命令处理中或响应待确认" : "报价命令结果待恢复"}</strong><p>保留原幂等键，只查询执行结果，不创建第二个 Quote。</p><code>{pendingQuote.metadata.idempotencyKey}</code></div>
          <button className="button button-secondary" type="button" onClick={() => void recoverQuote()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />查询命令结果
          </button>
        </div>
      ) : null}
      {!unit ? <EmptyState title="选择可售库存" detail="在房态表中选择整房或床位后开始报价。" /> : (
        <>
          <div className="selected-unit"><strong>{unitName(unit)}</strong><span>{arrivalDate} 至 {departureDate}</span></div>
          <div className="form-grid quote-form">
            <label>住宿类型
              <select value={stayType} onChange={(event) => setStayType(event.target.value as StayType)} disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}>
                {stayTypes.map((type) => <option key={type} value={type}>{stayLabels[type]}</option>)}
              </select>
            </label>
            <label>计价政策版本
              <select value={policyId} onChange={(event) => setPolicyId(event.target.value)} required disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}>
                {matchingPolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.code} · v{policy.version}</option>)}
              </select>
            </label>
            <label>搜索会员
              <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="身份证号 / 姓名" disabled={stayType === "FREE" || busy || quoteRecoveryRead.kind !== "ABSENT"} data-testid="member-search" />
            </label>
            <label>会员合同
              <select value={memberContractId} onChange={(event) => setMemberContractId(event.target.value)} disabled={stayType === "FREE" || busy || quoteRecoveryRead.kind !== "ABSENT"}>
                <option value="">不使用会员权益</option>
                {memberContracts.map((contract) => {
                  const member = contract.member_id ? memberProfiles.get(contract.member_id) : undefined;
                  return <option key={contract.id} value={contract.id}>{member ? `${member.full_name} · ${member.identity_card_number}` : `${contract.member_name} · 历史未关联档案`} · ${contract.id}</option>;
                })}
              </select>
            </label>
            <button className="button button-primary" type="button" onClick={() => void createQuote()} disabled={busy || quoteCommandsBlocked || !policyId || !unit.available} data-testid="request-quote">
              <Search aria-hidden="true" size={17} />{busy ? "正在报价" : "获取服务端报价"}
            </button>
          </div>
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
                {quote.cashLines.map((line) => {
                  const period = "serviceDate" in line ? line.serviceDate : `${line.arrivalDate} 至 ${line.departureDate}`;
                  return <div className="cash-line" key={`${period}-${line.inventoryUnitId}`}><span>{period}</span><span>{line.description}</span><strong>{formatMoney(line.amount)}</strong></div>;
                })}
              </section>
              <div className="quote-expiry">Quote ID <code>{quote.quoteId}</code><span>有效至 {formatDateTime(quote.expiresAt)}</span>{quoteReceipt ? <><span>Receipt</span><code>{quoteReceipt.receiptId}</code></> : null}</div>
              <section className="guest-section" aria-labelledby="guest-heading">
                <h3 id="guest-heading">主要居住人快照</h3>
                <div className="form-grid">
                  <label>姓名<input value={guestName} onChange={(event) => setGuestName(event.target.value)} required maxLength={160} data-testid="primary-guest-name" /></label>
                  <label>联系电话<input value={guestPhone} onChange={(event) => setGuestPhone(event.target.value)} inputMode="tel" maxLength={80} /></label>
                  <label>证件号码<input value={guestDocument} onChange={(event) => setGuestDocument(event.target.value)} maxLength={120} /></label>
                  <label>订单来源渠道
                    <select
                      value={bookingChannelCode}
                      onChange={(event) => {
                        const code = event.target.value as BookingChannelCode | "";
                        setBookingChannelCode(code);
                        if (code === "WECOM") setChannelOrderReference("");
                      }}
                      data-testid="booking-channel-code"
                    >
                      <option value="">请选择渠道</option>
                      {Object.entries(bookingChannelLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                    </select>
                  </label>
                  {bookingChannelCode && bookingChannelCode !== "WECOM" ? <label>渠道订单号（可选）<input value={channelOrderReference} onChange={(event) => setChannelOrderReference(event.target.value)} maxLength={200} data-testid="channel-order-reference" /></label> : null}
                  {quote.stayType === "FREE" ? <label className="span-two">免费入住原因<textarea rows={3} value={freeStayReason} onChange={(event) => setFreeStayReason(event.target.value)} required maxLength={1000} data-testid="free-stay-reason" /></label> : null}
                </div>
                <button className="button button-primary full-width" type="button" onClick={createOrder} disabled={quoteCommandsBlocked || !guestName.trim() || !bookingChannelCode || (quote.stayType === "FREE" && !freeStayReason.trim())} data-testid="create-order">
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
  const { meta, principal, propertyId } = useWorkspace();
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
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
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [command, setCommand] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [maintenanceUnit, setMaintenanceUnit] = useState<UnitAvailabilityDto>();
  const [maintenanceLocks, setMaintenanceLocks] = useState<MaintenanceLockDto[]>([]);
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [maintenanceError, setMaintenanceError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [quoteResetToken, setQuoteResetToken] = useState(0);
  const commandsBlocked = commandRecovery.blocked;

  useEffect(() => {
    if (previousPropertyId.current === propertyId) return;
    previousPropertyId.current = propertyId;
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    setRecoveryError(undefined);
    setMaintenanceUnit(undefined);
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
    if (commandsBlocked) return;
    const unit = inventoryUnitMap.get(lock.inventory_unit_id);
    setRecoveryDialogOpen(false);
    setCommand({
      commandType: "RELEASE_MAINTENANCE",
      title: `释放维修锁 · ${unit?.code ?? lock.inventory_unit_id}`,
      description: "服务端将重新校验维修锁版本，确认后释放对应日期范围的库存 claim。",
      input: { propertyId, maintenanceLockId: lock.id }
    });
  }

  function startCommand(request: CommandRequest) {
    if (commandsBlocked) return;
    setRecoveryDialogOpen(false);
    setCommand(request);
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  function closeCommandDialog() {
    let refreshAfterClose = false;
    if (commandRecovery.pending && isTerminalCommandRecovery(commandRecovery.pending.state)) {
      const receipt = commandRecovery.pending.receipt;
      refreshAfterClose = receipt?.businessCommitted === true;
      if (refreshAfterClose && commandRecovery.pending.commandType === "CREATE_ORDER") {
        setQuoteResetToken((value) => value + 1);
      }
      if (commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复库存写入，命令继续保持暂停"));
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) setRefreshToken((value) => value + 1);
  }

  return (
    <div className="inventory-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">Inventory</p><h1>房态与可售</h1><p>整房 / 子床位逐日互斥视图</p></div>
        <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新
        </button>
      </header>
      <InlineError error={recoveryError} title="恢复记录未收口" />
      <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />
      {commandRecovery.pending ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="inventory-command-recovery" /> : null}

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
                      <td className="row-actions"><button className="icon-button" type="button" onClick={() => setMaintenanceUnit(unit)} disabled={commandsBlocked} aria-label={`维修锁房 ${unit.code}`} title="维修锁房"><Wrench aria-hidden="true" size={17} /></button><button className="button button-compact button-secondary" type="button" onClick={() => setSelectedUnitId(unit.id)} disabled={!unit.available} data-testid={`quote-unit-${unit.code}`}>报价</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <QuoteWorkbench unit={selectedUnit} arrivalDate={arrivalDate} departureDate={departureDate} policies={policies} commandsBlocked={commandsBlocked} resetToken={quoteResetToken} onCommand={startCommand} />
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
                return <tr key={lock.id}><th scope="row"><code>{lock.id}</code><small>{formatDateTime(lock.created_at)}</small></th><td><strong>{unit ? `${unit.code} · ${unit.name}` : lock.inventory_unit_id}</strong></td><td>{lock.arrival_date} 至 {lock.departure_date}</td><td className="maintenance-reason">{lock.reason}</td><td><StatusBadge value={lock.status} /></td><td><button className="button button-compact button-secondary" type="button" onClick={() => releaseMaintenance(lock)} disabled={commandsBlocked} aria-label={`释放维修锁 ${unit?.code ?? lock.id}`}><LockOpen aria-hidden="true" size={16} />释放</button></td></tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      {maintenanceUnit ? <MaintenanceDialog unit={maintenanceUnit} arrivalDate={arrivalDate} departureDate={departureDate} onClose={() => setMaintenanceUnit(undefined)} onSubmit={(request) => { if (commandsBlocked) return; setMaintenanceUnit(undefined); startCommand(request); }} /> : null}
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}` : "new-inventory-command"}
        request={command}
        onClose={closeCommandDialog}
        {...(recoveryDialogOpen && commandRecovery.pending ? {
          initialConfirmationKey: commandRecovery.pending.confirmationKey,
          ...(commandRecovery.pending.receipt ? { initialReceipt: commandRecovery.pending.receipt } : {})
        } : {})}
        onProgress={(progress) => commandRecovery.track(command, progress)}
      /> : null}
    </div>
  );
}
