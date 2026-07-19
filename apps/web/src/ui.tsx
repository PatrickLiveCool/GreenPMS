import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, Clock3, Copy, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { commandTypes, type CommandType, type MoneyDto } from "@qintopia/contracts";
import { api, ApiError } from "./api";
import type { ClientCommandMetadata, CommandRequest, PreviewDto, ReceiptDto } from "./types";

export function formatMoney(value: MoneyDto | undefined): string {
  if (!value) return "-";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value.minorUnits / 100);
  } catch {
    return `${value.currency} ${value.minorUnits}`;
  }
}

export function formatMinor(minorUnits: number, currency: string): string {
  return formatMoney({ minorUnits, currency });
}

export function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function guestName(snapshot: Record<string, unknown>): string {
  const value = snapshot.fullName;
  return typeof value === "string" && value ? value : "未命名住客";
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "请求失败，请稍后重试";
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return <span className={`status-badge status-${normalized}`}>{value.replaceAll("_", " ")}</span>;
}

export function InlineError({ error, title = "操作未完成" }: { error: unknown; title?: string }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : undefined;
  return (
    <div className="inline-error" role="alert" tabIndex={-1}>
      <AlertCircle aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        <p>{errorMessage(error)}</p>
        {apiError?.correlationId ? <small>Correlation ID: {apiError.correlationId}</small> : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function LoadingBlock({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <LoaderCircle className="spin" aria-hidden="true" size={20} />
      <span>{label}</span>
    </div>
  );
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "default" | "wide";
  closeDisabled?: boolean;
}

export function Modal({ title, onClose, children, footer, size = "default", closeDisabled = false }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => previousFocus?.focus();
  }, []);

  return (
    <dialog
      className={`modal modal-${size}`}
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(event) => {
        if (!closeDisabled && event.target === dialogRef.current) onClose();
      }}
    >
      <div className="modal-shell">
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} disabled={closeDisabled} aria-label="关闭" title="关闭">
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function moneyFrom(value: unknown): MoneyDto | undefined {
  if (!isRecord(value) || typeof value.currency !== "string" || typeof value.minorUnits !== "number") return undefined;
  return { currency: value.currency, minorUnits: value.minorUnits };
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const bookingChannelLabels: Record<string, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
};

function pricingFromEffect(effect: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(effect.pricing)) return effect.pricing;
  if (isRecord(effect.after) && isRecord(effect.after.pricing)) return effect.after.pricing;
  return undefined;
}

export function receiptTransactionReferenceLabel(result: Record<string, unknown>): string {
  if (result.factType === "REVERSAL") return "不适用";
  return typeof result.transactionReference === "string" ? result.transactionReference : "历史未记录";
}

function EffectSummary({ preview }: { preview: PreviewDto }) {
  const effect = preview.effect;
  const before = isRecord(effect.before) ? effect.before : undefined;
  const after = isRecord(effect.after) ? effect.after : undefined;
  const pricing = pricingFromEffect(effect);
  const inventoryUnit = isRecord(effect.inventoryUnit) ? effect.inventoryUnit : undefined;
  const fromUnit = isRecord(effect.fromInventoryUnit) ? effect.fromInventoryUnit : undefined;
  const toUnit = isRecord(effect.toInventoryUnit) ? effect.toInventoryUnit : undefined;
  const guest = isRecord(effect.primaryGuest) ? effect.primaryGuest : undefined;
  const member = isRecord(effect.member) ? effect.member : undefined;
  const submittedProfile = isRecord(effect.submittedProfile) ? effect.submittedProfile : undefined;
  const memberContract = isRecord(effect.contract) ? effect.contract : undefined;
  const externalReference = isRecord(effect.externalReference) ? effect.externalReference : undefined;
  const entitlementTransition = isRecord(effect.entitlementTransition) ? effect.entitlementTransition : undefined;
  const policyBaseAmount = moneyFrom(effect.policyBaseAmount);
  const targetCurrentContractAmount = moneyFrom(effect.targetCurrentContractAmount);
  const manualAdjustmentMinor = typeof effect.manualAdjustmentMinor === "number" ? effect.manualAdjustmentMinor : undefined;
  const coverage = pricing && Array.isArray(pricing.coverageSet) ? pricing.coverageSet : [];
  const cashLines = pricing && Array.isArray(pricing.cashLines) ? pricing.cashLines : [];
  const hasBookingChannel = Object.hasOwn(effect, "bookingChannelCode");
  const bookingChannelCode = typeof effect.bookingChannelCode === "string" ? effect.bookingChannelCode : null;
  const channelOrderReference = typeof effect.channelOrderReference === "string" ? effect.channelOrderReference : null;
  const hasTransactionReference = Object.hasOwn(effect, "transactionReference");

  return (
    <div className="effect-summary" data-testid="command-effect">
      <div className="preview-meta">
        <span><Clock3 aria-hidden="true" size={15} />有效至 {formatDateTime(preview.expiresAt)}</span>
        <code title={preview.effectHash}>{preview.effectHash.slice(0, 12)}...</code>
      </div>

      <section className="effect-section" aria-labelledby="effect-difference-heading">
        <h3 id="effect-difference-heading">服务端变更差异</h3>
        <dl className="difference-grid">
          {guest ? <><dt>主要居住人</dt><dd>{scalar(guest.fullName)}</dd></> : null}
          {member ? <><dt>会员档案动作</dt><dd>{scalar(effect.operation)}</dd><dt>会员姓名 / 身份证</dt><dd>{scalar(member.fullName)} · <code>{scalar(member.identityCardNumber)}</code></dd><dt>手机号 / 微信号</dt><dd>{scalar(member.phone)} · {scalar(member.wechat)}</dd></> : null}
          {submittedProfile && effect.profileMatch === false ? <><dt>申请资料差异</dt><dd>申请资料与现有档案不一致；本命令保留现有档案，仅关联申请记录。</dd></> : null}
          {memberContract ? <><dt>会员合同动作</dt><dd>{scalar(memberContract.operation)}</dd><dt>合同周期</dt><dd>{scalar(memberContract.validFrom)} 至 {scalar(memberContract.validUntil)}</dd></> : null}
          {externalReference ? <><dt>外部申请关联</dt><dd>{scalar(externalReference.operation)} · {scalar(externalReference.provider)} · <code>{scalar(externalReference.externalRecordId)}</code></dd></> : null}
          {hasBookingChannel ? <><dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "历史未记录"}</dd></> : null}
          {hasBookingChannel ? <><dt>渠道订单号</dt><dd>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? (bookingChannelCode ? "未填写" : "历史未记录")}</dd></> : null}
          {inventoryUnit ? <><dt>库存单元</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          {fromUnit && toUnit ? <><dt>换房</dt><dd>{scalar(fromUnit.code)} <ChevronRight aria-label="变更为" size={15} /> {scalar(toUnit.code)}</dd></> : null}
          {before ? Object.entries(before).map(([key, value]) => (
            <div className="difference-row" key={`before-${key}`}>
              <dt>{key}</dt><dd><span className="before-value">{moneyFrom(value) ? formatMoney(moneyFrom(value)) : scalar(value)}</span></dd>
            </div>
          )) : null}
          {after ? Object.entries(after).filter(([key]) => key !== "pricing").map(([key, value]) => (
            <div className="difference-row" key={`after-${key}`}>
              <dt>{key}（变更后）</dt><dd><span className="after-value">{moneyFrom(value) ? formatMoney(moneyFrom(value)) : scalar(value)}</span></dd>
            </div>
          )) : null}
          {typeof effect.amountMinor === "number" && typeof effect.currency === "string" ? <><dt>事实金额</dt><dd>{formatMoney({ currency: effect.currency, minorUnits: effect.amountMinor })}</dd></> : null}
          {hasTransactionReference ? <><dt>外部交易单号</dt><dd>{typeof effect.transactionReference === "string" ? effect.transactionReference : "历史未记录"}</dd></> : null}
          {typeof effect.fromStatus === "string" && typeof effect.toStatus === "string" ? <><dt>状态</dt><dd>{effect.fromStatus} <ChevronRight aria-label="变更为" size={15} /> {effect.toStatus}</dd></> : null}
          {entitlementTransition ? <><dt>权益状态变化</dt><dd>{scalar(entitlementTransition.from)} <ChevronRight aria-label="变更为" size={15} /> {scalar(entitlementTransition.to)} · {scalar(entitlementTransition.coverageCount)} 晚</dd></> : null}
          {policyBaseAmount ? <><dt>政策基础报价</dt><dd data-testid="preview-policy-base-amount">{formatMoney(policyBaseAmount)}</dd></> : null}
          {targetCurrentContractAmount ? <><dt>指定最终总价</dt><dd data-testid="preview-target-contract-amount">{formatMoney(targetCurrentContractAmount)}</dd></> : null}
          {manualAdjustmentMinor !== undefined && (policyBaseAmount || targetCurrentContractAmount) ? <><dt>人工调价差额</dt><dd data-testid="preview-manual-adjustment">{formatMinor(manualAdjustmentMinor, policyBaseAmount?.currency ?? targetCurrentContractAmount!.currency)}</dd></> : null}
          {!before && !after && !guest && !inventoryUnit && !fromUnit && typeof effect.amountMinor !== "number" && typeof effect.fromStatus !== "string"
            ? <><dt>命令</dt><dd>{preview.commandType}</dd></> : null}
        </dl>
      </section>

      {pricing ? (
        <section className="effect-section" aria-labelledby="effect-pricing-heading">
          <h3 id="effect-pricing-heading">计价结果</h3>
          <div className="preview-amounts">
            <div><span>coverageSet</span><strong>{coverage.length} 晚</strong></div>
            <div><span>cashRemainder</span><strong>{formatMoney(moneyFrom(pricing.cashRemainder))}</strong></div>
            <div><span>currentContractAmount</span><strong>{formatMoney(moneyFrom(pricing.currentContractAmount))}</strong></div>
          </div>
          {cashLines.length ? <p className="muted compact">现金计价行：{cashLines.length}</p> : null}
        </section>
      ) : null}

      <details className="raw-details">
        <summary>完整 effect</summary>
        <pre>{JSON.stringify(effect, null, 2)}</pre>
      </details>
    </div>
  );
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

function ReceiptPanel({ receipt, onNavigateToResource }: { receipt: ReceiptDto; onNavigateToResource?: () => void }) {
  const result = isRecord(receipt.result) ? receipt.result : undefined;
  const orderId = result && typeof result.orderId === "string" ? result.orderId : undefined;
  const hasBookingChannel = Boolean(result && Object.hasOwn(result, "bookingChannelCode"));
  const bookingChannelCode = result && typeof result.bookingChannelCode === "string" ? result.bookingChannelCode : null;
  const channelOrderReference = result && typeof result.channelOrderReference === "string" ? result.channelOrderReference : null;
  const hasTransactionReference = Boolean(result && Object.hasOwn(result, "transactionReference"));
  const memberId = result && typeof result.memberId === "string" ? result.memberId : undefined;
  const memberContractId = result && typeof result.memberContractId === "string" ? result.memberContractId : undefined;
  const memberExternalReferenceId = result && typeof result.memberExternalReferenceId === "string" ? result.memberExternalReferenceId : undefined;
  const policyBaseAmount = result ? moneyFrom(result.policyBaseAmount) : undefined;
  const targetCurrentContractAmount = result ? moneyFrom(result.targetCurrentContractAmount) : undefined;
  const manualAdjustmentMinor = result && typeof result.manualAdjustmentMinor === "number" ? result.manualAdjustmentMinor : undefined;
  const committed = receipt.businessCommitted;
  return (
    <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? "业务写入已提交" : "业务写入未提交"}</h3>
          <p>{receipt.executionStatus}</p>
        </div>
      </div>
      {receipt.error ? <div className="receipt-error"><strong>{receipt.error.code}</strong><p>{receipt.error.message}</p></div> : null}
      <dl className="receipt-grid">
        <dt>Receipt ID</dt><dd><code>{receipt.receiptId || "-"}</code>{receipt.receiptId ? <button type="button" className="copy-button" onClick={() => copyText(receipt.receiptId)} aria-label="复制 Receipt ID" title="复制"><Copy size={14} /></button> : null}</dd>
        <dt>Command ID</dt><dd><code>{receipt.commandId || "-"}</code></dd>
        <dt>Correlation ID</dt><dd><code>{receipt.correlationId || "-"}</code></dd>
        <dt>资源引用</dt><dd className="code-list">{receipt.resourceRefs.length ? receipt.resourceRefs.map((ref) => <code key={ref}>{ref}</code>) : "-"}</dd>
        <dt>事实引用</dt><dd className="code-list">{receipt.factRefs.length ? receipt.factRefs.map((ref) => <code key={ref}>{ref}</code>) : "-"}</dd>
        {hasBookingChannel ? <><dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "历史未记录"}</dd><dt>渠道订单号</dt><dd><code>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? (bookingChannelCode ? "未填写" : "历史未记录")}</code></dd></> : null}
        {hasTransactionReference && result ? <><dt>外部交易单号</dt><dd><code>{receiptTransactionReferenceLabel(result)}</code></dd></> : null}
        {memberId ? <><dt>Member ID</dt><dd><code>{memberId}</code></dd><dt>Member Contract ID</dt><dd><code>{memberContractId ?? "未选择"}</code></dd><dt>外部申请引用</dt><dd><code>{memberExternalReferenceId ?? "未关联"}</code></dd></> : null}
        {policyBaseAmount ? <><dt>政策基础报价</dt><dd data-testid="receipt-policy-base-amount">{formatMoney(policyBaseAmount)}</dd></> : null}
        {targetCurrentContractAmount ? <><dt>指定最终总价</dt><dd data-testid="receipt-target-contract-amount">{formatMoney(targetCurrentContractAmount)}</dd></> : null}
        {manualAdjustmentMinor !== undefined && (policyBaseAmount || targetCurrentContractAmount) ? <><dt>人工调价差额</dt><dd data-testid="receipt-manual-adjustment">{formatMinor(manualAdjustmentMinor, policyBaseAmount?.currency ?? targetCurrentContractAmount!.currency)}</dd></> : null}
      </dl>
      {orderId ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`} onClick={onNavigateToResource}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>
  );
}

interface CommandDialogProps {
  request: CommandRequest;
  onClose: () => void;
  onCommitted?: (receipt: ReceiptDto) => void;
  initialPreviewMetadata?: ClientCommandMetadata;
  initialConfirmationKey?: string;
  initialReceipt?: ReceiptDto;
  onProgress?: (progress: CommandDialogProgress) => boolean | void;
}

export type CommandDialogProgress =
  | { state: "PREVIEWING"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEW_UNKNOWN"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEW_FAILED"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEWED"; previewId: string; previewMetadata: ClientCommandMetadata }
  | { state: "CONFIRMING"; previewId: string; confirmationKey: string }
  | { state: "UNKNOWN"; confirmationKey: string }
  | { state: "RESOLVED"; confirmationKey: string; receipt: ReceiptDto };

export type PersistedCommandRecoveryState = "CONFIRMING" | "UNKNOWN" | "EXECUTED" | "NOT_EXECUTED";

export interface PersistedCommandRecovery {
  version: 1;
  subjectId: string;
  scopeId: string;
  propertyId: string;
  commandType: CommandType;
  confirmationKey: string;
  targetRefs: string[];
  state: PersistedCommandRecoveryState;
  receipt?: ReceiptDto;
  updatedAt: string;
}

export interface CommandRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CommandRecoveryReadResult =
  | { kind: "ABSENT" }
  | { kind: "VALID"; recovery: PersistedCommandRecovery }
  | { kind: "CORRUPT"; error: Error }
  | { kind: "READ_ERROR"; error: Error };

export interface CommandRecoveryContext {
  subjectId: string;
  scopeId: string;
  request: CommandRequest;
}

const COMMAND_RECOVERY_STORAGE_PREFIX = "qintopia.command-recovery.v1";
const persistableCommandTypes = new Set<CommandType>(commandTypes.filter((commandType) => (
  commandType !== "ISSUE_TOKEN" && commandType !== "ROTATE_TOKEN" && commandType !== "REVOKE_TOKEN"
)));
const recoveryReferenceKeys = [
  "orderId",
  "memberId",
  "memberContractId",
  "inventoryUnitId",
  "maintenanceLockId",
  "entitlementLotId",
  "quoteId"
] as const;

function recoveryTargetRefs(input: Record<string, unknown>): string[] {
  return recoveryReferenceKeys.flatMap((key) => {
    const value = input[key];
    return typeof value === "string" && value ? [`${key}=${value}`] : [];
  });
}

function isPersistableCommandType(value: unknown): value is CommandType {
  return typeof value === "string" && persistableCommandTypes.has(value as CommandType);
}

export function isTerminalCommandRecovery(value: PersistedCommandRecoveryState): value is "EXECUTED" | "NOT_EXECUTED" {
  return value === "EXECUTED" || value === "NOT_EXECUTED";
}

function isTerminalReceipt(value: unknown): value is ReceiptDto {
  if (!isRecord(value)) return false;
  return (value.executionStatus === "EXECUTED" || value.executionStatus === "NOT_EXECUTED")
    && typeof value.businessCommitted === "boolean"
    && typeof value.receiptId === "string"
    && typeof value.commandId === "string"
    && typeof value.correlationId === "string"
    && Array.isArray(value.resourceRefs)
    && value.resourceRefs.every((item) => typeof item === "string")
    && Array.isArray(value.factRefs)
    && value.factRefs.every((item) => typeof item === "string");
}

function browserSessionStorage(): { kind: "AVAILABLE"; storage: CommandRecoveryStorage } | { kind: "READ_ERROR"; error: Error } {
  if (typeof window === "undefined") return { kind: "READ_ERROR", error: new Error("浏览器 sessionStorage 不可用") };
  try {
    return { kind: "AVAILABLE", storage: window.sessionStorage };
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法访问本地命令恢复记录；为避免重复写入，已暂停本物业写命令") };
  }
}

export function commandRecoveryStorageKey(subjectId: string, scopeId: string): string {
  return `${COMMAND_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(scopeId)}`;
}

export function readPersistedCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, scopeId: string): CommandRecoveryReadResult {
  let serialized: string | null;
  try {
    serialized = storage.getItem(commandRecoveryStorageKey(subjectId, scopeId));
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法读取本地命令恢复记录；为避免重复写入，已暂停本物业写命令") };
  }
  if (serialized === null) return { kind: "ABSENT" };

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录已损坏；无法确认原命令是否执行，已暂停本物业写命令") };
  }
  if (!isRecord(value)
    || value.version !== 1
    || value.subjectId !== subjectId
    || value.scopeId !== scopeId
    || typeof value.propertyId !== "string"
    || !value.propertyId
    || !isPersistableCommandType(value.commandType)
    || typeof value.confirmationKey !== "string"
    || !value.confirmationKey
    || !Array.isArray(value.targetRefs)
    || !value.targetRefs.every((item) => typeof item === "string")
    || (value.state !== "CONFIRMING" && value.state !== "UNKNOWN" && value.state !== "EXECUTED" && value.state !== "NOT_EXECUTED")
    || typeof value.updatedAt !== "string") {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录版本或结构无效；无法确认原命令是否执行，已暂停本物业写命令") };
  }
  const state = value.state;
  if ((isTerminalCommandRecovery(state) && !isTerminalReceipt(value.receipt))
    || (!isTerminalCommandRecovery(state) && value.receipt !== undefined)) {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录的执行状态与 Receipt 不一致；已暂停本物业写命令") };
  }
  return { kind: "VALID", recovery: value as unknown as PersistedCommandRecovery };
}

export function savePersistedCommandRecovery(storage: CommandRecoveryStorage, recovery: PersistedCommandRecovery): boolean {
  try {
    storage.setItem(commandRecoveryStorageKey(recovery.subjectId, recovery.scopeId), JSON.stringify(recovery));
    return true;
  } catch {
    return false;
  }
}

export function clearPersistedCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, scopeId: string): boolean {
  try {
    storage.removeItem(commandRecoveryStorageKey(subjectId, scopeId));
    return true;
  } catch {
    return false;
  }
}

export function transitionPersistedCommandRecovery(
  current: PersistedCommandRecovery | undefined,
  context: CommandRecoveryContext,
  progress: CommandDialogProgress,
  updatedAt = new Date().toISOString()
): { accepted: boolean; recovery: PersistedCommandRecovery | undefined } {
  if (progress.state !== "CONFIRMING" && progress.state !== "UNKNOWN" && progress.state !== "RESOLVED") {
    return { accepted: true, recovery: current };
  }
  if (progress.state === "CONFIRMING") {
    const propertyId = context.request.input.propertyId;
    if (!isPersistableCommandType(context.request.commandType) || typeof propertyId !== "string" || !propertyId) {
      return { accepted: false, recovery: current };
    }
    if (current && current.confirmationKey !== progress.confirmationKey) return { accepted: false, recovery: current };
    if (current && isTerminalCommandRecovery(current.state)) return { accepted: false, recovery: current };
    return {
      accepted: true,
      recovery: current ?? {
        version: 1,
        subjectId: context.subjectId,
        scopeId: context.scopeId,
        propertyId,
        commandType: context.request.commandType,
        confirmationKey: progress.confirmationKey,
        targetRefs: recoveryTargetRefs(context.request.input),
        state: "CONFIRMING",
        updatedAt
      }
    };
  }
  if (!current || current.confirmationKey !== progress.confirmationKey || isTerminalCommandRecovery(current.state)) {
    return { accepted: true, recovery: current };
  }
  if (progress.state === "UNKNOWN" || progress.receipt.executionStatus === "UNKNOWN") {
    return { accepted: true, recovery: { ...current, state: "UNKNOWN", updatedAt } };
  }
  return {
    accepted: true,
    recovery: { ...current, state: progress.receipt.executionStatus, receipt: progress.receipt, updatedAt }
  };
}

export function recoveryCommandRequest(recovery: PersistedCommandRecovery): CommandRequest {
  return {
    commandType: recovery.commandType,
    title: `${recovery.commandType} · 原命令恢复`,
    description: "仅使用已保存的原幂等键查询服务端命令结果，不会发起新的业务写入。",
    input: { propertyId: recovery.propertyId }
  };
}

export function usePersistentCommandRecovery({ subjectId, scopeId }: { subjectId: string; scopeId: string }) {
  const storageScope = commandRecoveryStorageKey(subjectId, scopeId);
  const [snapshot, setSnapshot] = useState<{ storageScope: string; read: CommandRecoveryReadResult }>(() => {
    const access = browserSessionStorage();
    const read = !scopeId
      ? { kind: "ABSENT" } as const
      : access.kind === "AVAILABLE"
        ? readPersistedCommandRecovery(access.storage, subjectId, scopeId)
        : access;
    return { storageScope, read };
  });

  useEffect(() => {
    const access = browserSessionStorage();
    const read = !scopeId
      ? { kind: "ABSENT" } as const
      : access.kind === "AVAILABLE"
        ? readPersistedCommandRecovery(access.storage, subjectId, scopeId)
        : access;
    setSnapshot({ storageScope, read });
  }, [scopeId, storageScope, subjectId]);

  const ready = snapshot.storageScope === storageScope;
  const read = ready ? snapshot.read : { kind: "READ_ERROR", error: new Error("正在核对本地命令恢复记录") } as const;
  const pending = read.kind === "VALID" ? read.recovery : undefined;
  const error = read.kind === "CORRUPT" || read.kind === "READ_ERROR" ? read.error : undefined;
  const blocked = !ready || read.kind !== "ABSENT";

  function track(request: CommandRequest, progress: CommandDialogProgress): boolean {
    if (progress.state !== "CONFIRMING" && progress.state !== "UNKNOWN" && progress.state !== "RESOLVED") return true;
    const access = browserSessionStorage();
    if (access.kind === "READ_ERROR" || !scopeId) {
      setSnapshot({ storageScope, read: access.kind === "READ_ERROR" ? access : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") } });
      return false;
    }
    const currentRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
    if (currentRead.kind === "CORRUPT" || currentRead.kind === "READ_ERROR") {
      setSnapshot({ storageScope, read: currentRead });
      return false;
    }
    const current = currentRead.kind === "VALID" ? currentRead.recovery : undefined;
    const transition = transitionPersistedCommandRecovery(current, { subjectId, scopeId, request }, progress);
    if (!transition.accepted) return false;
    if (transition.recovery && transition.recovery !== current) {
      if (!savePersistedCommandRecovery(access.storage, transition.recovery)) {
        setSnapshot({ storageScope, read: { kind: "READ_ERROR", error: new Error("无法保存本地命令恢复记录；命令尚未发送，写入口已暂停") } });
        return false;
      }
      setSnapshot({ storageScope, read: { kind: "VALID", recovery: transition.recovery } });
    } else if (transition.recovery) {
      setSnapshot({ storageScope, read: { kind: "VALID", recovery: transition.recovery } });
    } else {
      setSnapshot({ storageScope, read: currentRead });
    }
    return true;
  }

  function clearResolved(): boolean {
    const access = browserSessionStorage();
    if (access.kind === "READ_ERROR" || !scopeId) {
      setSnapshot({ storageScope, read: access.kind === "READ_ERROR" ? access : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") } });
      return false;
    }
    const currentRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
    if (currentRead.kind !== "VALID" || !isTerminalCommandRecovery(currentRead.recovery.state)) {
      if (currentRead.kind === "CORRUPT" || currentRead.kind === "READ_ERROR") setSnapshot({ storageScope, read: currentRead });
      return false;
    }
    if (!clearPersistedCommandRecovery(access.storage, subjectId, scopeId)) {
      setSnapshot({ storageScope, read: { kind: "READ_ERROR", error: new Error("无法清除已收口的本地命令恢复记录；写入口继续暂停") } });
      return false;
    }
    setSnapshot({ storageScope, read: { kind: "ABSENT" } });
    return true;
  }

  return { ready, pending, error, blocked, track, clearResolved };
}

export function CommandRecoveryBar({ recovery, onOpen, testId = "command-recovery" }: {
  recovery: PersistedCommandRecovery;
  onOpen: () => void;
  testId?: string;
}) {
  const resolved = isTerminalCommandRecovery(recovery.state);
  return (
    <section className="recovery-bar" role="status" aria-live="polite" aria-label="待恢复命令" data-testid={testId}>
      <div>
        <strong>{resolved ? "原命令结果已确认" : "原命令执行状态需要恢复查询"}</strong>
        <p><code>{recovery.commandType}</code> · {recovery.state} · Property <code>{recovery.propertyId}</code></p>
        {recovery.targetRefs.length ? <p>业务目标 {recovery.targetRefs.map((reference) => <code key={reference}>{reference}</code>)}</p> : null}
        <p>原幂等键 <code>{recovery.confirmationKey}</code></p>
        {recovery.receipt ? <p>Command <code>{recovery.receipt.commandId || "-"}</code> · Receipt <code>{recovery.receipt.receiptId || "-"}</code></p> : null}
        <p>{resolved ? "查看并关闭 Receipt 后恢复新的业务写入。" : "新的业务写入已暂停，必须继续查询原命令。"}</p>
      </div>
      <button className="button button-secondary" type="button" onClick={onOpen} data-testid={`${testId}-open`}>
        <RefreshCw aria-hidden="true" size={17} />{resolved ? "查看已确认结果" : "恢复原命令"}
      </button>
    </section>
  );
}

function displayCommandInput(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.tokenSecret !== "string") return input;
  return { ...input, tokenSecret: "[client-held secret]" };
}

export function CommandDialog({ request, onClose, onCommitted, initialPreviewMetadata, initialConfirmationKey, initialReceipt, onProgress }: CommandDialogProps) {
  const [preview, setPreview] = useState<PreviewDto>();
  const [receipt, setReceipt] = useState<ReceiptDto | undefined>(initialReceipt);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [reasonCode, setReasonCode] = useState("OPERATOR_CONFIRMED");
  const [reasonNote, setReasonNote] = useState("");
  const [confirmationKey, setConfirmationKey] = useState(initialConfirmationKey);
  const [networkUncertain, setNetworkUncertain] = useState(Boolean(initialConfirmationKey && !initialReceipt));
  const [previewMetadata] = useState<ClientCommandMetadata>(() => initialPreviewMetadata ?? api.commandMetadata(`preview-${request.commandType.toLowerCase()}`));

  const canConfirm = Boolean(preview && reasonCode.trim() && reasonNote.trim() && !busy);
  const currentKey = useMemo(() => confirmationKey ?? api.recoveryKey(request.commandType), [confirmationKey, request.commandType]);

  async function loadPreview() {
    setBusy(true);
    setError(undefined);
    onProgress?.({ state: "PREVIEWING", previewMetadata });
    try {
      const response = await api.preview({ commandType: request.commandType, input: request.input }, previewMetadata);
      setPreview(response.preview);
      setReceipt(undefined);
      onProgress?.({ state: "PREVIEWED", previewId: response.preview.previewId, previewMetadata });
    } catch (nextError) {
      setError(nextError);
      const uncertain = !(nextError instanceof ApiError)
        || nextError.status >= 500
        || nextError.code === "COMMAND_STATUS_UNKNOWN";
      onProgress?.({ state: uncertain ? "PREVIEW_UNKNOWN" : "PREVIEW_FAILED", previewMetadata });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview || !reasonCode.trim() || !reasonNote.trim()) return;
    const propertyId = request.input.propertyId;
    if (typeof propertyId !== "string" || !propertyId) {
      setError(new Error("Command property scope is missing"));
      return;
    }
    const key = currentKey;
    setConfirmationKey(key);
    setBusy(true);
    setError(undefined);
    setNetworkUncertain(false);
    try {
      const accepted = onProgress?.({ state: "CONFIRMING", previewId: preview.previewId, confirmationKey: key });
      if (accepted === false) {
        setError(new Error("无法安全保存本次确认的恢复信息，命令尚未发送"));
        setBusy(false);
        return;
      }
    } catch (progressError) {
      setError(progressError);
      setBusy(false);
      return;
    }
    try {
      const result = await api.confirm(preview.previewId, propertyId, request.commandType, preview.effectHash, {
        code: reasonCode.trim(),
        note: reasonNote.trim()
      }, key);
      setReceipt(result);
      onProgress?.({ state: "RESOLVED", confirmationKey: key, receipt: result });
      if (result.businessCommitted) onCommitted?.(result);
    } catch (nextError) {
      setError(nextError);
      setNetworkUncertain(true);
      onProgress?.({ state: "UNKNOWN", confirmationKey: key });
    } finally {
      setBusy(false);
    }
  }

  async function recover() {
    if (!confirmationKey) return;
    const propertyId = request.input.propertyId;
    if (typeof propertyId !== "string" || !propertyId) {
      setError(new Error("Command property scope is missing"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.commandResult(propertyId, request.commandType, confirmationKey);
      setNetworkUncertain(result.executionStatus === "UNKNOWN");
      if (result.executionStatus === "UNKNOWN") {
        setReceipt(undefined);
        onProgress?.({ state: "UNKNOWN", confirmationKey });
      } else {
        setReceipt(result);
        onProgress?.({ state: "RESOLVED", confirmationKey, receipt: result });
      }
      if (result.businessCommitted) onCommitted?.(result);
    } catch (nextError) {
      setError(nextError);
      setNetworkUncertain(true);
      onProgress?.({ state: "UNKNOWN", confirmationKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={request.title}
      onClose={onClose}
      size="wide"
      closeDisabled={busy}
      footer={
        <>
          <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>{receipt ? "完成" : "取消"}</button>
          {!preview && !receipt && !networkUncertain ? <button className="button button-primary" type="button" onClick={() => void loadPreview()} disabled={busy} data-testid="create-command-preview">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : null}生成服务端预览
          </button> : null}
          {preview && !receipt ? <button className="button button-danger" type="button" onClick={() => void confirm()} disabled={!canConfirm} data-testid="confirm-command">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <Check aria-hidden="true" size={17} />}显式确认并提交
          </button> : null}
        </>
      }
    >
      <p className="command-description">{request.description}</p>
      <div aria-live="polite" className="sr-status">{busy ? "正在处理命令" : receipt ? `命令状态 ${receipt.executionStatus}` : ""}</div>
      <InlineError error={error} />
      {!preview && !receipt ? (
        <div className="command-pending">
          <p>命令类型</p>
          <code>{request.commandType}</code>
          <details className="raw-details">
            <summary>请求输入</summary>
            <pre>{JSON.stringify(displayCommandInput(request.input), null, 2)}</pre>
          </details>
        </div>
      ) : null}
      {preview && !receipt ? (
        <>
          <EffectSummary preview={preview} />
          <section className="reason-section" aria-labelledby="reason-heading">
            <h3 id="reason-heading">确认原因</h3>
            <div className="form-grid form-grid-two">
              <label>原因代码<input value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required maxLength={80} data-testid="reason-code" /></label>
              <label className="span-two">原因说明<textarea value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} required maxLength={1000} rows={3} placeholder="记录本次人工确认依据" data-testid="reason-note" /></label>
            </div>
          </section>
        </>
      ) : null}
      {receipt ? <ReceiptPanel receipt={receipt} onNavigateToResource={onClose} /> : null}
      {networkUncertain && confirmationKey ? (
        <div className="recovery-bar">
          <div><strong>执行状态需要恢复查询</strong><p>使用原幂等键查询，不会发起新的业务命令。</p></div>
          <button className="button button-secondary" type="button" onClick={() => void recover()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />查询命令结果
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
