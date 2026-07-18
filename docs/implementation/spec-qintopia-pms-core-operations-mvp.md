---
title: 'QinTopia PMS Core Operations MVP'
type: 'feature'
created: '2026-07-19'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - 'design-system/qintopia-pms/MASTER.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 从空目录建立房间/床位库存、订单、住宿履约、会员权益、版本化计价和人工收退款事实的唯一权威系统，并让运营 Web 与外围智能体 API 完成同一核心旅程。

**Approach:** 交付 PostgreSQL 支撑的模块化单体，以共享命令/查询层驱动 Fastify API 与 React Web；从可运行纵向切片推进到真实数据库并发、契约和浏览器验收。真实计价样例未返回前，只发布按夜固定价与免费政策，未知周/月/跨周期规则明确拒绝。

## Boundaries & Constraints

**Always:** 日期为物业时区半开区间 `[arrival, departure)`，金额为单币种最小货币整数。整房与子床逐日双向互斥，不同床位可并存，维修使用同一 claim。每单一个不可变主要居住人快照和一个 Stay；变更追加 segment、amendment、完整 pricing revision。确认锁定不可变政策版本，后续重算仍用该版本；新 revision 不继承旧手工调整。会员先形成逐日逐单元 coverageSet，再算 cashRemainder。收款/退款/冲销为订单内不可变事实，退款引用原收款。只暴露 `currentContractAmount`、`netRecordedCollection`、`collectionDifference`，不推导会计语义。所有写命令持久化幂等键、correlation ID、审计和 Receipt。

**Ask First:** 只有真实样例揭示新的计价、舍入、会员核销时点、未到释放或退款经营边界时才暂停确认。

**Never:** 读取旧 PMS/Git 历史；兼容、迁移、双写；通用公式/动态定价；支付或会计结算；跨订单资金分摊；内置 AI；外围投影回写或数据库直连；用 mock/占位金额通过核心验收。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 核心旅程 | 可售、报价、会员、订单、两笔收款、缩短、退款、入住/退房 | Web/API 产生等价事实和永久引用 | 统一错误 DTO |
| 库存竞争 | 同房同夜整房与床位并发 | 恰好一个事务成功；不同床可同时成功 | `INVENTORY_CONFLICT`，无部分写入 |
| 高风险确认 | 有效 Preview + reason + Confirm（正文重复精确 `propertyId`、`commandType` 和 effect hash） | 重验授权、版本、库存、权益和计价后原子提交 | 过期/变化为 `PREVIEW_STALE`，零业务写入 |
| 幂等恢复 | 同主体/物业/命令/键重放或响应中断 | 同载荷返回原 Receipt；以 `propertyId`、`commandType`、幂等键查询 EXECUTED/NOT_EXECUTED/UNKNOWN | 异载荷 `IDEMPOTENCY_KEY_REUSED` |
| 未配置计价 | 周/月/跨周期且无真实政策 | 不报价、不确认 | `PRICING_POLICY_UNCONFIGURED` |

</frozen-after-approval>

## Code Map

- `apps/api/` -- Fastify 认证、版本化 Query/Command API、OpenAPI、健康检查。
- `apps/web/` -- React 运营房态、订单详情与移动履约。
- `packages/domain/` -- 库存、订单、计价、权益、收退款不变量和命令处理。
- `packages/db/` -- Kysely PostgreSQL 模型、迁移、种子、事务仓储与恢复校验。
- `packages/contracts/` -- 共享 DTO、错误码、权限、Receipt/Preview 契约。
- `tests/` -- 单元、领域、PostgreSQL 集成、OpenAPI contract、Playwright E2E 与真实计价事实。

## Tasks & Acceptance

**Execution:**
- [x] 根配置与 `README.md` -- 可重复安装、Docker 启动、迁移、种子、备份恢复。
- [x] `packages/contracts/`、`packages/domain/` -- 固化 ID、命令、计价和领域不变量。
- [x] `packages/db/` -- 建模、日槽锁、事务、审计、Preview、Receipt、Token。
- [x] `apps/api/` -- 完整 `/api/v1` 查询/命令、OpenAPI、认证授权与 readiness。
- [x] `apps/web/` -- 使用相同 API 完成桌面核心旅程和移动入住/退房。
- [ ] `tests/` -- 覆盖计价金标、并发/回滚/陈旧/重放、安全、契约、无障碍和 E2E。

**Acceptance Criteria:**
- Given 空目录与 README，when 安装并启动，then PostgreSQL 迁移/种子、演示账号、health/readiness、Web 和 OpenAPI 可用。
- Given 种子数据，when 执行完整核心旅程，then 三金额可复算、历史追加且所有引用可查询。
- Given 受限 Token，when 查询、Preview/Confirm、幂等重放及中断恢复，then 权限不扩大且 Receipt 可判定结果。
- Given 两个真实数据库连接，when 竞争库存或制造事务故障，then 互斥与全量回滚成立。
- Given 用户提供的每个真实计价样例，when 运行金标验收，then coverageSet、现金明细、舍入和金额完全一致。

## Design Notes

PostgreSQL 按需创建 `room_day`，按稳定顺序 `SELECT ... FOR UPDATE`。成功业务事实与 Receipt 同事务提交；opaque Token 由客户端生成和保管、服务端仅存哈希，Preview/Receipt 均不返回 secret；有效权限取主体当前授权与 Token 上限/物业范围的交集。Preview 绑定主体、物业、命令类型、规范化输入哈希、effect hash、订单/库存/权益/政策版本和有效期；Confirm 正文必须重复精确的 `propertyId` 和 `commandType`。

## Verification

**Commands:**
- `npm run verify` -- lint/typecheck、单元与领域测试通过。
- `npm run test:integration` -- PostgreSQL 迁移、并发、回滚、Token、Preview/Receipt 通过。
- `npm run test:contract` -- OpenAPI schema 与示例通过。
- `npm run test:e2e` -- 桌面/移动核心旅程、键盘与 axe 通过。
- `./scripts/verify-backup-restore.sh` -- 新数据库恢复和引用/库存不变量检查通过。

## Spec Change Log

- 2026-07-19：安装、领域、数据库、API、Web 与非计价事实验收均已实现并完成发布级回归；`tests/` 仅因真实计价样例尚未提供而保持未完成，未将临住以外的周期规则或金标结果标记为完成。
