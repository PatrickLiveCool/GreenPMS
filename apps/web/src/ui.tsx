import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, Clock3, Copy, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { MoneyDto } from "@qintopia/contracts";
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

function pricingFromEffect(effect: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(effect.pricing)) return effect.pricing;
  if (isRecord(effect.after) && isRecord(effect.after.pricing)) return effect.after.pricing;
  return undefined;
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
  const coverage = pricing && Array.isArray(pricing.coverageSet) ? pricing.coverageSet : [];
  const cashLines = pricing && Array.isArray(pricing.cashLines) ? pricing.cashLines : [];

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
          {typeof effect.fromStatus === "string" && typeof effect.toStatus === "string" ? <><dt>状态</dt><dd>{effect.fromStatus} <ChevronRight aria-label="变更为" size={15} /> {effect.toStatus}</dd></> : null}
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

function ReceiptPanel({ receipt }: { receipt: ReceiptDto }) {
  const orderId = isRecord(receipt.result) && typeof receipt.result.orderId === "string" ? receipt.result.orderId : undefined;
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
      </dl>
      {orderId ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>
  );
}

interface CommandDialogProps {
  request: CommandRequest;
  onClose: () => void;
  onCommitted?: (receipt: ReceiptDto) => void;
  initialPreviewMetadata?: ClientCommandMetadata;
  initialConfirmationKey?: string;
  onProgress?: (progress: CommandDialogProgress) => void;
}

export type CommandDialogProgress =
  | { state: "PREVIEWING"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEW_UNKNOWN"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEW_FAILED"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEWED"; previewId: string; previewMetadata: ClientCommandMetadata }
  | { state: "CONFIRMING"; previewId: string; confirmationKey: string }
  | { state: "UNKNOWN"; confirmationKey: string }
  | { state: "RESOLVED"; confirmationKey: string; receipt: ReceiptDto };

function displayCommandInput(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.tokenSecret !== "string") return input;
  return { ...input, tokenSecret: "[client-held secret]" };
}

export function CommandDialog({ request, onClose, onCommitted, initialPreviewMetadata, initialConfirmationKey, onProgress }: CommandDialogProps) {
  const [preview, setPreview] = useState<PreviewDto>();
  const [receipt, setReceipt] = useState<ReceiptDto>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [reasonCode, setReasonCode] = useState("OPERATOR_CONFIRMED");
  const [reasonNote, setReasonNote] = useState("");
  const [confirmationKey, setConfirmationKey] = useState(initialConfirmationKey);
  const [networkUncertain, setNetworkUncertain] = useState(Boolean(initialConfirmationKey));
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
    onProgress?.({ state: "CONFIRMING", previewId: preview.previewId, confirmationKey: key });
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
      {receipt ? <ReceiptPanel receipt={receipt} /> : null}
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
