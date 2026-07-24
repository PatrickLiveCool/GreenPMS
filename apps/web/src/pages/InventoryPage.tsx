import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { FilePlus2, RefreshCw, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type {
  CreateOrderPrimaryGuestInputDto,
  RoomStatusActionDto,
  RoomStatusBoardDto,
  RoomStatusBoardQueryDto,
  RoomStatusConflictDto,
  RoomStatusDayDto,
  RoomStatusIntervalDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import { api, ApiError, type ClientCommandMetadata } from "../api";
import { addLocalDateDays, localDateInTimeZone } from "../dates";
import { useWorkspace } from "../session";
import type {
  BookingChannelCode,
  CommandRequest,
  MemberContractDto,
  MemberDto,
  PricingPolicyVersionDto,
  QuoteDto,
  ReceiptDto,
  StayType
} from "../types";
import {
  CommandDialog,
  type CommandDialogProgress,
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
  usePersistentCommandRecovery
} from "../ui";
import {
  assertRoomStatusBoard,
  createRoomStatusViewState,
  filterRoomStatusRooms,
  hasActiveRoomStatusFilters,
  isIsoLocalDate,
  parseRoomStatusRestoration,
  reconcileRoomStatusRestoration,
  roomStatusFactFingerprint,
  roomStatusUnitLabel,
  RoomStatusContext,
  RoomStatusGrid,
  RoomStatusMobileTasks,
  RoomStatusToolbar,
  roomStatusViewReducer,
  selectionFromCells,
  serializeRoomStatusRestoration,
  useRoomStatusMobileViewport,
  type RoomStatusMobileGroups,
  type RoomStatusMobileFocusRequest,
  type RoomStatusMobileTab,
  type RoomStatusRange,
  type RoomStatusRestorationSnapshot,
  type RoomStatusSelection,
  type RoomStatusViewState
} from "../room-status";

const bookingChannelLabels: Record<BookingChannelCode, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
};

export function bookingChannelRequiredForStay(useMemberEntitlement: boolean): boolean {
  return !useMemberEntitlement;
}

interface QuoteCommandInput {
  propertyId: string;
  inventoryUnitId: string;
  stayType?: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberId?: string;
}

export function eligibleMemberProfiles(
  members: MemberDto[],
  contracts: Pick<MemberContractDto, "property_id" | "member_id">[],
  propertyId: string,
  query: string
): MemberDto[] {
  const propertyMemberIds = new Set(contracts
    .filter((contract) => contract.property_id === propertyId && contract.member_id)
    .map((contract) => contract.member_id));
  const normalizedQuery = query.trim().toUpperCase();
  return members.filter((member) => propertyMemberIds.has(member.id) && (
    !normalizedQuery
    || member.full_name.toUpperCase().includes(normalizedQuery)
    || member.identity_card_number.toUpperCase().includes(normalizedQuery)
    || member.phone.toUpperCase().includes(normalizedQuery)
    || member.wechat.toUpperCase().includes(normalizedQuery)
  ));
}

export function effectiveQuoteMemberId(members: MemberDto[], requestedMemberId: string): string {
  return members.some((member) => member.id === requestedMemberId) ? requestedMemberId : "";
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

export class RoomStatusCommandAttemptGuard {
  private generation = 0;
  private activeAttemptId: number | null = null;

  begin(): number {
    const attemptId = ++this.generation;
    this.activeAttemptId = attemptId;
    return attemptId;
  }

  invalidate(): void {
    this.activeAttemptId = null;
  }

  runIfActive(attemptId: number, action: () => void): boolean {
    if (this.activeAttemptId !== attemptId) return false;
    action();
    return true;
  }
}

export class RoomStatusQueryAttemptGuard {
  private generation = 0;
  private activeAttemptId: number | null = null;

  begin(): number {
    const attemptId = ++this.generation;
    this.activeAttemptId = attemptId;
    return attemptId;
  }

  isInFlight(): boolean {
    return this.activeAttemptId !== null;
  }

  isActive(attemptId: number): boolean {
    return this.activeAttemptId === attemptId;
  }

  finish(attemptId: number): boolean {
    if (!this.isActive(attemptId)) return false;
    this.activeAttemptId = null;
    return true;
  }

  invalidate(attemptId: number): boolean {
    return this.finish(attemptId);
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
    && (input.stayType === undefined || typeof input.stayType === "string")
    && typeof input.arrivalDate === "string"
    && typeof input.departureDate === "string"
    && typeof input.pricingPolicyVersionId === "string"
    && !Object.hasOwn(input, "memberContractId")
    && (input.memberId === undefined || typeof input.memberId === "string");
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

export function paidStayTypeForDates(arrivalDate: string, departureDate: string): "TRANSIENT" | "CUSTOM" {
  const nights = rangeNights({ arrivalDate, departureDate });
  return nights < 7 ? "TRANSIENT" : "CUSTOM";
}

export function quotePricingSummary(quote: QuoteDto): {
  nights: number;
  pricingBasis: string;
  amount: QuoteDto["currentContractAmount"];
} {
  const nights = rangeNights(quote);
  const stayTotal = quote.cashLines.find((line) => line.lineKind === "STAY_TOTAL");
  const anchor = stayTotal?.lineKind === "STAY_TOTAL" ? stayTotal.pricingBandAnchorNights : 1;
  return {
    nights,
    pricingBasis: anchor === 1 ? "按临住价格" : `按 ${anchor} 夜价格档`,
    amount: quote.currentContractAmount
  };
}

export function membershipCoverageSummary(quote: QuoteDto) {
  const totalNights = rangeNights(quote);
  const coveredNights = quote.coverageSet.length;
  return {
    totalNights,
    coveredNights,
    uncoveredNights: totalNights - coveredNights,
    uncoveredAmount: quote.cashRemainder
  };
}

export function staffQuoteError(error: ApiError, unitCode: string, arrivalDate: string, departureDate: string): Error {
  if (error.code === "PRICING_POLICY_UNCONFIGURED" || error.code === "POLICY_VERSION_NOT_FOUND") {
    return new Error(`${unitCode} 在 ${arrivalDate} 至 ${departureDate} 暂无已生效价格，请调整日期。`);
  }
  if (error.code === "INVENTORY_CONFLICT") return new Error(error.message);
  if (error.code === "VALIDATION_ERROR") return new Error(`入住和退房日期无效，请确认退房日期晚于入住日期。`);
  return new Error(error.message);
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

interface InventoryActionUnit {
  id: string;
  kind: "ROOM" | "BED";
  code: string;
  name: string;
  buildingCode: string | null;
  available: boolean;
}

function unitName(unit: InventoryActionUnit | undefined) {
  return unit ? roomStatusUnitLabel(unit) : "未选择库存单元";
}

export function roomStatusBlockDraftWithinSelection(
  from: string,
  to: string,
  selectionArrivalDate: string,
  selectionDepartureDate: string
): boolean {
  return isIsoLocalDate(from)
    && isIsoLocalDate(to)
    && selectionArrivalDate <= from
    && from < to
    && to <= selectionDepartureDate;
}

function MaintenanceDialog({ unit, arrivalDate, departureDate, writeBlocked, onClose, onSubmit }: {
  unit: InventoryActionUnit;
  arrivalDate: string;
  departureDate: string;
  writeBlocked: boolean;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => boolean;
}) {
  const { propertyId } = useWorkspace();
  const [from, setFrom] = useState(arrivalDate);
  const [to, setTo] = useState(departureDate);
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<Error>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomStatusBlockDraftWithinSelection(from, to, arrivalDate, departureDate)) {
      setValidationError(new Error(`维修日期必须位于已验证选区 [${arrivalDate}, ${departureDate}) 内，且至少包含一晚。`));
      return;
    }
    setValidationError(undefined);
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
        <InlineError
          error={writeBlocked ? new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口。日期和原因草稿仍保留，重新取得可写房态后再继续。") : undefined}
          title="草稿已保留，写入已暂停"
        />
        <InlineError error={validationError} title="维修日期未通过房态校验" />
        <div className="form-grid form-grid-two">
          <label>开始日期<input type="date" value={from} min={arrivalDate} max={addLocalDateDays(departureDate, -1)} onChange={(event) => { setFrom(event.target.value); setValidationError(undefined); }} required /></label>
          <label>结束日期<input type="date" value={to} min={isIsoLocalDate(from) ? addLocalDateDays(from, 1) : arrivalDate} max={departureDate} onChange={(event) => { setTo(event.target.value); setValidationError(undefined); }} required /></label>
          <label className="span-two">维修原因<textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} /></label>
        </div>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={writeBlocked}>继续生成 Preview</button></div>
      </form>
    </Modal>
  );
}

function InternalUseDialog({ unit, arrivalDate, departureDate, writeBlocked, onClose, onSubmit }: {
  unit: InventoryActionUnit;
  arrivalDate: string;
  departureDate: string;
  writeBlocked: boolean;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => boolean;
}) {
  const { propertyId } = useWorkspace();
  const [from, setFrom] = useState(arrivalDate);
  const [to, setTo] = useState(departureDate);
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<Error>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomStatusBlockDraftWithinSelection(from, to, arrivalDate, departureDate)) {
      setValidationError(new Error(`内部占用日期必须位于已验证选区 [${arrivalDate}, ${departureDate}) 内，且至少包含一晚。`));
      return;
    }
    setValidationError(undefined);
    onSubmit({
      commandType: "PLACE_INTERNAL_USE",
      title: `放置内部占用 · ${unit.code}`,
      description: "服务端将重新校验整房与子床位互斥，并以完整半开区间创建内部占用 Block。",
      input: { propertyId, inventoryUnitId: unit.id, arrivalDate: from, departureDate: to, reason }
    });
  }

  return (
    <Modal title={`内部占用 · ${unitName(unit)}`} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        <InlineError
          error={writeBlocked ? new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口。日期和原因草稿仍保留，重新取得可写房态后再继续。") : undefined}
          title="草稿已保留，写入已暂停"
        />
        <InlineError error={validationError} title="内部占用日期未通过房态校验" />
        <div className="form-grid form-grid-two">
          <label>开始日期<input type="date" value={from} min={arrivalDate} max={addLocalDateDays(departureDate, -1)} onChange={(event) => { setFrom(event.target.value); setValidationError(undefined); }} required /></label>
          <label>结束日期<input type="date" value={to} min={isIsoLocalDate(from) ? addLocalDateDays(from, 1) : arrivalDate} max={departureDate} onChange={(event) => { setTo(event.target.value); setValidationError(undefined); }} required /></label>
          <label className="span-two">内部占用原因<textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} /></label>
        </div>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={writeBlocked}>继续生成 Preview</button></div>
      </form>
    </Modal>
  );
}

function QuoteWorkbench({
  unit,
  arrivalDate,
  departureDate,
  policies,
  initialStayType,
  commandsBlocked,
  resetToken,
  onClose,
  onRecoveryOutcome,
  onCommand
}: {
  unit: InventoryActionUnit | undefined;
  arrivalDate: string;
  departureDate: string;
  policies: PricingPolicyVersionDto[];
  initialStayType?: StayType;
  commandsBlocked: boolean;
  resetToken: number;
  onClose: () => void;
  onRecoveryOutcome: (outcome: Error | undefined) => void;
  onCommand: (request: CommandRequest) => void;
}) {
  const { meta, principal, propertyId } = useWorkspace();
  const quoteRecoveryScope = quoteRecoveryStorageKey(principal.subjectId, propertyId);
  const stayType: StayType = initialStayType === "FREE" ? "FREE" : paidStayTypeForDates(arrivalDate, departureDate);
  const selectedPolicy = policies.find((policy) => stayType === "FREE"
    ? policy.calculation_kind === "FREE" && policy.stay_type === "FREE"
    : policy.calculation_kind === "DURATION_BAND_TOTAL" && policy.stay_type === null);
  const policyId = selectedPolicy?.id ?? "";
  const [useMemberEntitlement, setUseMemberEntitlement] = useState(false);
  const [memberId, setMemberId] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [quote, setQuote] = useState<QuoteDto>();
  const [quoteSignature, setQuoteSignature] = useState("");
  const [quoteRecoverySnapshot, setQuoteRecoverySnapshot] = useState<{ scope: string; read: QuoteRecoveryReadResult }>(() => ({
    scope: quoteRecoveryScope,
    read: browserQuoteRecovery(principal.subjectId, propertyId).read
  }));
  const [guestName, setGuestName] = useState("");
  const [guestNickname, setGuestNickname] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestDocument, setGuestDocument] = useState("");
  const [bookingChannelCode, setBookingChannelCode] = useState<BookingChannelCode | "">("");
  const [channelOrderReference, setChannelOrderReference] = useState("");
  const [freeStayReason, setFreeStayReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const latestQuoteSignature = useRef("");
  const settledQuoteSignature = useRef("");
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
    settledQuoteSignature.current = "";
    setQuote(undefined);
    setQuoteSignature("");
    setGuestName("");
    setGuestNickname("");
    setGuestPhone("");
    setGuestDocument("");
    setBookingChannelCode("");
    setChannelOrderReference("");
    setFreeStayReason("");
    setUseMemberEntitlement(false);
    setMemberId("");
    setMemberSearch("");
    setError(undefined);
  }, [resetToken]);

  useEffect(() => {
    if (stayType === "FREE") {
      setUseMemberEntitlement(false);
      setMemberId("");
      setMemberSearch("");
    }
  }, [stayType]);

  useEffect(() => {
    setUseMemberEntitlement(false);
    setMemberId("");
    setMemberSearch("");
    setGuestName("");
    setGuestNickname("");
    setGuestPhone("");
    setGuestDocument("");
    setBookingChannelCode("");
    setChannelOrderReference("");
    setFreeStayReason("");
    setError(undefined);
  }, [unit?.id, arrivalDate, departureDate, stayType, policyId]);

  useEffect(() => {
    setError(undefined);
  }, [memberId, useMemberEntitlement]);

  useEffect(() => {
    if (!useMemberEntitlement) return;
    setBookingChannelCode("");
    setChannelOrderReference("");
  }, [useMemberEntitlement]);

  const memberProfiles = eligibleMemberProfiles(meta.members, meta.memberContracts, propertyId, memberSearch);
  const quoteMemberId = effectiveQuoteMemberId(memberProfiles, memberId);

  useEffect(() => {
    if (memberId && !quoteMemberId) setMemberId("");
  }, [memberId, quoteMemberId]);

  const currentQuoteInput: QuoteCommandInput | undefined = unit && policyId && (!useMemberEntitlement || quoteMemberId) ? {
    propertyId,
    inventoryUnitId: unit.id,
    ...(stayType === "FREE" ? { stayType } : {}),
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: policyId,
    ...(useMemberEntitlement && quoteMemberId ? { memberId: quoteMemberId } : {})
  } : undefined;
  const currentQuoteSignature = currentQuoteInput ? quoteInputSignature(currentQuoteInput) : "";
  const quoteIsCurrent = Boolean(quote && quoteSignature === currentQuoteSignature);
  latestQuoteSignature.current = currentQuoteSignature;

  async function createQuote(signal?: AbortSignal) {
    if (!currentQuoteInput || quoteCommandsBlocked) return;
    onRecoveryOutcome(undefined);
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
      const response = await api.quote(input, metadata, signal);
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
        settledQuoteSignature.current = inputSignature;
        setQuoteSignature(inputSignature);
        setQuote(response.quote);
      } else {
        setError(undefined);
      }
    } catch (nextError) {
      if (!quoteRequestGuard.isActive(requestLease)) return;
      const current = browserQuoteRecovery(principal.subjectId, propertyId);
      if (nextError instanceof ApiError) {
        if (current.storage && current.read.kind === "VALID" && current.read.pending.metadata.idempotencyKey === metadata.idempotencyKey) {
          clearQuoteCommandRecovery(current.storage, principal.subjectId, propertyId);
        }
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
        settledQuoteSignature.current = inputSignature;
        setError(staffQuoteError(nextError, unit?.code ?? "所选房源", arrivalDate, departureDate));
        return;
      }
      setError(nextError);
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
    onRecoveryOutcome(undefined);
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
        onRecoveryOutcome(new Error("服务端确认该报价命令未执行，可以重新报价。"));
        return;
      }
      const recoveredQuote = quoteFromReceipt(receipt);
      if (latestQuoteSignature.current !== pendingQuote.inputSignature) {
        onRecoveryOutcome(new Error("报价已恢复，但当前筛选条件已变化；旧结果未应用，请重新报价。"));
        return;
      }
      settledQuoteSignature.current = pendingQuote.inputSignature;
      setQuoteSignature(pendingQuote.inputSignature);
      setQuote(recoveredQuote);
    } catch (nextError) {
      if (!quoteRequestGuard.isActive(requestLease)) return;
      setError(nextError);
      const current = browserQuoteRecovery(principal.subjectId, propertyId);
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: current.read });
    } finally {
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  useEffect(() => {
    if (!pendingQuote || pendingQuote.state !== "SENDING" || busy) return;
    const timeout = window.setTimeout(() => void recoverQuote(), 500);
    return () => window.clearTimeout(timeout);
  }, [pendingQuote?.metadata.idempotencyKey, pendingQuote?.state, busy]);

  useEffect(() => {
    if (!currentQuoteInput || quoteCommandsBlocked || settledQuoteSignature.current === currentQuoteSignature) return;
    const timeout = window.setTimeout(() => void createQuote(), 300);
    return () => window.clearTimeout(timeout);
  }, [currentQuoteSignature, quoteCommandsBlocked]);

  function createOrder() {
    const channelRequired = bookingChannelRequiredForStay(useMemberEntitlement);
    if (quoteCommandsBlocked || !quote || !quoteIsCurrent || !guestName.trim() || !guestNickname.trim() || (channelRequired && !bookingChannelCode) || (quote.stayType === "FREE" && !freeStayReason.trim())) return;
    const primaryGuest: CreateOrderPrimaryGuestInputDto = {
      fullName: guestName.trim(),
      nickname: guestNickname.trim()
    };
    if (guestPhone.trim()) primaryGuest.phone = guestPhone.trim();
    if (guestDocument.trim()) primaryGuest.documentNumber = guestDocument.trim();
    onCommand({
      commandType: "CREATE_ORDER",
      title: "创建订单",
      description: "确认主要居住人快照、锁定计价政策版本、库存及会员覆盖差异。",
      ...(useMemberEntitlement ? { presentation: "MEMBER_STAY" as const } : {}),
      input: {
        propertyId,
        quoteId: quote.quoteId,
        primaryGuest,
        ...(!useMemberEntitlement && bookingChannelCode ? {
          bookingChannelCode,
          channelOrderReference: bookingChannelCode === "WECOM" ? null : channelOrderReference.trim() || null
        } : {}),
        ...(quote.stayType === "FREE" ? { freeStayReason: freeStayReason.trim() } : {})
      }
    });
  }

  return (
    <aside className="quote-workbench" aria-labelledby="quote-heading">
      <header className="panel-heading">
        <div><p className="eyebrow">办理住宿</p><h2 id="quote-heading">住宿金额</h2></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={busy || Boolean(pendingQuote)} title="关闭办理区域" aria-label="关闭办理区域"><X aria-hidden="true" size={18} /></button>
      </header>
      <InlineError error={error} title="报价失败" />
      <InlineError error={quoteRecoveryError} title="本地报价恢复记录不可用" />
      {pendingQuote?.state === "UNKNOWN" ? (
        <div className="recovery-bar" data-testid="quote-recovery">
          <div><strong>报价结果尚未确认</strong><p>系统不会重复报价；网络恢复后可重新查询本次结果。</p></div>
          <button className="button button-secondary" type="button" onClick={() => void recoverQuote()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />重新查询报价结果
          </button>
        </div>
      ) : null}
      {!unit ? <EmptyState title="选择可售库存" detail="在房态表中选择整房或床位后开始报价。" /> : (
        <>
          <div className="selected-unit"><strong>{unitName(unit)}</strong><span>{arrivalDate} 至 {departureDate}</span></div>
          {stayType !== "FREE" ? <div className="member-benefit-controls">
            <label className="checkbox-label"><input
              type="checkbox"
              checked={useMemberEntitlement}
              onChange={(event) => {
                const enabled = event.target.checked;
                setUseMemberEntitlement(enabled);
                if (enabled) {
                  setBookingChannelCode("");
                  setChannelOrderReference("");
                } else {
                  setMemberId("");
                  setMemberSearch("");
                }
              }}
              disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}
              data-testid="use-member-entitlement"
            />本次住宿使用会员权益</label>
            {useMemberEntitlement ? <div className="form-grid quote-form" data-testid="member-benefit-picker">
              <label>搜索会员
                <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="姓名、身份证号、手机号或微信号" disabled={busy || quoteRecoveryRead.kind !== "ABSENT"} data-testid="member-search" />
              </label>
              <label>会员档案
                <select
                  value={quoteMemberId}
                  onChange={(event) => {
                    const selectedMemberId = event.target.value;
                    setMemberId(selectedMemberId);
                    const selectedMember = memberProfiles.find((member) => member.id === selectedMemberId);
                    if (!selectedMember) return;
                    setGuestNickname(selectedMember.full_name);
                    setGuestName(selectedMember.full_name);
                    setGuestPhone(selectedMember.phone);
                    setGuestDocument(selectedMember.identity_card_number);
                  }}
                  disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}
                  data-testid="member-profile-select"
                >
                  <option value="">请选择会员</option>
                  {memberProfiles.map((member) => <option key={member.id} value={member.id}>{member.full_name} · {member.identity_card_number} · {member.phone}</option>)}
                </select>
              </label>
            </div> : null}
          </div> : null}
          <div
            className={`room-status-pricing-progress${busy ? "" : " is-idle"}`}
            {...(busy ? { role: "status" as const } : { "aria-hidden": true })}
          >正在计算住宿金额</div>
          {quote ? (
            <div
              className={`quote-result${quoteIsCurrent ? "" : " is-layout-placeholder"}`}
              {...(quoteIsCurrent ? { "data-testid": "quote-result" } : { "aria-hidden": true })}
            >
              {(() => {
                const summary = quotePricingSummary(quote);
                const memberSummary = membershipCoverageSummary(quote);
                return (
              <div className="quote-amounts">
                {useMemberEntitlement ? <>
                  <div><span>总住宿晚数</span><strong>{memberSummary.totalNights} 晚</strong></div>
                  <div><span>覆盖晚数</span><strong>{memberSummary.coveredNights} 晚</strong></div>
                  <div><span>未覆盖晚数</span><strong>{memberSummary.uncoveredNights} 晚</strong></div>
                  <div><span>未覆盖金额</span><strong>{formatMoney(memberSummary.uncoveredAmount)}</strong></div>
                </> : <>
                  <div><span>住宿晚数</span><strong>{summary.nights} 晚</strong></div>
                  <div><span>计价依据</span><strong>{summary.pricingBasis}</strong></div>
                  <div><span>住宿金额</span><strong>{formatMoney(summary.amount)}</strong></div>
                </>}
              </div>
                );
              })()}
              <section className="guest-section" aria-labelledby="guest-heading">
                <h3 id="guest-heading">主要居住人快照</h3>
                <div className="form-grid">
                  <label>昵称<input value={guestNickname} onChange={(event) => setGuestNickname(event.target.value)} required maxLength={200} data-testid="primary-guest-nickname" /></label>
                  <label>姓名<input value={guestName} onChange={(event) => setGuestName(event.target.value)} required maxLength={160} data-testid="primary-guest-name" /></label>
                  <label>联系电话<input value={guestPhone} onChange={(event) => setGuestPhone(event.target.value)} inputMode="tel" maxLength={80} /></label>
                  <label>证件号码<input value={guestDocument} onChange={(event) => setGuestDocument(event.target.value)} maxLength={120} /></label>
                  {!useMemberEntitlement ? <label>订单来源渠道
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
                  </label> : null}
                  {!useMemberEntitlement && bookingChannelCode && bookingChannelCode !== "WECOM" ? <label>渠道订单号（可选）<input value={channelOrderReference} onChange={(event) => setChannelOrderReference(event.target.value)} maxLength={200} data-testid="channel-order-reference" /></label> : null}
                  {quote.stayType === "FREE" ? <label className="span-two">免费入住原因<textarea rows={3} value={freeStayReason} onChange={(event) => setFreeStayReason(event.target.value)} required maxLength={1000} data-testid="free-stay-reason" /></label> : null}
                </div>
                <button className="button button-primary full-width" type="button" onClick={createOrder} disabled={quoteCommandsBlocked || !quoteIsCurrent || !guestName.trim() || !guestNickname.trim() || (bookingChannelRequiredForStay(useMemberEntitlement) && !bookingChannelCode) || (quote.stayType === "FREE" && !freeStayReason.trim())} data-testid="create-order">
                  <FilePlus2 aria-hidden="true" size={17} />核对并创建订单
                </button>
              </section>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

const ROOM_STATUS_PAGE_SIZE = 50;
const ROOM_STATUS_POLL_MS = 4_000;
const ROOM_STATUS_QUERY_TIMEOUT_MS = 15_000;
const ROOM_STATUS_RESTORATION_PREFIX = "qintopia.room-status-view.v1";
const selectionActionCodes = new Set(["CREATE_ORDER", "CREATE_FREE_STAY", "PLACE_INTERNAL_USE", "LOCK_MAINTENANCE"]);

interface RoomStatusQuoteTarget {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  initialStayType: StayType;
}

type PendingMobileTaskFocus = Omit<RoomStatusMobileFocusRequest, "token">;

type RoomStatusCommandPhase = "IDLE" | "DRAFT" | "PREVIEW" | "CONFIRMING" | "SETTLED";

function roomStatusQuery(
  range: RoomStatusRange,
  page: number,
  filters: RoomStatusViewState["filters"]
): RoomStatusBoardQueryDto {
  const search = filters.search.trim();
  return {
    arrivalDate: range.arrivalDate,
    departureDate: range.departureDate,
    page,
    pageSize: ROOM_STATUS_PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(filters.roomTypeCode !== "ALL" ? { roomType: filters.roomTypeCode } : {}),
    ...(filters.salesMode !== "ALL" ? { salesMode: filters.salesMode } : {}),
    ...(filters.status !== "ALL" ? { status: filters.status } : {}),
    ...(filters.minimumCapacity !== null ? { minCapacity: filters.minimumCapacity } : {}),
    ...(filters.kind !== "ALL" ? { unitKind: filters.kind } : {})
  };
}

function roomStatusQueryKey(query: RoomStatusBoardQueryDto): string {
  return JSON.stringify([
    query.arrivalDate,
    query.departureDate,
    query.page ?? 0,
    query.pageSize ?? ROOM_STATUS_PAGE_SIZE,
    query.search ?? null,
    query.roomType ?? null,
    query.salesMode ?? null,
    query.status ?? null,
    query.minCapacity ?? null,
    query.unitKind ?? null
  ]);
}

function roomStatusRestorationKey(subjectId: string, propertyId: string): string {
  return `${ROOM_STATUS_RESTORATION_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(propertyId)}`;
}

function defaultRoomStatusRange(timeZone: string): RoomStatusRange {
  const today = localDateInTimeZone(timeZone);
  return { arrivalDate: today, departureDate: addLocalDateDays(today, 14) };
}

function rangeNights(range: RoomStatusRange): number {
  if (!isIsoLocalDate(range.arrivalDate) || !isIsoLocalDate(range.departureDate)) return 0;
  return Math.round((Date.parse(`${range.departureDate}T00:00:00Z`) - Date.parse(`${range.arrivalDate}T00:00:00Z`)) / 86_400_000);
}

function readRoomStatusRestoration(subjectId: string, propertyId: string): RoomStatusRestorationSnapshot | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const serialized = window.sessionStorage.getItem(roomStatusRestorationKey(subjectId, propertyId));
    return serialized ? parseRoomStatusRestoration(serialized, propertyId) : undefined;
  } catch {
    return undefined;
  }
}

function writeRoomStatusRestoration(subjectId: string, snapshot: RoomStatusRestorationSnapshot): boolean {
  try {
    window.sessionStorage.setItem(roomStatusRestorationKey(subjectId, snapshot.propertyId), serializeRoomStatusRestoration(snapshot));
    return true;
  } catch {
    return false;
  }
}

function flattenRoomStatusUnits(board: RoomStatusBoardDto): RoomStatusUnitDto[] {
  return board.rooms.flatMap((room) => [room, ...room.children]);
}

function findRoomStatusUnit(board: RoomStatusBoardDto | undefined, unitId: string | undefined): RoomStatusUnitDto | null {
  if (!board || !unitId) return null;
  return flattenRoomStatusUnits(board).find((unit) => unit.id === unitId) ?? null;
}

function withoutRoomStatusWriteActions(unit: RoomStatusUnitDto, stale: boolean): RoomStatusUnitDto {
  const status = stale ? "STALE" as const : undefined;
  const readActions = (actions: readonly RoomStatusActionDto[]) => actions.filter((action) => action.code === "OPEN_ORDER");
  return {
    ...unit,
    days: unit.days.map((day) => ({
      ...day,
      ...(status ? { status, available: false } : {})
    })),
    intervals: unit.intervals.map((interval) => ({
      ...interval,
      ...(status ? { status, available: false } : {}),
      allowedActions: readActions(interval.allowedActions)
    })),
    allowedActions: readActions(unit.allowedActions),
    children: unit.children.map((child) => withoutRoomStatusWriteActions(child, stale))
  };
}

function displayRoomStatusBoard(board: RoomStatusBoardDto, commandsBlocked: boolean, stale: boolean): RoomStatusBoardDto {
  if (!commandsBlocked && !stale) return board;
  return {
    ...board,
    projectionState: stale ? "PARTIAL" : board.projectionState,
    operationalTasks: board.operationalTasks.map((task) => ({
      ...task,
      ...(stale ? { status: "STALE" as const, available: false } : {}),
      allowedActions: task.allowedActions.filter((action) => action.code === "OPEN_ORDER")
    })),
    rooms: board.rooms.map((room) => withoutRoomStatusWriteActions(room, stale))
  };
}

function uniqueConflicts(conflicts: readonly RoomStatusConflictDto[]): RoomStatusConflictDto[] {
  return [...new Map(conflicts.map((conflict) => [conflict.id, conflict])).values()];
}

function selectionDays(unit: RoomStatusUnitDto | null, selection: RoomStatusSelection | null): RoomStatusDayDto[] {
  if (!unit || !selection || unit.id !== selection.unitId) return [];
  return unit.days.filter((day) => day.serviceDate >= selection.arrivalDate && day.serviceDate < selection.departureDate);
}

function selectionActions(unit: RoomStatusUnitDto | null, selection: RoomStatusSelection | null): RoomStatusActionDto[] {
  const days = selectionDays(unit, selection);
  if (!selection || days.length !== rangeNights(selection) || days.some((day) => !day.available || day.conflicts.length > 0)) return [];
  return unit?.allowedActions.filter((candidate) => candidate.enabled && selectionActionCodes.has(candidate.code)) ?? [];
}

function dayActions(unit: RoomStatusUnitDto | null, day: RoomStatusDayDto | null): RoomStatusActionDto[] {
  if (!unit || !day) return [];
  const create = day.available && day.conflicts.length === 0
    ? unit.allowedActions.filter((candidate) => candidate.enabled && selectionActionCodes.has(candidate.code))
    : [];
  const sourceActions = unit.intervals
    .filter((interval) => day.intervalIds.includes(interval.id))
    .flatMap((interval) => interval.allowedActions);
  return [...new Map([...create, ...sourceActions].map((candidate) => [
    `${candidate.code}:${candidate.targetReference?.type ?? "none"}:${candidate.targetReference?.id ?? "none"}`,
    candidate
  ])).values()];
}

function intervalActions(interval: RoomStatusIntervalDto | null, selection: RoomStatusSelection | null): RoomStatusActionDto[] {
  if (!interval) return [];
  const fullIntervalSelected = Boolean(selection
    && selection.unitId === interval.displayInventoryUnitId
    && selection.arrivalDate === interval.sourceStartDate
    && selection.departureDate === interval.sourceEndDate);
  return interval.allowedActions.map((action) => action.requiresFullInterval && !fullIntervalSelected
    ? {
        ...action,
        enabled: false,
        disabledReason: action.disabledReason ?? `当前选区必须精确匹配来源完整区间 [${interval.sourceStartDate}, ${interval.sourceEndDate})`
      }
    : action);
}

function actionUnit(unit: RoomStatusUnitDto, available: boolean): InventoryActionUnit {
  return { id: unit.id, kind: unit.kind, code: unit.code, name: unit.name, buildingCode: unit.buildingCode, available };
}

function buildMobileGroups(board: RoomStatusBoardDto): RoomStatusMobileGroups {
  const tasks = board.operationalTasks.filter((task) => task.businessDate === board.businessDate);
  return {
    arrivals: tasks.filter((task) => task.taskKind === "ARRIVAL"),
    inHouse: tasks.filter((task) => task.taskKind === "IN_HOUSE"),
    departures: tasks.filter((task) => task.taskKind === "DEPARTURE"),
    exceptions: tasks.filter((task) => task.taskKind === "EXCEPTION")
  };
}

export function InventoryPage() {
  const navigate = useNavigate();
  const isMobile = useRoomStatusMobileViewport();
  const { meta, principal, propertyId } = useWorkspace();
  const property = meta.properties.find((item) => item.id === propertyId);
  const propertyTimezone = property?.timezone ?? "UTC";
  const initialRestoration = useRef(readRoomStatusRestoration(principal.subjectId, propertyId));
  const [range, setRange] = useState<RoomStatusRange>(() => initialRestoration.current?.range ?? defaultRoomStatusRange(propertyTimezone));
  const [viewState, dispatchView] = useReducer(
    roomStatusViewReducer,
    initialRestoration.current?.state ?? createRoomStatusViewState()
  );
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
  const [board, setBoard] = useState<RoomStatusBoardDto>();
  const boardRef = useRef<RoomStatusBoardDto | undefined>(undefined);
  const [boardQueryKey, setBoardQueryKey] = useState<string>();
  const boardQueryKeyRef = useRef<string | undefined>(undefined);
  const queryAttemptGuardRef = useRef<RoomStatusQueryAttemptGuard | null>(null);
  if (!queryAttemptGuardRef.current) queryAttemptGuardRef.current = new RoomStatusQueryAttemptGuard();
  const queryAttemptGuard = queryAttemptGuardRef.current;
  const permissionDeniedRef = useRef(false);
  const pendingRestoration = useRef<RoomStatusRestorationSnapshot | undefined>(initialRestoration.current);
  const restorationPageAdjusted = useRef(false);
  const previousPropertyId = useRef(propertyId);
  const [initializedPropertyId, setInitializedPropertyId] = useState(propertyId);
  const [queryPhase, setQueryPhase] = useState<"LOADING" | "RANGE_LOADING" | "READY" | "REFRESHING" | "ERROR" | "PERMISSION_DENIED">("LOADING");
  const [queryError, setQueryError] = useState<unknown>();
  const [rangeError, setRangeError] = useState<unknown>();
  const [restorationError, setRestorationError] = useState<unknown>();
  const [returnNotice, setReturnNotice] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [quoteRecoveryOutcome, setQuoteRecoveryOutcome] = useState<Error>();
  const [clock, setClock] = useState(() => Date.now());
  const [refreshToken, setRefreshToken] = useState(0);
  const [quoteResetToken, setQuoteResetToken] = useState(0);
  const [command, setCommand] = useState<CommandRequest>();
  const [commandAttemptId, setCommandAttemptId] = useState(0);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [selectedUnitId, setSelectedUnitId] = useState<string>();
  const [selectedDayDate, setSelectedDayDate] = useState<string>();
  const [selectedIntervalId, setSelectedIntervalId] = useState<string>();
  const [maintenanceTarget, setMaintenanceTarget] = useState<InventoryActionUnit>();
  const [internalUseTarget, setInternalUseTarget] = useState<InventoryActionUnit>();
  const [quoteTarget, setQuoteTarget] = useState<RoomStatusQuoteTarget>();
  const [mobileTab, setMobileTab] = useState<RoomStatusMobileTab>("ARRIVALS");
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);
  const [mobileFocusRequest, setMobileFocusRequest] = useState<RoomStatusMobileFocusRequest>();
  const [commandContextInvalidated, setCommandContextInvalidated] = useState(false);
  const [focusRequestToken, setFocusRequestToken] = useState(0);
  const [filterFocusRequestToken, setFilterFocusRequestToken] = useState(0);
  const quoteSectionRef = useRef<HTMLDivElement>(null);
  const commandPhaseRef = useRef<RoomStatusCommandPhase>("IDLE");
  const commandAttemptGuardRef = useRef<RoomStatusCommandAttemptGuard | null>(null);
  if (!commandAttemptGuardRef.current) commandAttemptGuardRef.current = new RoomStatusCommandAttemptGuard();
  const commandAttemptGuard = commandAttemptGuardRef.current;
  const commandRevisionRef = useRef<string | undefined>(undefined);
  const refreshedReceiptIdRef = useRef<string | undefined>(undefined);
  const focusAfterNextBoard = useRef(false);
  const pendingMobileTaskFocus = useRef<PendingMobileTaskFocus | undefined>(undefined);
  const mobileFocusSequence = useRef(0);
  const latestRestoration = useRef<{
    subjectId: string;
    snapshot: RoomStatusRestorationSnapshot;
  } | undefined>(undefined);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  const boardMatchesCurrentProperty = Boolean(board && board.propertyId === propertyId);
  const currentBoardQueryKey = roomStatusQueryKey(roomStatusQuery(range, viewState.roomPageIndex, viewState.filters));
  const boardMatchesCurrentQuery = Boolean(board
    && board.propertyId === propertyId
    && boardQueryKey === currentBoardQueryKey);

  useEffect(() => {
    if (!board || !boardMatchesCurrentQuery) return;
    const delay = Math.max(0, Date.parse(board.freshUntil) - Date.now() + 1);
    const timer = window.setTimeout(() => setClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [board?.freshUntil]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setClock(Date.now());
      if (!permissionDeniedRef.current
        && commandPhaseRef.current !== "CONFIRMING"
        && !queryAttemptGuard.isInFlight()) {
        setRefreshToken((value) => value + 1);
      }
    }, ROOM_STATUS_POLL_MS);
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      setClock(Date.now());
      if (!permissionDeniedRef.current
        && commandPhaseRef.current !== "CONFIRMING"
        && !queryAttemptGuard.isInFlight()) {
        setRefreshToken((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [propertyId]);

  useEffect(() => {
    if (previousPropertyId.current === propertyId) return;
    previousPropertyId.current = propertyId;
    permissionDeniedRef.current = false;
    const restored = readRoomStatusRestoration(principal.subjectId, propertyId);
    pendingRestoration.current = restored;
    setRange(restored?.range ?? defaultRoomStatusRange(propertyTimezone));
    dispatchView({ type: "RESTORE", state: restored?.state ?? createRoomStatusViewState() });
    setBoard(undefined);
    boardRef.current = undefined;
    setBoardQueryKey(undefined);
    boardQueryKeyRef.current = undefined;
    setSelectedUnitId(undefined);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setQuoteTarget(undefined);
    setMaintenanceTarget(undefined);
    setInternalUseTarget(undefined);
    setMobileCreateOpen(false);
    setMobileFocusRequest(undefined);
    pendingMobileTaskFocus.current = undefined;
    commandPhaseRef.current = "IDLE";
    commandAttemptGuard.invalidate();
    commandRevisionRef.current = undefined;
    focusAfterNextBoard.current = false;
    setCommandContextInvalidated(false);
    setCommand(undefined);
    setQueryError(undefined);
    setReturnNotice(undefined);
    setActionError(undefined);
    setQuoteRecoveryOutcome(undefined);
    setInitializedPropertyId(propertyId);
  }, [principal.subjectId, propertyId, propertyTimezone]);

  useEffect(() => {
    if (initializedPropertyId !== propertyId) return;
    const query = roomStatusQuery(range, viewState.roomPageIndex, viewState.filters);
    const requestQueryKey = roomStatusQueryKey(query);
    const requestId = queryAttemptGuard.begin();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort(new Error("房态查询超时，未把未知状态解释为可售"));
    }, ROOM_STATUS_QUERY_TIMEOUT_MS);
    const existing = boardRef.current;
    const sameQuery = existing?.propertyId === propertyId
      && boardQueryKeyRef.current === requestQueryKey;
    const projectionRefreshPaused = commandPhaseRef.current === "CONFIRMING" && Boolean(existing);
    if (!sameQuery) {
      setQueryPhase(existing ? "RANGE_LOADING" : "LOADING");
      setQueryError(undefined);
    } else if (!projectionRefreshPaused) {
      setQueryPhase("REFRESHING");
    }
    api.roomStatus(propertyId, query, controller.signal)
      .then((response) => {
        if (!queryAttemptGuard.isActive(requestId)) return;
        permissionDeniedRef.current = false;
        assertRoomStatusBoard(response, { propertyId, range, pageIndex: viewState.roomPageIndex });
        if (commandPhaseRef.current === "CONFIRMING" && existing) {
          setQueryError(undefined);
          setQueryPhase("READY");
          setClock(Date.now());
          return;
        }
        if (commandRevisionRef.current
          && commandPhaseRef.current !== "IDLE"
          && response.revision !== commandRevisionRef.current) {
          setCommandContextInvalidated(true);
        }
        const restored = pendingRestoration.current;
        if (restored && response.page.totalPages > 0 && response.page.index >= response.page.totalPages) {
          const pageIndex = response.page.totalPages - 1;
          restorationPageAdjusted.current = true;
          pendingRestoration.current = {
            ...restored,
            state: { ...restored.state, roomPageIndex: pageIndex }
          };
          setBoard(undefined);
          boardRef.current = undefined;
          setBoardQueryKey(undefined);
          boardQueryKeyRef.current = undefined;
          setQueryPhase("LOADING");
          dispatchView({ type: "SET_ROOM_PAGE", index: pageIndex, totalPages: response.page.totalPages });
          return;
        }
        setBoard(response);
        boardRef.current = response;
        setBoardQueryKey(requestQueryKey);
        boardQueryKeyRef.current = requestQueryKey;
        setQueryError(undefined);
        setQueryPhase("READY");
        setClock(Date.now());
        if (focusAfterNextBoard.current) {
          focusAfterNextBoard.current = false;
          setFocusRequestToken((value) => value + 1);
        }
        if (restored) {
          pendingRestoration.current = undefined;
          const pageAdjusted = restorationPageAdjusted.current;
          restorationPageAdjusted.current = false;
          const resolution = reconcileRoomStatusRestoration(response.rooms, response.dates, {
            ...restored.state,
            roomPageIndex: response.page.index
          }, restored.factFingerprint);
          dispatchView({ type: "RESTORE", state: resolution.state });
          if (resolution.outcome === "FACT_CHANGED") {
            setReturnNotice(restored.revision === response.revision
              ? "已重新校验返回位置。原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧 Preview 不会继续使用。"
              : "房态 revision 已变化，且原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧 Preview 不会继续使用。");
          } else if (resolution.outcome === "FALLBACK") {
            setReturnNotice(`原焦点或选区在当前筛选、展开、分页或日期窗口中已不可见。${pageAdjusted ? "原分页已失效；" : ""}${resolution.filtersCleared ? "原筛选已无结果并已清除；" : ""}已清除旧选区并将焦点移至当前视图首个可见房间和日期。旧 Preview 不会继续使用。`);
          } else if (resolution.outcome === "EMPTY") {
            setReturnNotice("原房态返回位置已失效，且当前页没有可聚焦的库存日期格。已清除旧焦点和选区；旧 Preview 不会继续使用。");
          } else if (restored.revision === response.revision) {
            const adjusted = pageAdjusted || resolution.dateWindowAdjusted || resolution.scrollAnchorAdjusted;
            setReturnNotice(adjusted
              ? "已恢复上次房态范围、筛选、展开、选区和焦点；不可用的分页、日期窗口或滚动锚点已校正到当前可见内容。"
              : "已恢复上次房态范围、筛选、展开、滚动、选区和焦点。它们均已验证为当前可见且可聚焦。"
            );
          } else {
            setReturnNotice("房态 revision 已变化。已刷新并确认原选区与焦点在当前筛选、展开、分页和日期窗口中仍可见；任何旧 Preview 均已作废。");
          }
        }
      })
      .catch((error) => {
        if (!queryAttemptGuard.isActive(requestId)) return;
        setQueryError(error);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          permissionDeniedRef.current = true;
          latestRestoration.current = undefined;
          setBoard(undefined);
          boardRef.current = undefined;
          setBoardQueryKey(undefined);
          boardQueryKeyRef.current = undefined;
          pendingRestoration.current = undefined;
          try {
            window.sessionStorage.removeItem(roomStatusRestorationKey(principal.subjectId, propertyId));
          } catch {
            // Permission denial still clears all in-memory business state.
          }
          dispatchView({ type: "RESTORE", state: createRoomStatusViewState() });
          setSelectedUnitId(undefined);
          setSelectedDayDate(undefined);
          setSelectedIntervalId(undefined);
          setQuoteTarget(undefined);
          setMaintenanceTarget(undefined);
          setInternalUseTarget(undefined);
          setMobileCreateOpen(false);
          commandPhaseRef.current = "IDLE";
          commandAttemptGuard.invalidate();
          commandRevisionRef.current = undefined;
          focusAfterNextBoard.current = false;
          setCommandContextInvalidated(false);
          setCommand(undefined);
          setRecoveryDialogOpen(false);
          setActionError(undefined);
          setReturnNotice(undefined);
          setRestorationError(undefined);
          setQueryPhase("PERMISSION_DENIED");
        } else {
          setQueryPhase("ERROR");
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        queryAttemptGuard.finish(requestId);
      });
    return () => {
      window.clearTimeout(timeout);
      queryAttemptGuard.invalidate(requestId);
      controller.abort();
    };
  }, [
    initializedPropertyId,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    refreshToken,
    viewState.roomPageIndex,
    viewState.filters.search,
    viewState.filters.roomTypeCode,
    viewState.filters.salesMode,
    viewState.filters.status,
    viewState.filters.kind,
    viewState.filters.minimumCapacity
  ]);

  useEffect(() => {
    if (!board || !boardMatchesCurrentQuery) return;
    const snapshot: RoomStatusRestorationSnapshot = {
      version: 1,
      propertyId,
      revision: board.revision,
      range,
      savedAt: new Date().toISOString(),
      state: viewState,
      factFingerprint: roomStatusFactFingerprint(board.rooms, viewState)
    };
    latestRestoration.current = { subjectId: principal.subjectId, snapshot };
    const timer = window.setTimeout(() => {
      const saved = writeRoomStatusRestoration(principal.subjectId, snapshot);
      setRestorationError(saved ? undefined : new Error("浏览器无法保存房态返回位置；本次业务事实未受影响"));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [board, boardMatchesCurrentQuery, principal.subjectId, propertyId, range, viewState]);

  useEffect(() => () => {
    const latest = latestRestoration.current;
    if (latest
      && latest.subjectId === principal.subjectId
      && latest.snapshot.propertyId === propertyId) {
      writeRoomStatusRestoration(latest.subjectId, latest.snapshot);
    }
  }, [principal.subjectId, propertyId]);

  const boardForCurrentProperty = boardMatchesCurrentProperty ? board : undefined;
  const boardExpired = Boolean(boardForCurrentProperty && clock > Date.parse(boardForCurrentProperty.freshUntil));
  const boardStale = Boolean(boardForCurrentProperty && (boardExpired || queryError));
  const rangeLoading = queryPhase === "RANGE_LOADING"
    || Boolean(boardForCurrentProperty && !boardMatchesCurrentQuery);
  const queryBusy = queryPhase === "LOADING"
    || queryPhase === "RANGE_LOADING"
    || queryPhase === "REFRESHING"
    || Boolean(board && !boardMatchesCurrentQuery);
  const projectionWritable = Boolean(board
    && boardMatchesCurrentQuery
    && !boardStale
    && !focusAfterNextBoard.current
    && board.projectionState === "READY"
    && board.accessLevel === "WRITE"
    && (queryPhase === "READY" || queryPhase === "REFRESHING"));
  const commandsBlocked = commandRecovery.blocked || !projectionWritable;
  const renderedBoard = useMemo(
    () => boardForCurrentProperty
      ? displayRoomStatusBoard(boardForCurrentProperty, commandsBlocked && !command, boardStale)
      : undefined,
    [boardForCurrentProperty, boardStale, command, commandsBlocked]
  );
  const filteredViewHasNoRooms = Boolean(renderedBoard
    && hasActiveRoomStatusFilters(viewState.filters)
    && filterRoomStatusRooms(renderedBoard.rooms, viewState.filters).length === 0);
  const selectedUnit = findRoomStatusUnit(renderedBoard, selectedUnitId ?? viewState.selection?.unitId);
  const selectedDay = selectedUnit?.days.find((day) => day.serviceDate === selectedDayDate) ?? null;
  const selectedInterval = selectedUnit?.intervals.find((interval) => interval.id === selectedIntervalId) ?? null;
  const selectedSelectionDays = selectionDays(selectedUnit, viewState.selection);
  const relatedIntervals = useMemo(() => {
    if (!selectedUnit) return [];
    const intervalIds = new Set(selectedInterval
      ? [selectedInterval.id]
      : viewState.selection
        ? selectedSelectionDays.flatMap((day) => day.intervalIds)
        : selectedDay?.intervalIds ?? []);
    return selectedUnit.intervals.filter((interval) => intervalIds.has(interval.id));
  }, [selectedDay?.intervalIds, selectedInterval, selectedSelectionDays, selectedUnit, viewState.selection]);
  const contextConflicts = uniqueConflicts(selectedInterval?.conflicts
    ?? (viewState.selection ? relatedIntervals.flatMap((interval) => interval.conflicts) : selectedDay?.conflicts ?? []));
  const candidateContextActions = selectedInterval
      ? intervalActions(selectedInterval, viewState.selection)
      : viewState.selection
        ? selectionActions(selectedUnit, viewState.selection)
        : dayActions(selectedUnit, selectedDay).filter((action) => action.enabled);
  const contextActions = projectionWritable || Boolean(command)
    ? candidateContextActions
    : candidateContextActions.filter((action) => action.code === "OPEN_ORDER");
  const policies = meta.pricingPolicyVersions.filter((policy) => policy.property_id === propertyId && policy.status === "PUBLISHED");
  const filterOptions = renderedBoard?.filterOptions ?? {
    roomTypeCodes: [],
    salesModes: [],
    statuses: [],
    capacities: []
  };
  const filteredRoomCount = renderedBoard?.page.totalRooms ?? 0;
  const todayDate = localDateInTimeZone(propertyTimezone);
  const mobileGroups = useMemo(() => renderedBoard ? buildMobileGroups(renderedBoard) : { arrivals: [], inHouse: [], departures: [], exceptions: [] }, [renderedBoard]);
  const activeMobileTasks = mobileTab === "ARRIVALS"
    ? mobileGroups.arrivals
    : mobileTab === "IN_HOUSE"
      ? mobileGroups.inHouse
      : mobileTab === "DEPARTURES"
        ? mobileGroups.departures
        : mobileGroups.exceptions;
  const quoteUnit = findRoomStatusUnit(renderedBoard, quoteTarget?.unitId);
  const pageQuoteRecovery = browserQuoteRecovery(principal.subjectId, propertyId).read;
  const showQuoteWorkbench = Boolean(quoteTarget) || pageQuoteRecovery.kind !== "ABSENT";
  const quoteActionUnit = quoteTarget && quoteUnit ? actionUnit(quoteUnit, projectionWritable) : undefined;

  function clearTransientRoomStatusContext() {
    setSelectedUnitId(undefined);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setQuoteTarget(undefined);
    setMaintenanceTarget(undefined);
    setInternalUseTarget(undefined);
    setMobileCreateOpen(false);
    setActionError(undefined);
    setQuoteRecoveryOutcome(undefined);
  }

  function applyFilters(filters: typeof viewState.filters) {
    dispatchView({ type: "SET_FILTERS", filters });
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: board?.page.totalPages ?? 1 });
    clearTransientRoomStatusContext();
  }

  function clearFilters() {
    dispatchView({ type: "CLEAR_FILTERS" });
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: board?.page.totalPages ?? 1 });
    clearTransientRoomStatusContext();
    setFilterFocusRequestToken((value) => value + 1);
  }

  function applyRange(next: RoomStatusRange) {
    if (!isIsoLocalDate(next.arrivalDate) || !isIsoLocalDate(next.departureDate)) {
      setRangeError(new Error("请输入有效的开始日期和结束日期。"));
      return;
    }
    const nights = rangeNights(next);
    if (nights < 1) {
      setRangeError(new Error("结束日期必须晚于开始日期。"));
      return;
    }
    if (nights > 90) {
      setRangeError(new Error("房态日期范围最多为 90 夜。"));
      return;
    }
    setRangeError(undefined);
    setRange(next);
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: 1 });
    dispatchView({ type: "SET_DATE_WINDOW", start: 0, totalDates: nights });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function shiftRange(direction: -1 | 1) {
    const nights = Math.max(1, rangeNights(range));
    applyRange({
      arrivalDate: addLocalDateDays(range.arrivalDate, direction * nights),
      departureDate: addLocalDateDays(range.departureDate, direction * nights)
    });
  }

  function changeRoomPage(index: number, totalPages: number) {
    dispatchView({ type: "SET_ROOM_PAGE", index, totalPages });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function changeDateWindow(start: number, totalDates: number) {
    dispatchView({ type: "SET_DATE_WINDOW", start, totalDates });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function persistViewNow() {
    if (!board || !boardMatchesCurrentQuery) return;
    writeRoomStatusRestoration(principal.subjectId, {
      version: 1,
      propertyId,
      revision: board.revision,
      range,
      savedAt: new Date().toISOString(),
      state: viewState,
      factFingerprint: roomStatusFactFingerprint(board.rooms, viewState)
    });
  }

  function inspectUnit(unit: RoomStatusUnitDto) {
    setQuoteRecoveryOutcome(undefined);
    setSelectedUnitId(unit.id);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
  }

  function inspectDay(unit: RoomStatusUnitDto, day: RoomStatusDayDto | null) {
    setQuoteRecoveryOutcome(undefined);
    setSelectedUnitId(unit.id);
    if (day) selectRange(selectionFromCells(unit.id, day.serviceDate, day.serviceDate));
    setSelectedDayDate(day?.serviceDate);
    setSelectedIntervalId(undefined);
  }

  function inspectInterval(unit: RoomStatusUnitDto, interval: RoomStatusIntervalDto) {
    setQuoteRecoveryOutcome(undefined);
    setSelectedUnitId(unit.id);
    selectRange({
      unitId: unit.id,
      anchorDate: interval.startDate,
      focusDate: addLocalDateDays(interval.endDate, -1),
      arrivalDate: interval.startDate,
      departureDate: interval.endDate
    });
    setSelectedDayDate(undefined);
    setSelectedIntervalId(interval.id);
  }

  function selectRange(selection: RoomStatusSelection | null) {
    setQuoteRecoveryOutcome(undefined);
    dispatchView({ type: "SET_SELECTION", selection });
    if (selection) {
      setSelectedUnitId(selection.unitId);
      setQuoteTarget((current) => ({
        unitId: selection.unitId,
        arrivalDate: selection.arrivalDate,
        departureDate: selection.departureDate,
        initialStayType: current?.initialStayType === "FREE" ? "FREE" : "TRANSIENT"
      }));
    } else {
      setQuoteTarget(undefined);
    }
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
  }

  function openReference(reference: { href: string | null }) {
    if (!reference.href) return;
    persistViewNow();
    if (reference.href.startsWith("/orders/")) navigate(reference.href);
    else window.open(reference.href, "_blank", "noopener,noreferrer");
  }

  function startCommand(request: CommandRequest): boolean {
    if (commandsBlocked) {
      setActionError(new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口；命令未发送，表单草稿保持不变。"));
      return false;
    }
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    commandPhaseRef.current = "DRAFT";
    commandRevisionRef.current = boardRef.current?.revision;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(false);
    setActionError(undefined);
    setCommand(request);
    return true;
  }

  function handleAction(
    action: RoomStatusActionDto,
    unitOverride?: RoomStatusUnitDto | null,
    selectionOverride?: RoomStatusSelection | null,
    unitReferenceLabel?: string
  ): boolean {
    setActionError(undefined);
    if (action.code === "OPEN_ORDER") {
      if (!action.targetReference) return false;
      openReference(action.targetReference);
      return true;
    }
    const actionSelectedUnit = unitOverride === undefined ? selectedUnit : unitOverride;
    if (commandsBlocked) {
      setActionError(new Error("当前房态不再满足安全写入条件。未发送命令，请刷新后重新核对选区。"));
      return false;
    }
    const selection = selectionOverride ?? viewState.selection;
    if (action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY" || action.code === "PLACE_INTERNAL_USE" || action.code === "LOCK_MAINTENANCE") {
      if (!actionSelectedUnit || !selection || selection.unitId !== actionSelectedUnit.id) {
        setActionError(new Error("请选择一个完整的房源与半开日期区间"));
        return false;
      }
      const unit = actionUnit(actionSelectedUnit, true);
      if (action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY") {
        setQuoteRecoveryOutcome(undefined);
        setQuoteTarget({
          unitId: unit.id,
          arrivalDate: selection.arrivalDate,
          departureDate: selection.departureDate,
          initialStayType: action.code === "CREATE_FREE_STAY" ? "FREE" : "TRANSIENT"
        });
        requestAnimationFrame(() => quoteSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      } else if (action.code === "PLACE_INTERNAL_USE") {
        setInternalUseTarget(unit);
      } else {
        setMaintenanceTarget(unit);
      }
      return true;
    }
    const targetId = action.targetReference?.id;
    const unitLabel = actionSelectedUnit?.code ?? unitReferenceLabel;
    if (!targetId || !unitLabel) {
      setActionError(new Error("服务端动作缺少稳定目标引用，未发送命令"));
      return false;
    }
    if (action.code === "RELEASE_MAINTENANCE") {
      return startCommand({
        commandType: "RELEASE_MAINTENANCE",
        title: `释放维修锁 · ${unitLabel}`,
        description: "服务端将重新校验完整维修 Block 版本，确认后释放全部对应 Claim。",
        input: { propertyId, maintenanceLockId: targetId }
      });
    } else if (action.code === "RELEASE_INTERNAL_USE") {
      return startCommand({
        commandType: "RELEASE_INTERNAL_USE",
        title: `释放内部占用 · ${unitLabel}`,
        description: "服务端只接受完整、当前有效的内部占用 Block，并在确认时重新校验。",
        input: { propertyId, internalUseBlockId: targetId }
      });
    } else if (action.code === "COMPLETE_CLEANING") {
      return startCommand({
        commandType: "COMPLETE_CLEANING",
        title: `完成清洁 · ${unitLabel}`,
        description: "确认后将当前清洁任务追加为已完成；夜间库存 Claim 不会因此被改写。",
        input: { propertyId, cleaningTaskId: targetId }
      });
    }
    return false;
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending) return;
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    commandPhaseRef.current = "CONFIRMING";
    commandRevisionRef.current = boardRef.current?.revision;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  function closeCommandDialog() {
    let refreshAfterClose = false;
    const pendingAtClose = commandRecovery.pending;
    const terminalAtClose = Boolean(pendingAtClose && isTerminalCommandRecovery(pendingAtClose.state));
    if (pendingAtClose && terminalAtClose) {
      const receipt = pendingAtClose.receipt;
      refreshAfterClose = receipt?.businessCommitted === true;
      if (refreshAfterClose && pendingAtClose.commandType === "CREATE_ORDER") {
        setQuoteResetToken((value) => value + 1);
        setQuoteTarget(undefined);
      }
      if (commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复库存写入，命令继续保持暂停"));
    }
    commandAttemptGuard.invalidate();
    commandPhaseRef.current = "IDLE";
    commandRevisionRef.current = undefined;
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) {
      if (pendingMobileTaskFocus.current) {
        setMobileFocusRequest({
          ...pendingMobileTaskFocus.current,
          token: ++mobileFocusSequence.current
        });
      } else if (viewState.selection) {
        dispatchView({
          type: "SET_FOCUS",
          focus: { unitId: viewState.selection.unitId, serviceDate: viewState.selection.arrivalDate }
        });
      }
      focusAfterNextBoard.current = true;
      setRefreshToken((value) => value + 1);
    } else if (commandContextInvalidated) {
      setFocusRequestToken((value) => value + 1);
    }
    if (!pendingAtClose || terminalAtClose) pendingMobileTaskFocus.current = undefined;
    setCommandContextInvalidated(false);
  }

  function trackCommandProgress(request: CommandRequest, progress: CommandDialogProgress, attemptId: number): boolean {
    commandAttemptGuard.runIfActive(attemptId, () => {
      if (progress.state === "PREVIEWING" || progress.state === "PREVIEWED") commandPhaseRef.current = "PREVIEW";
      else if (progress.state === "CONFIRMING" || progress.state === "UNKNOWN") commandPhaseRef.current = "CONFIRMING";
      else if (progress.state === "RESOLVED") commandPhaseRef.current = "SETTLED";
      else if (progress.state === "PREVIEW_FAILED" || progress.state === "PREVIEW_UNKNOWN" || progress.state === "FAILED_NOT_EXECUTED") commandPhaseRef.current = "DRAFT";
    });
    return commandRecovery.track(request, progress);
  }

  function refreshCommittedRoomStatus(receipt: ReceiptDto) {
    if (!receipt.businessCommitted || refreshedReceiptIdRef.current === receipt.receiptId) return;
    refreshedReceiptIdRef.current = receipt.receiptId;
    commandPhaseRef.current = "SETTLED";
    setRefreshToken((value) => value + 1);
  }

  const roomStatusToolbar = renderedBoard ? (
    <RoomStatusToolbar
      board={renderedBoard}
      propertyLabel={`${property?.code ?? propertyId} · ${property?.name ?? propertyId}`}
      principalLabel={principal.displayName}
      range={range}
      filters={viewState.filters}
      filterOptions={filterOptions}
      filteredRoomCount={filteredRoomCount}
      loading={queryBusy}
      rangeLoading={rangeLoading}
      rangeError={rangeError instanceof Error ? rangeError.message : undefined}
      focusSearchRequestToken={filterFocusRequestToken}
      onRangeChange={applyRange}
      onPreviousRange={() => shiftRange(-1)}
      onNextRange={() => shiftRange(1)}
      onToday={() => {
        const nights = Math.max(1, rangeNights(range));
        applyRange({ arrivalDate: todayDate, departureDate: addLocalDateDays(todayDate, nights) });
      }}
      onFiltersChange={applyFilters}
      onClearFilters={clearFilters}
      onRefresh={() => setRefreshToken((value) => value + 1)}
    />
  ) : null;

  return (
    <div className="inventory-page room-status-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">Room status</p><h1>房态与可售</h1><p>房间、床位、订单、Stay 与 Operations 的统一运营视图</p></div>
        <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={queryBusy}>
          <RefreshCw className={queryBusy ? "spin" : ""} aria-hidden="true" size={17} />刷新
        </button>
      </header>

      {queryPhase !== "PERMISSION_DENIED" ? <InlineError error={recoveryError} title="恢复记录未收口" /> : null}
      {queryPhase !== "PERMISSION_DENIED" ? <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" /> : null}
      <InlineError error={restorationError} title="房态位置未保存" />
      <InlineError error={actionError} title="动作未开始" />
      <InlineError error={quoteRecoveryOutcome} title="报价恢复结果" />
      {queryPhase !== "PERMISSION_DENIED" && commandRecovery.pending ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="inventory-command-recovery" businessFacing={commandRecovery.pending.presentation === "MEMBER_STAY"} /> : null}
      {returnNotice ? <div className="room-status-return-notice" role="status">{returnNotice}</div> : null}
      {boardStale ? <div className="room-status-stale-notice" role="alert">当前房态已陈旧或刷新失败。页面保留最后一次来源事实，但所有依赖新鲜度的写动作已暂停。</div> : null}
      {queryError ? <InlineError error={queryError} title={board ? "房态刷新失败" : "无法查询房态"} /> : null}

      {!renderedBoard ? (
        queryPhase === "LOADING" || (board !== undefined && !boardMatchesCurrentProperty)
          ? <LoadingBlock label="正在查询房间、床位与来源事实" />
          : queryPhase === "PERMISSION_DENIED"
            ? <section className="room-status-query-failure" role="alert"><strong>无权查看当前物业房态</strong><p>当前主体没有这项读取权限，页面未保留旧房态，也不会开放任何写入动作。</p></section>
          : <section className="room-status-query-failure" role="status"><strong>状态未知，未显示为可售</strong><p>重新查询成功前，页面不会开放房态写入。</p><button type="button" className="button button-secondary" onClick={() => setRefreshToken((value) => value + 1)}>重试查询</button></section>
      ) : (
        <>
          {!isMobile ? roomStatusToolbar : null}

          {rangeLoading ? (
            <div className="room-status-range-loading" role="status" aria-live="polite" data-testid="room-status-range-loading">
              <strong>正在载入新的日期范围或房间分页</strong>
              <span>工具栏保留上次获权的数据时点；下方仍是 [{renderedBoard.range.arrivalDate}, {renderedBoard.range.departureDate}) 的旧事实，已暂停全部交互和写入。</span>
            </div>
          ) : null}

          <div
            className="room-status-workspace"
            aria-busy={rangeLoading}
            inert={rangeLoading && !filteredViewHasNoRooms}
          >
            <div className="room-status-board-column">
              <RoomStatusGrid
                board={renderedBoard}
                filters={viewState.filters}
                expandedRoomIds={viewState.expandedRoomIds}
                focusedCell={viewState.focusedCell}
                selection={viewState.selection}
                dateWindowStart={viewState.dateWindowStart}
                dateWindowSize={viewState.dateWindowSize}
                todayDate={todayDate}
                initialScrollAnchor={viewState.scrollAnchor}
                restoreFocus={Boolean(returnNotice)}
                focusRequestToken={focusRequestToken}
                onToggleRoom={(roomId) => dispatchView({ type: "TOGGLE_ROOM", roomId })}
                onFocusedCellChange={(focus) => dispatchView({ type: "SET_FOCUS", focus })}
                onSelectionChange={selectRange}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
                onDateWindowChange={(start) => changeDateWindow(start, renderedBoard.dates.length)}
                onInspectUnit={inspectUnit}
                onInspectDay={inspectDay}
                onInspectInterval={inspectInterval}
                onClearFilters={clearFilters}
                onScrollAnchorChange={(anchor) => dispatchView({ type: "SET_SCROLL_ANCHOR", anchor })}
              />
              <RoomStatusMobileTasks
                board={renderedBoard}
                groups={mobileGroups}
                activeTab={mobileTab}
                canCreate={!commandsBlocked && renderedBoard.accessLevel === "WRITE"}
                focusRequest={mobileFocusRequest}
                onTabChange={setMobileTab}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
                onCreate={() => setMobileCreateOpen(true)}
                onOpenReference={openReference}
                onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
                onAction={(action, task, unit) => {
                  if (action.code === "OPEN_ORDER") {
                    handleAction(action);
                    return;
                  }
                  pendingMobileTaskFocus.current = {
                    tab: mobileTab,
                    completedTaskId: task.id,
                    taskIndex: Math.max(0, activeMobileTasks.findIndex((candidate) => candidate.id === task.id)),
                    sourceRevision: renderedBoard.revision
                  };
                  handleAction(action, unit, {
                    unitId: unit?.id ?? task.actualInventoryUnitId,
                    anchorDate: task.sourceStartDate,
                    focusDate: addLocalDateDays(task.sourceEndDate, -1),
                    arrivalDate: task.sourceStartDate,
                    departureDate: task.sourceEndDate
                  }, task.actualInventoryUnitId);
                }}
              />
            </div>
            {!isMobile ? <div className="room-status-side-column"><RoomStatusContext
                board={renderedBoard}
                selectedUnit={selectedUnit}
                selectedDay={selectedDay}
                selectedInterval={selectedInterval}
                relatedIntervals={relatedIntervals}
                selection={viewState.selection}
                conflicts={contextConflicts}
                allowedActions={contextActions}
                onSelectedUnitChange={(unit) => {
                  inspectUnit(unit);
                }}
                onSelectionChange={selectRange}
                onOpenReference={openReference}
                onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
                onAction={handleAction}
              />
              {showQuoteWorkbench ? (
                <div className="room-status-quote-section" ref={quoteSectionRef}>
                  <QuoteWorkbench
                    unit={quoteActionUnit}
                    arrivalDate={quoteTarget?.arrivalDate ?? range.arrivalDate}
                    departureDate={quoteTarget?.departureDate ?? range.departureDate}
                    policies={policies}
                    {...(quoteTarget ? { initialStayType: quoteTarget.initialStayType } : {})}
                    commandsBlocked={commandsBlocked}
                    resetToken={quoteResetToken}
                    onClose={() => setQuoteTarget(undefined)}
                    onRecoveryOutcome={setQuoteRecoveryOutcome}
                    onCommand={startCommand}
                  />
                </div>
              ) : null}
            </div> : null}
          </div>

          {isMobile ? roomStatusToolbar : null}

          {isMobile && mobileCreateOpen ? (
            <Modal title="新建住宿或库存 Block" size="mobile-fullscreen" onClose={() => setMobileCreateOpen(false)} footer={null}>
              <RoomStatusContext
                board={renderedBoard}
                selectedUnit={selectedUnit}
                selectedDay={selectedDay}
                selectedInterval={selectedInterval}
                relatedIntervals={relatedIntervals}
                selection={viewState.selection}
                conflicts={contextConflicts}
                allowedActions={contextActions}
                onSelectedUnitChange={(unit) => {
                  inspectUnit(unit);
                }}
                onSelectionChange={selectRange}
                onOpenReference={openReference}
                onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
                onAction={(action) => {
                  if (handleAction(action)) setMobileCreateOpen(false);
                }}
              />
            </Modal>
          ) : null}

          {isMobile && showQuoteWorkbench ? (
            <div className="room-status-quote-section" ref={quoteSectionRef}>
              <QuoteWorkbench
                unit={quoteActionUnit}
                arrivalDate={quoteTarget?.arrivalDate ?? range.arrivalDate}
                departureDate={quoteTarget?.departureDate ?? range.departureDate}
                policies={policies}
                {...(quoteTarget ? { initialStayType: quoteTarget.initialStayType } : {})}
                commandsBlocked={commandsBlocked}
                resetToken={quoteResetToken}
                onClose={() => setQuoteTarget(undefined)}
                onRecoveryOutcome={setQuoteRecoveryOutcome}
                onCommand={startCommand}
              />
            </div>
          ) : null}
        </>
      )}

      {maintenanceTarget && viewState.selection ? <MaintenanceDialog unit={maintenanceTarget} arrivalDate={viewState.selection.arrivalDate} departureDate={viewState.selection.departureDate} writeBlocked={commandsBlocked} onClose={() => setMaintenanceTarget(undefined)} onSubmit={(request) => { const started = startCommand(request); if (started) setMaintenanceTarget(undefined); return started; }} /> : null}
      {internalUseTarget && viewState.selection ? <InternalUseDialog unit={internalUseTarget} arrivalDate={viewState.selection.arrivalDate} departureDate={viewState.selection.departureDate} writeBlocked={commandsBlocked} onClose={() => setInternalUseTarget(undefined)} onSubmit={(request) => { const started = startCommand(request); if (started) setInternalUseTarget(undefined); return started; }} /> : null}
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}-${commandAttemptId}` : `new-room-status-command-${commandAttemptId}`}
        request={command}
        onClose={closeCommandDialog}
        writeBlocked={!recoveryDialogOpen && (commandsBlocked || commandContextInvalidated)}
        writeBlockedReason="房态权限、查询范围、数据新鲜度或操作恢复状态已经变化。请关闭后刷新，再重新核对本次操作。"
        onCommitted={refreshCommittedRoomStatus}
        {...(recoveryDialogOpen && commandRecovery.pending ? {
          initialConfirmationKey: commandRecovery.pending.confirmationKey,
          ...(commandRecovery.pending.receipt ? { initialReceipt: commandRecovery.pending.receipt } : {})
        } : {})}
        onProgress={(progress) => trackCommandProgress(command, progress, commandAttemptId)}
      /> : null}
    </div>
  );
}
