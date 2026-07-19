# QinTopia Core Invariants and Decisions

## Domain invariants

1. Service dates are property-local ISO dates in `[arrivalDate, departureDate)`; departure does not claim inventory.
2. Every bed belongs to one room. A whole-room claim conflicts with every child-bed claim on the same service date; different child beds may coexist.
3. Orders and maintenance use the same claim tables and ordered `roomId + serviceDate` row locks.
4. An order has one immutable primary-guest snapshot and exactly one Stay. Changes append amendments and stay segments.
5. Confirmation locks an immutable pricing-policy version. Any amount change appends a complete revision calculated with that same version.
6. A revision's manual adjustment belongs only to that revision and defaults to zero in the next revision.
7. Membership coverage is a concrete set of date/unit/lot entries. Holds reduce available night units, release restores them, consume records fulfillment without converting the night to cash.
8. Collection, refund, and reversal facts are append-only. Refunds reference a collection in the same order and cannot exceed its un-reversed remaining amount.
9. The three amount fields are arithmetic views over the current pricing revision and signed collection facts. They carry no accounting or payment-settlement meaning.
10. A successful command's domain facts, audit event, command state, and Receipt commit in one PostgreSQL transaction.

## Architecture decisions

- A modular TypeScript monolith keeps Web and API on one domain path while preserving package ownership boundaries.
- PostgreSQL day-slot rows and `SELECT ... FOR UPDATE` make room/bed exclusion explicit and testable. Same-room operations briefly serialize; different rooms continue concurrently.
- Opaque credential secrets are generated and retained by the client and hashed before persistence. Neither Preview nor Receipt returns an issue or rotation secret. Immediate database lookup makes expiry, revocation, rotation, subject disablement, and grant narrowing effective on the next request.
- Preview stores normalized input, effect hash, aggregate/inventory/membership basis, subject, property, command type, and expiry. Confirm must repeat the exact `propertyId` and `commandType`, binds to the same subject, locks resources, rebuilds the effect, and rejects any mismatch.
- Idempotency-key recovery is scoped by subject, `propertyId`, and `commandType`; recovery reads never create or update command state.
- A projection or external Base may consume versioned queries but has no core write capability and is never required for readiness.
- Unknown pricing behavior is an error, not a zero, nightly, prorated, or rounded fallback.

## Reversible assumptions awaiting operating facts

- The demo property uses `Asia/Shanghai`, CNY integer minor units, arrival night charged/claimed, and departure date excluded.
- Member nights are held when an order is confirmed and converted from HELD to CONSUMED when CHECK_IN succeeds. Pre-check-in cancellation, no-show, or removed service dates release HELD nights; CHECK_OUT does not consume them again, and ordinary commands never restore CONSUMED nights.
- `expires_on` is the final eligible service date. This boundary will be replaced if real entitlement contracts demonstrate different semantics.
- Confirming no-show releases its future inventory immediately.
- A refund cannot exceed the un-reversed amount of its referenced collection; it never references or allocates to another order.
- A rolling stay is extended only by an explicit amendment; no scheduled renewal is inferred.

These assumptions are isolated behind commands and golden tests. They are not evidence for weekly, monthly, cross-month, proration, or rounding policy.
