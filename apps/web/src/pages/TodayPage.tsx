import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronRight, DoorOpen, LogIn, LogOut, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import type { CommandType } from "@qintopia/contracts";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { CommandRequest, OrderRowDto } from "../types";
import { localDateInTimeZone } from "../dates";
import { CommandDialog, EmptyState, formatDate, guestName, InlineError, LoadingBlock, StatusBadge } from "../ui";

type TodayTab = "ARRIVALS" | "IN_HOUSE" | "DEPARTURES" | "EXCEPTIONS";

const tabs: Array<{ id: TodayTab; label: string }> = [
  { id: "ARRIVALS", label: "今日到店" },
  { id: "IN_HOUSE", label: "在住" },
  { id: "DEPARTURES", label: "今日离店" },
  { id: "EXCEPTIONS", label: "异常" }
];

export function TodayPage() {
  const { meta, propertyId } = useWorkspace();
  const propertyTimezone = meta.properties.find((property) => property.id === propertyId)?.timezone ?? "UTC";
  const [orders, setOrders] = useState<OrderRowDto[]>([]);
  const [businessDate, setBusinessDate] = useState(() => localDateInTimeZone(propertyTimezone));
  const dateEdited = useRef(false);
  const previousPropertyId = useRef(propertyId);
  const [tab, setTab] = useState<TodayTab>("ARRIVALS");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [command, setCommand] = useState<CommandRequest>();

  useEffect(() => {
    if (previousPropertyId.current === propertyId) return;
    previousPropertyId.current = propertyId;
    if (!dateEdited.current) setBusinessDate(localDateInTimeZone(propertyTimezone));
  }, [propertyId, propertyTimezone]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    api.orders(propertyId)
      .then((response) => current && setOrders(response.orders))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [propertyId, refreshToken]);

  const buckets = useMemo<Record<TodayTab, OrderRowDto[]>>(() => ({
    ARRIVALS: orders.filter((order) => order.arrival_date === businessDate && order.status === "RESERVED"),
    IN_HOUSE: orders.filter((order) => order.status === "CHECKED_IN"),
    DEPARTURES: orders.filter((order) => order.departure_date === businessDate && order.status === "CHECKED_IN"),
    EXCEPTIONS: orders.filter((order) => ["NO_SHOW", "CANCELLED"].includes(order.status) || (order.departure_date < businessDate && !["CHECKED_OUT", "CANCELLED", "NO_SHOW"].includes(order.status)))
  }), [businessDate, orders]);

  function directCommand(order: OrderRowDto, commandType: CommandType, title: string) {
    setCommand({
      commandType,
      title,
      description: "移动履约命令使用与桌面端相同的服务端 Preview、授权、事务和 Confirm。",
      input: { propertyId, orderId: order.id }
    });
  }

  const visible = buckets[tab];

  return (
    <div className="today-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">Mobile operations</p><h1>今日履约</h1><p>{formatDate(businessDate)}</p></div>
        <div className="today-date"><CalendarDays aria-hidden="true" size={17} /><label><span className="sr-only">营业日期</span><input type="date" value={businessDate} onChange={(event) => { dateEdited.current = true; setBusinessDate(event.target.value); }} /></label><button className="icon-button" type="button" onClick={() => setRefreshToken((value) => value + 1)} aria-label="刷新今日履约" title="刷新"><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={18} /></button></div>
      </header>
      <div className="today-tabs" role="tablist" aria-label="今日履约分类">
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls="today-tabpanel" id={`tab-${item.id}`} onClick={() => setTab(item.id)}><span>{item.label}</span><strong>{buckets[item.id].length}</strong></button>)}
      </div>
      <InlineError error={error} title="无法载入今日履约" />
      <section id="today-tabpanel" className="today-queue" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {loading ? <LoadingBlock label="正在载入履约队列" /> : visible.length === 0 ? <EmptyState title="当前队列为空" detail="该营业日期没有匹配的订单。" /> : visible.map((order) => (
          <article className="queue-row" key={order.id}>
            <div className="queue-icon" aria-hidden="true">{tab === "EXCEPTIONS" ? <AlertTriangle size={19} /> : tab === "DEPARTURES" ? <LogOut size={19} /> : tab === "ARRIVALS" ? <LogIn size={19} /> : <DoorOpen size={19} />}</div>
            <div className="queue-primary"><strong>{guestName(order.primary_guest_snapshot)}</strong><code>{order.id}</code><span>{formatDate(order.arrival_date)} 至 {formatDate(order.departure_date)}</span></div>
            <StatusBadge value={order.status} />
            <div className="queue-actions">
              {tab === "ARRIVALS" ? <button className="button button-primary" type="button" onClick={() => directCommand(order, "CHECK_IN", "办理入住")}><LogIn aria-hidden="true" size={17} />入住</button> : null}
              {tab === "DEPARTURES" || tab === "IN_HOUSE" ? <button className="button button-primary" type="button" onClick={() => directCommand(order, "CHECK_OUT", "办理退房")}><LogOut aria-hidden="true" size={17} />退房</button> : null}
              <Link className="icon-button" to={`/orders/${encodeURIComponent(order.id)}`} aria-label={`查看订单 ${order.id}`} title="查看订单"><ChevronRight aria-hidden="true" size={19} /></Link>
            </div>
          </article>
        ))}
      </section>
      {command ? <CommandDialog request={command} onClose={() => setCommand(undefined)} onCommitted={() => setRefreshToken((value) => value + 1)} /> : null}
    </div>
  );
}
