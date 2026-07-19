# 真实计价事实门

这里保存用户确认的 QinTopia 2026 计价事实，不是演示数据。权威来源是飞书工作簿 revision `561` 以及用户随后确认的跨度、舍入、变更、会员、免费和手工指定规则。

运行：

```bash
npm run test:pricing-facts
```

门禁会：

- 用 JSON Schema 2020-12 校验 `cases/*.json`；
- 要求七种经营标签、缩短、续住、跨月、换房、部分会员覆盖、手工指定和跨度边界都有结构化证据；
- 通过 `tests/pricing-facts/executors.ts` 调用生产领域计价函数，而不是返回固定结果；
- 精确比较每个 pricing revision、coverageSet、现金行计算证据、cash remainder 和 current contract amount；
- 验证所有 amendment 继续引用成交时锁定的 policy version。

经营标签不定义不同公式。正常现金住宿都使用同一个连续日期政策；案例分布到七种标签，是为了证明 API 中现有标签不会改变已确认公式。免费住宿使用独立零金额政策，会员住宿先覆盖具体日期，未覆盖日期使用 P1。

公开价的 10 产品 × `1/6/7/13/14/29/30/31` 晚金标和额外连续边界位于 `packages/domain/src/pricing-2026.test.ts`。完整目录与公式见 `qintopia-2026-building-room-bed-price-catalog.md`。

新增事实时必须提供来源、业务解释、日期半开区间、产品、权益日期、amendment 顺序、锁定政策、舍入证据和预期完整 revision。禁止加入合成占位值、旧系统推断或未确认公式。
