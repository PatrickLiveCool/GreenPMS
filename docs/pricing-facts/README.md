# Real Pricing Fact Intake

Real cases supplied by the business owner are golden acceptance facts, not examples to reinterpret. Add one JSON file per case using `pricing-case.schema.json`, then add it to the parameterized pricing-fact test suite.

The intake set must cover every offered stay plan: transient, weekly, monthly, custom period, fixed term, rolling renewal, and free stay. It must also cover shortening, extension, cross-month or cross-cycle behavior, partial member coverage, manual adjustment, and move-related repricing when a move can affect amount. Include at least two cases where a boundary changes behavior, such as 6-to-7 nights, month end, or a renewal boundary.

Use `scenarioTags` to make that coverage explicit. One real order may cover several tags, but every stay plan and every applicable change scenario needs at least one evidenced expected result before the corresponding policy can be published.

Required evidence for each case:

- anonymized order reference and business explanation
- property timezone and currency
- inventory kind and service-date interval, including whether departure is charged
- policy/business-plan name and the exact price inputs known at sale time
- member coverage dates and entitlement kind, if any
- every amendment in recorded order, including when it was requested
- expected line breakdown, cycle/proration behavior, rounding point/mode, and final `currentContractAmount`
- for shortening, extension, or move: original amount, new dates/unit, and expected new amount

Do not add a policy implementation until its full evidence set has expected outputs. Do not generalize from one case beyond the demonstrated boundary.
