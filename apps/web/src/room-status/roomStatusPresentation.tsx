import { useSyncExternalStore, type ComponentType, type SVGProps } from "react";
import {
  AlertTriangle,
  Ban,
  BedDouble,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  RefreshCw,
  Sparkles,
  Wrench
} from "lucide-react";
import type { RoomStatusActionCode, RoomStatusBlockingFactKind, RoomStatusSourceKind, RoomStatusStatus } from "@qintopia/contracts";

type StatusIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: string | number }>;

export interface RoomStatusPresentation {
  label: string;
  Icon: StatusIcon;
}

export const roomStatusPresentation: Record<RoomStatusStatus, RoomStatusPresentation> = {
  AVAILABLE: { label: "可售", Icon: CheckCircle2 },
  RESERVED: { label: "已预订", Icon: CalendarClock },
  IN_HOUSE: { label: "在住", Icon: BedDouble },
  CLEANING: { label: "待清洁", Icon: Sparkles },
  MAINTENANCE: { label: "维修 / 锁房", Icon: Wrench },
  INTERNAL_USE: { label: "内部占用", Icon: Briefcase },
  UNAVAILABLE: { label: "不可售", Icon: Ban },
  STALE: { label: "数据陈旧", Icon: RefreshCw },
  UNKNOWN: { label: "状态未知", Icon: CircleHelp }
};

export const roomStatusSourceLabels: Record<RoomStatusSourceKind, string> = {
  ORDER: "正常订单",
  FREE_STAY: "免费入住",
  MAINTENANCE: "维修锁房",
  INTERNAL_USE: "内部占用",
  CLEANING: "清洁任务",
  UNIT_UNSELLABLE: "库存不可售"
};

export const roomStatusBlockingFactLabels: Record<RoomStatusBlockingFactKind, string> = {
  CLAIM: "库存 Claim",
  LODGING_ORDER: "住宿订单事实",
  OVERDUE_IN_HOUSE: "逾期未退在住事实",
  UNIT_UNSELLABLE: "库存不可售事实"
};

export const roomStatusActionLabels: Record<RoomStatusActionCode, string> = {
  CREATE_ORDER: "创建正常住宿订单",
  CREATE_FREE_STAY: "创建免费入住",
  PLACE_INTERNAL_USE: "放置内部占用",
  LOCK_MAINTENANCE: "放置维修锁房",
  OPEN_ORDER: "打开订单",
  RELEASE_MAINTENANCE: "释放维修锁房",
  RELEASE_INTERNAL_USE: "释放内部占用",
  COMPLETE_CLEANING: "完成清洁"
};

export function formatRoomStatusDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

export function formatRoomStatusDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(parsed);
}

export function RoomStatusMark({ status, compact = false }: { status: RoomStatusStatus; compact?: boolean }) {
  const presentation = roomStatusPresentation[status];
  const Icon = presentation.Icon;
  return (
    <span className={`room-status-mark room-status-mark-${status.toLowerCase().replaceAll("_", "-")}${compact ? " room-status-mark-compact" : ""}`}>
      <Icon aria-hidden="true" size={compact ? 14 : 16} />
      <span>{presentation.label}</span>
    </span>
  );
}

export function RoomStatusWarning({ children }: { children: string }) {
  return (
    <span className="room-status-warning">
      <AlertTriangle aria-hidden="true" size={15} />
      {children}
    </span>
  );
}

const mobileMediaQuery = "(max-width: 575px)";

function subscribeToMobileViewport(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(mobileMediaQuery);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function mobileViewportSnapshot(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(mobileMediaQuery).matches;
}

export function useRoomStatusMobileViewport(): boolean {
  return useSyncExternalStore(subscribeToMobileViewport, mobileViewportSnapshot, () => false);
}
