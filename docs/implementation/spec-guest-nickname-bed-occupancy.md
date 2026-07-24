---
title: 'Guest Nickname And Split-Bed Occupancy'
type: 'feature'
created: '2026-07-22'
status: 'done'
current_display_status: 'superseded-pending-parent-stage-5'
review_loop_iteration: 0
baseline_commit: '137920e6d33831dccc64a51d3d96a2a8f1fd355c'
superseded_display_requirement_by: '../../待开发项/房态与订单运营流程分步开发计划.md#阶段-5多人间首页显示全部住客昵称'
context:
  - 'docs/implementation/room-status-ui-development-goal.md'
  - 'docs/implementation/spec-qintopia-pms-core-operations-mvp.md'
  - 'design-system/qintopia-pms/MASTER.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** QinTopia 社区日常以昵称识别居住人，但订单主要居住人快照目前只有姓名；拆床销售房间的父格也无法在有限空间中说明当天住了几人、分别是谁。

**Approach:** 为所有新订单的主要居住人快照增加必填昵称，并沿用 Web/API 共享命令链保存和展示。由 PostgreSQL 房态投影按日期聚合真实住宿来源，在父格显示“已占/总床数”和首个昵称，悬停或键盘聚焦时展示全部床位与昵称。

## Boundaries & Constraints

**Always:** 新建订单的 `primaryGuest.nickname` 必须是去除首尾空白后的非空文本；Preview、Confirm、Receipt、订单查询和 amendment 快照均保留该值。历史快照允许缺失或 `null`，API 原样返回，Web 才派生“历史未记录”。拆床房父格分子仅统计当天被活动正常订单或 `FREE_STAY` 占用的不同实体床，显示统一为 `已占/总床数`；昵称列表必须可由鼠标和键盘访问。

**Ask First:** 只有昵称唯一性、昵称修改历史、多个实际居住人模型、隐私遮蔽范围，或把维修/内部占用/清洁纳入住客占用统计时需要重新确认。

**Never:** 不把会员建成另一种居住人身份；不根据 Claim、维修、内部占用或清洁伪造住客人数；不以姓名覆盖昵称；不持久化“历史未记录”提示；不为 JSON 快照增加无意义数据库回填或虚构历史昵称。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 新建正常或免费订单 | 主要居住人包含真实姓名和昵称 | Preview 显示昵称，Confirm 后 Receipt、Query 和房态可追溯 | 缺失或空白昵称在 Preview 前拒绝且零写入 |
| 历史订单 | 快照没有 `nickname` 或为 `null` | API 原样返回；Web 显示“历史未记录”或在需识别人时回退真实姓名 | 不回填伪造值 |
| 四人间三床占用 | 三个不同床位有活动正常/免费住宿 | 父格显示 `3/4` 和 `首个昵称 +2`；可访问提示列出三张床与全部昵称 | 聚合缺失时 fail closed，不在客户端猜人数 |
| 非住宿阻断 | 维修、内部占用或清洁覆盖当天 | 保留原 typed source 和阻断语义，不增加住客占用分子 | 不显示虚构昵称 |
| 整房订单 | 不按床销售的房间或多人间整房成交 | 保留主要居住人昵称及原整房状态 | 不将一个整房订单扩成多个虚构床位住客 |

</frozen-after-approval>

## Post-Approval Display Supersession

用户在 2026-07-23 查看真实房态后明确取消“首个昵称 +N、其余昵称仅悬停可见”的紧凑展示。最新权威要求是：多人间父房逐日格在首页直接显示当天每一个有权查看的住客昵称，并同时保留 `已占/总床数`；昵称按床位稳定顺序排列、同名不去重、历史缺失逐项显示“历史未记录”，Tooltip/键盘详情只补充床号和来源，不能作为其余昵称的唯一入口。

本文件冻结块、已完成任务和验证数量继续记录 commit `4fbf90d` 之前的历史实现证据，不再定义当前目标展示。新增量由 `房态与订单运营流程分步开发计划.md` 的阶段 5 负责实现和人工验收；完成前本文件的 `status: done` 只能表示旧“昵称 +N”增量曾经完成，不能被解释为最新展示要求已经完成。

以下 Code Map、勾选任务、变更记录、Design Notes、验证数量和手工检查全部是旧基线的历史证据；其中“固定高度”“昵称 +N”“客户端压缩显示”等描述已被上面的最新规则取代，不得作为新实现或验收标准。

## Historical Baseline Code Map

- `packages/contracts/src/index.ts` -- 可兼容历史空值的居住人快照与房态 occupancy DTO。
- `apps/api/src/schemas.ts` -- 新命令必填昵称及 OpenAPI schema。
- `packages/db/src/commands/` -- Preview/effect/Confirm/Receipt 的昵称校验和快照持久化。
- `packages/db/src/migrations/014_new_order_primary_guest_nickname.sql` -- 仅约束迁移后的新订单写入；保留历史缺失或 `null` 昵称，不扫描、不回填虚构值。
- `packages/db/src/room-status.ts` -- 按物业日期、父房和实体床聚合活动住宿昵称。
- `apps/web/src/pages/InventoryPage.tsx` -- 创建订单表单、Preview 和恢复状态中的昵称输入。
- `apps/web/src/room-status/RoomStatusGrid.tsx` -- 固定高度父格比例、摘要和可访问完整名单。
- `apps/web/src/pages/OrdersPage.tsx`, `apps/web/src/pages/OrderDetailPage.tsx`, `apps/web/src/ui.tsx` -- 昵称优先的查找、标题和履约显示。
- `tests/` -- 领域、PostgreSQL、OpenAPI、共享协议和浏览器回归。

## Historical Baseline Tasks & Acceptance

**Execution:**
- [x] 扩展共享合同和 API schema，保持历史快照兼容并严格校验所有新建命令。
- [x] 将昵称贯穿 Preview、effect、Confirm、Receipt、订单/修订 Query 和 Web 表单。
- [x] 在 PostgreSQL 房态投影中生成可复核的逐日床位占用聚合。
- [x] 实现父格 `3/4`、`昵称 +N` 和悬停/键盘完整名单，保持单元格稳定尺寸。
- [x] 更新订单、履约和搜索界面，使社区称呼优先但不丢失法定姓名。
- [x] 修复完整 Playwright 回归并以最新代码恢复可试用实例。
- [x] 完成独立审查并关闭发现。

**Acceptance Criteria:**
- Given 任一新正常或免费订单，when API 或 Web 未提供非空昵称，then 命令在 Preview 前失败且命令、审计和业务事实均为零写入。
- Given 同一四人间三张床有三名活动住客，when 打开房态，then 父格稳定显示 `3/4` 和首个昵称摘要，鼠标悬停及键盘聚焦都能读取全部床位与昵称。
- Given 同日另有维修、内部占用或清洁事实，when 投影聚合占用，then 住客占用分子仍只来自正常订单和 `FREE_STAY`。
- Given 历史快照无昵称，when 通过 Query 和 Web 查看，then API 保留空值语义且 UI 明确派生历史兼容提示。

## Historical Baseline Change Log

- 2026-07-23：完整 Playwright 最终通过 43 个适用场景、35 个按项目条件跳过；修复 Tooltip 前向 Tab 的嵌套焦点冒泡，并让滚动后的悬停验收先稳定可视位置再交互。Axe 仍执行全部规则，但只回传实际 violations，避免未使用结果放大浏览器协议负载。
- 2026-07-23：将 migration 014 纳入 `databaseReady`、恢复、备份恢复及 Compose 冷启动的 14 个必需迁移门禁；主演示数据库已应用 014，最终镜像和 `127.0.0.1:4100` 实例均由 readiness 验证。
- 2026-07-23：完成独立盲审与边界审查；补齐数据库新写入门禁、READY occupancy 完整性、重复 Claim 合并、Tooltip 滚动关闭和物业切换前恢复快照刷新。
- 2026-07-23：新增 migration 014。迁移后新订单必须保存非空 `primaryGuest.nickname`；历史缺失或 `null` 昵称保持原样，Web 仅派生兼容提示。
- 2026-07-23：记录已完成的单元、PostgreSQL 集成、契约、计价事实及 production Web build 结果；最终完整 Playwright 总数和实例恢复待交付流程确认。

## Historical Baseline Suggested Review Order

1. 从共享合同与 `apps/api/src/schemas.ts` 核对新建命令的昵称输入、历史空值兼容及 OpenAPI 表达。
2. 查看 migration 014 和 `packages/db/src/commands/`，确认数据库门禁、Preview/Confirm/Receipt 与 amendment 快照语义一致。
3. 查看 `packages/db/src/room-status.ts`，核对 occupancy 的来源过滤、床位去重及 READY 完整性校验。
4. 查看 `InventoryPage.tsx`、`RoomStatusGrid.tsx` 和订单页面，核对表单必填、`已占/总床数`、全部昵称 Tooltip 与历史提示。
5. 最后按 Verification 顺序运行自动化套件，并以最终 Playwright 和 readiness 结果完成运行态验收。

## Historical Baseline Design Notes

昵称属于订单确认时的不可变主要居住人快照，不另建可变住客档案字段。父格聚合由服务端提供 `occupiedBedCount`、`totalBedCount` 和按稳定床位顺序排列的居住人摘要；客户端只负责压缩显示和可访问展开，避免把来源筛选或人数计算复制到浏览器。

## Historical Baseline Verification

**Commands:**
- `npm run verify` -- 16 files、201/201 tests 通过。
- `npm run test:integration` -- 15 files、137/137 tests 通过，覆盖 PostgreSQL 快照、聚合、历史兼容和零写入边界。
- `npm run test:contract` -- 8 files、54/54 tests 通过，覆盖 OpenAPI、Command、Preview、Receipt 和 Query DTO。
- `npm run test:pricing-facts` -- 通过。
- `npm run build` -- production Web build 通过；该命令不代表 API build。
- `npm run test:e2e` -- 43 passed、35 skipped；跳过项仅为 desktop/mobile 项目不适用的镜像用例，全部适用场景通过。
- `curl -fsS http://127.0.0.1:4100/health/ready` -- 返回 `{"status":"ready"}`；首页、liveness、OpenAPI JSON 和 Swagger UI 同时通过运行态探测。

**Manual checks:**
- 在桌面房态核对父格无高度漂移、中文不截断关键事实，并分别用鼠标和键盘打开全部昵称提示。
- 以独立 Chromium 登录最终 `127.0.0.1:4100` 实例，确认真实 44 房投影可见；最终运行态截图为 `test-results/final-live-4100.png`，昵称长名单截图为 `test-results/room-status-split-bed-pare-5b377-io-and-every-guest-nickname-desktop/room-status-bed-occupancy-nicknames.png`。
