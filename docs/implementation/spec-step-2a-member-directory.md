---
title: '第 2 步检查点 2A：会员列表与建档'
type: 'feature'
created: '2026-07-23'
status: 'accepted'
review_loop_iteration: 0
baseline_commit: '4fbf90daa47803ed4ac7ae3f4f46d256665d1e16'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 现有会员页只能按身份证号查找，手工建档还要求合同日期和飞书申请号，并用一张空合同承载门店归属，不符合检查点 2A 的“会员档案独立于会员订单”边界。

**Approach:** 建立会员与门店的稳定关联，提供四字段统一搜索、会员列表和中文档案详情；手工建档只收集姓名、身份证号、手机号和微信号，并继续使用现有 Preview/Confirm、幂等、权限和审计协议。

## Boundaries & Constraints

**Always:** 身份证号规范化后是全局唯一业务键，内部 `memberId` 不可变；手机号和微信号允许重复。新档案必须关联当前门店，但不得创建合同、会员订单、权益 Lot/Ledger 或飞书引用。历史会员按既有合同/外部引用回填门店关联，旧业务事实保持不变。工作人员页面使用中文业务语言，不显示内部 ID 或协议对象名。

**Ask First:** 若实现发现必须改变已确认的身份证号全局唯一规则、允许手工建档静默复用另一门店的同身份证会员，或需要删除/改写历史合同与权益事实，立即停止并确认。

**Never:** 不实施 2B 的产品、成交价、企微收款、更正和生效；不实施 2C 的余额调整、覆盖、冻结或核销；不读取旧 PMS/FewohBee 项目，不清理当前工作树既有改动。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 建档 | 四项资料合法且身份证未存在 | 原子创建档案和当前门店关联，列表立即选中新会员 | 任一步失败零业务写入 |
| 重复身份证 | 大小写或首尾空白不同但规范化后相同 | 不创建第二个会员 | 中文明确提示身份证已登记 |
| 四类搜索 | 姓名、身份证号、手机号或微信号的完整/片段文本 | 同一搜索框返回任一字段匹配项 | 空查询返回当前门店全部会员 |
| 重复联系方式 | 两位会员手机号或微信号相同 | 两位均可创建并可被搜索到 | 不作唯一性报错 |
| 门店隔离 | 会员未关联当前门店 | 不出现在列表且详情不可访问 | 返回 404，不泄露档案 |

</frozen-after-approval>

## Code Map

- `packages/db/src/migrations/016_member_property_links.sql` -- 新增、回填并约束会员门店关联。
- `packages/db/src/schema.ts`、`packages/db/src/members.ts` -- 类型、四字段查询、门店隔离详情与零合同档案。
- `packages/db/src/commands/effects.ts`、`packages/db/src/commands/apply.ts` -- 建档 Preview、锁与原子落库。
- `packages/contracts/src/index.ts`、`apps/api/src/schemas.ts`、`apps/api/src/server.ts` -- 命令/查询/OpenAPI 契约。
- `apps/web/src/api.ts`、`apps/web/src/types.ts`、`apps/web/src/pages/MembersPage.tsx`、`apps/web/src/styles.css` -- 统一搜索、列表、详情和四字段建档体验。
- `tests/integration/member-profile-lifecycle.integration.test.ts`、`tests/contract/openapi.contract.test.ts`、`apps/web/src/pages/MembersPage.test.ts`、`tests/e2e/core-journey.spec.ts` -- PostgreSQL、契约、页面逻辑和真实浏览器门禁。

## Tasks & Acceptance

**Execution:**
- [x] 新增并回填 `member_property_links`，使会员归属不依赖空合同，保护既有档案/合同/权益。
- [x] 调整 `CREATE_MEMBER`，手工建档原子创建档案与门店关联；重复身份证明确拒绝且幂等重放仍返回原结果。
- [x] 将会员列表查询改为单一 `query` 参数，安全匹配四种资料并保持门店隔离。
- [x] 重构会员页为可扫描列表与档案详情；建档仅四字段，保留可恢复确认流程和响应式/无障碍行为。
- [x] 补齐领域边界、PostgreSQL、OpenAPI、Web 与 E2E 回归，准备 2A 演示数据和人工步骤。

**Acceptance Criteria:**
- Given 当前门店的工作人员，when 用四类资料任一项搜索，then 只看到当前门店所有匹配会员并可打开完整四字段档案。
- Given 合法四字段且身份证未登记，when 确认建档，then 只新增一个会员档案和门店关联，不新增合同或权益事实。
- Given 规范化后重复的身份证，when 再次建档，then 页面中文拒绝且数据库零新增；相同手机号或微信号不阻止不同身份证建档。
- Given 网络重放、陈旧 Preview 或并发重复建档，when 服务端处理，then 最多一个会员落库，Receipt/审计与零部分写入规则保持成立。
- Given 桌面和手机视口，when 搜索、打开详情或建档，then 控件可达、文本不重叠且页面不出现内部 ID、合同日期或飞书申请字段。

## Spec Change Log

- 2026-07-24：用户完成全部 2A 人工验收，确认四字段建档、列表详情、四类搜索、身份证规范化去重、重复联系方式和中文界面均符合预期；检查点状态改为 `accepted`。

## Design Notes

`member_property_links(member_id, property_id)` 只表达“此门店可见该会员”，不表达会员产品有效期或权益。迁移从已有 `member_contracts` 与 `member_external_references` 去重回填；后续 2B 会员订单仍以独立事实建模。

## Verification

**Commands:**
- `npm run typecheck && npm run test` -- 类型检查和单元回归通过。
- `npm run test:integration` -- 建档、搜索、唯一性、并发与门店隔离使用真实 PostgreSQL 通过。
- `npm run test:contract` -- OpenAPI 与命令/查询契约通过。
- `npm run test:e2e` -- 2A 真实浏览器旅程、响应式和无障碍通过。

## Suggested Review Order

**档案与门店边界**

- 独立关联表锁定回填窗口，并兼容切换期旧写入。
  [`016_member_property_links.sql:1`](../../packages/db/src/migrations/016_member_property_links.sql#L1)

- 全局元数据与目录共用门店关联事实。
  [`server.ts:257`](../../apps/api/src/server.ts#L257)

- 四字段安全搜索与门店隔离从领域查询统一执行。
  [`members.ts:86`](../../packages/db/src/members.ts#L86)

**原子建档协议**

- Preview 固定档案与门店关联效果，不承载订单权益。
  [`effects.ts:297`](../../packages/db/src/commands/effects.ts#L297)

- Confirm 校验固定效果后原子写入档案及关联。
  [`apply.ts:258`](../../packages/db/src/commands/apply.ts#L258)

**工作人员体验**

- 目录请求切换和失败时先清空旧门店资料。
  [`MembersPage.tsx:142`](../../apps/web/src/pages/MembersPage.tsx#L142)

- 建档预检、错误和恢复界面仅呈现中文业务信息。
  [`ui.tsx:715`](../../apps/web/src/ui.tsx#L715)

**自动化门禁**

- Readiness 和恢复检查要求最新会员目录迁移。
  [`database.ts:19`](../../packages/db/src/database.ts#L19)

- PostgreSQL 覆盖原子性、隔离、幂等及真实并发确认。
  [`member-profile-lifecycle.integration.test.ts:93`](../../tests/integration/member-profile-lifecycle.integration.test.ts#L93)

- 升级测试覆盖外部引用回填、事实保护和切换写入。
  [`migration-concurrency.integration.test.ts:127`](../../tests/integration/migration-concurrency.integration.test.ts#L127)

- 浏览器覆盖完整 2A 旅程、失败关闭和响应恢复。
  [`core-journey.spec.ts:593`](../../tests/e2e/core-journey.spec.ts#L593)
