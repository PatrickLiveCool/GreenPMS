---
title: '第 2 步检查点 2C：账本余额与会员住宿'
type: 'feature'
created: '2026-07-24'
status: 'accepted'
checkpoint: '2C'
---

# 第 2 步检查点 2C：账本余额与会员住宿

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 2B 已能出售并生效会员产品，但工作人员还不能在会员详情查看真实账本余额、用目标余额追加更正事实，或在普通住宿中按需选择会员并完成覆盖、冻结与入住核销。

**Approach:** 复用现有 Lot/Ledger、Quote 和住宿生命周期写入路径。会员详情按 Lot/Ledger 实时计算 ROOM_NIGHT/BED_NIGHT 余额；余额更正输入“更正后剩余数 + 原因”，由服务端锁定 Lot、计算 delta 并追加 ADJUST。住宿默认关闭会员模式；开启后只选择 memberId，服务端按有效期、余额、权益类型和产品房型匹配单一 Lot。

## Boundaries & Constraints

**Always:** 公卫单人间会员只覆盖 shared_bath_single ROOM；独卫单人间会员只覆盖 private_bath_single ROOM；公卫四人间会员只覆盖 shared_bath_quad BED。部分覆盖先用权益覆盖可用日期，未覆盖日期按已锁定 P1 一夜价逐日计价，最终总价只舍入一次。会员住宿无论全额、部分还是零余额覆盖，渠道和渠道订单号都必须为 `null`。预订 HOLD、入住 CONSUME、入住前取消/未到/缩短 RELEASE HELD；已 CONSUMED 不恢复。

**Ask First:** 同一会员存在多个可覆盖同一天、同类型、同房型的有效 Lot 时，消耗顺序必须由用户确认。当前实现必须中文明确拒绝并保持零权益、零库存写入，不得自行选择最早到期、创建时间或数据库顺序。

**Never:** 不把余额写成可覆盖档案字段，不让工作人员选择内部合同或 Lot ID，不把权益折现，不实现退费，不进入第 3 步，不读取旧 PMS/FewohBee 项目。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 查看余额 | 已生效 Lot 与 Ledger | 显示当前 ROOM_NIGHT/BED_NIGHT 余额及完整事实历史 | 不缓存为档案数字 |
| 更正余额 | 目标剩余数、原因、单个 Lot | 服务端计算 target-current，并追加一笔 ADJUST | 负数、陈旧余额、无原因、多 Lot 歧义均零写入 |
| 普通住宿 | 未开启会员模式 | 不显示会员搜索或覆盖摘要，不读取权益 | 不产生 HOLD/CONSUME |
| 单一 Lot 覆盖 | memberId、匹配房型、有效余额 | 按日期形成 coverageSet；不足部分按 P1 计价 | 不匹配房型或过期 Lot 覆盖 0 晚 |
| 多 Lot 歧义 | 同日有两个匹配有效 Lot | 中文明确拒绝 | 零权益、零库存写入 |
| 四人间整房 | 公卫四人间会员 + ROOM 组合 | 明确拒绝 | 不降级成床位、不扣权益 |
| 生命周期 | 预订、入住、取消/未到/缩短 | HOLD、CONSUME、RELEASE 严格守恒 | 并发不得超额冻结或重复核销 |
| 会员住宿渠道 | 全额、部分或零余额覆盖 | 表单、核对、成功页和订单详情均不显示渠道；持久化两个渠道字段为 null | 绕过页面提交渠道时服务端拒绝且零业务写入 |

## Data and Command Model

- Quote 输入使用可选 memberId，不接受工作人员选择 memberContractId；服务端据 memberId、门店、服务日期、权益类型、产品房型选择唯一可用 Lot。
- Lot 的可用余额由 total_units + Ledger delta 计算；Ledger 是不可变追加事实。
- 余额更正命令输入 entitlementLotId、targetAvailableBalance、adjustmentReason 和预期当前余额；事务内加锁重算并追加 ADJUST。
- Quote 返回总晚数、覆盖晚数、未覆盖晚数和未覆盖金额；普通模式隐藏覆盖摘要，会员模式即使覆盖为 0 也显示完整摘要。
- Confirm 继续复算并冻结 coverageSet；现有 CHECK_IN、取消、未到、缩短和续住路径继续承担 CONSUME/RELEASE，不建立第二条生命周期路径。

## Tasks & Acceptance

- [x] 新增 2C 失败测试：真实余额、目标余额更正、memberId 选择、三产品房型金标、多 Lot 歧义与零写入。
- [x] 扩展 Query/Command/Quote，使单一匹配 Lot 的全额、部分和 0 余额覆盖可用且可审计。
- [x] 更新会员详情和普通住宿 UI，完成余额、Ledger、更正和按需会员覆盖摘要。
- [x] 验证 HOLD/CONSUME/RELEASE、并发、幂等、陈旧预检及普通/免费住宿隔离。
- [x] 完成 unit、PostgreSQL integration、OpenAPI contract、桌面/移动 E2E 和人工验收实例。

**Acceptance Criteria:**

- Given 已生效权益，when 查看会员详情或追加目标余额更正，then 当前余额与不可变 Ledger 历史一致，旧事实不被修改。
- Given 未开启会员模式，when 创建普通住宿，then 不读取、冻结或核销权益，页面不显示“覆盖 0 晚”。
- Given 开启会员模式并选择会员，when 报价，then 服务端只使用房型精确匹配的单一有效 Lot，并返回总晚数、覆盖晚数、未覆盖晚数和未覆盖金额。
- Given 权益不足或为 0，when 报价，then 未覆盖日期按锁定 P1 一夜价逐日计价且最终总价只舍入一次。
- Given 多 Lot 歧义、不匹配房型、四人间整房、并发超额或陈旧确认，when 提交，then 明确失败关闭且零权益、零库存部分写入。
- Given 会员住宿完成预订、入住或入住前取消/未到/缩短，then Ledger 分别追加 HOLD、CONSUME 或 RELEASE，已核销权益不被隐式恢复。
- Given 选择会员权益创建住宿，when 核对、确认、恢复或查看订单，then 不要求或显示订单来源渠道，不出现 Preview、Receipt、Command 或内部 ID；绕过页面提交渠道必须失败且零业务写入。

</frozen-after-approval>

## Spec Change Log

- 2026-07-24：2B 人工验收通过后创建 2C 实施规格；多 Lot 消耗顺序仍为业务 gate，因此歧义场景失败关闭。
- 2026-07-24：2C 实现与自动化验证完成，状态转为等待人工验收；第 3 步保持未开始。
- 2026-07-24：根据人工验收反馈修复“入住核销”误显示余额净变化 `0` 的问题；工作人员界面改为显示该住宿日期实际核销 `1 间夜/床夜`，底层守恒账本仍保持 CONSUME delta 为 0。
- 2026-07-24：根据复验反馈明确区分展示语义：冻结、释放、更正和到期显示“余额 ±N”，入住显示“本次核销 N”，避免给核销数量添加会暗示重复扣减的负号。
- 2026-07-24：根据复验反馈取消正常会员页面中的“历史未归类权益”；多个有明确产品归属的正式权益继续并行展示，匿名旧账仅保留底层审计兼容能力。
- 2026-07-24：人工复验发现 Demo 已生效会员订单缺少收款事实；回到处理中，修复演示数据的订单、收款与权益一致性。
- 2026-07-24：人工复验确认会员住宿不应填写订单来源渠道，且工作人员按钮和核对流程不得暴露 `Preview`；回到处理中统一前后端业务语义。
- 2026-07-24：会员住宿渠道规则已落实到 Web、API、Confirm 和数据库迁移 019；核对、成功、恢复及订单详情统一为中文业务语义，2C 重新进入等待人工验收。
- 2026-07-24：人工复验要求选择会员后预填主要居住人姓名、昵称、联系电话和证件号码，同时保留本次住宿快照的可编辑性；2C 回到处理中补充实现和回归门禁。
- 2026-07-24：会员资料预填与可编辑快照已完成：姓名和昵称预填会员姓名，联系电话和证件号码预填会员手机号与身份证号；操作人修改后按修改值创建订单，2C 重新进入等待人工验收。
- 2026-07-24：用户明确回复“第 2 步通过”；2C 与第 2 步人工验收完成，状态转为 accepted，第 3 步保持未开始。

## Dev Agent Record

### Completion Notes

- 会员详情显示按 Lot/Ledger 实时计算的间夜、床夜余额、产品、有效期和完整变动历史；目标余额更正只追加 ADJUST，不覆盖旧事实。
- 普通住宿默认不携带会员；按需开启后只选择会员档案。服务端按三种产品精确匹配房型，支持全额、部分和零覆盖，并对多 Lot 歧义失败关闭。
- 预订 HOLD、入住 CONSUME、入住前 RELEASE 与并发最后一晚守恒均落入同一事务路径；迁移 018 增加门店归属、日期、账本和 coverage 数据库守卫。
- 修复余额更正后无条件清空会员搜索导致页面跳到另一位会员的问题；已有会员操作现在保持当前档案，新建会员仍会清空搜索并选中新档案。
- 修复入住核销记录直接展示内部账本净变化的问题：预订冻结已扣减余额，入住只做 HELD → CONSUMED，因此底层 delta 仍为 0；界面按每条服务日期记录显示“本次核销 1 个住宿单位”，其他记录明确标注“余额 ±N”。
- 正常会员页面现在只汇总和展示有明确会员产品归属的正式权益；同一会员的多种正式权益保持并行，分别显示产品、余额、单位和有效期。匿名旧 Lot 及其账本事实不再混入业务页面，但底层不可变审计事实仍保留。
- Demo 种子不再创建没有会员产品归属的床夜 Lot；既有 2C 验收库中的匿名旧账受 append-only 守卫保护，未绕过守卫删除，改由业务视图安全过滤。
- 修复 Demo 已生效会员订单绕过正常命令路径却缺少收款事实的问题：种子与现有验收库均追加一笔 `¥1,620` 企微收款，交易号 `DEMO-WECOM-20260101-001`；页面现在显示收款与成交价一致、1 笔有效收款。正常业务的零收款生效拒绝规则保持不变。
- 会员住宿不再显示或提交订单来源渠道及渠道订单号；普通非会员住宿仍要求合法渠道。API、Confirm 和迁移 019 共同约束会员住宿渠道必须为空，绕过页面提交渠道会失败且不产生业务写入。
- 会员住宿按钮改为“核对并创建订单”；核对、成功、持久化恢复和订单详情使用中文业务文案，订单详情显示“住宿来源：会员权益”，不泄露 Preview、Receipt、Command、幂等键或内部 ID。
- 选择会员档案后，主要居住人的姓名和昵称预填会员姓名，联系电话和证件号码预填会员手机号与身份证号；四项只是本次住宿的初始快照，操作人可逐项修改，创建请求保存修改后的值且后续报价刷新不会重新覆盖。

### Validation

- TypeScript、production build、`git diff --check`：通过。
- Unit：`222/222` 通过；pricing facts：`7/7` 通过。
- PostgreSQL integration：2C `8/8`、数据库不变量 `11/11` 通过；迁移 019 覆盖会员渠道为空、普通住宿渠道必填及历史升级路径。
- Contract：`56/56` 通过。
- Playwright 2C desktop + mobile：`2/2` 通过，覆盖普通报价不携带 memberId、余额更正、部分覆盖、HOLD 与真实入住核销，以及会员住宿无渠道、中文核对/成功页、订单详情来源语义和桌面/手机无横向溢出。
- 全量 integration 最近一次为 `154/155`；唯一失败是第 1 步既有 `supports move, extension, and shortening while checked in` 的 `New departure must shorten the stay`，不属于 2C，本检查点未扩大范围修复。
- 最终复验：2C PostgreSQL `8/8`、Contract `56/56`、Unit `222/222`、TypeScript、production build、`git diff --check` 均通过；会员住宿渠道绕过被数据库和服务端拒绝，业务零写入。
- 会员资料预填复验：先以缺失预填的桌面 E2E 得到预期红灯，再实现选择时预填；桌面、手机 E2E `2/2` 通过，并断言人工修改四项后 CREATE_ORDER 保存修改后的快照。全量 Unit `222/222`、TypeScript、production build、`git diff --check` 通过。
- 最终收口：第 2 步 PostgreSQL 聚焦测试 `27/27`、Contract `56/56`、会员订单与会员住宿桌面/手机 E2E `4/4`、Unit `222/222`、TypeScript、production build、`git diff --check` 通过。完整 integration `154/155`，唯一失败仍为第 1 步既有入住后缩短用例，不属于第 2 步。
