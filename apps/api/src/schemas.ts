import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import { commandTypes, errorCodes, recoverableCommandTypes, stayTypes, type CommandType } from "@qintopia/contracts";

const strictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const commandEnvelope = <C extends CommandType, T extends TProperties>(commandType: C, input: TObject<T>) => strictObject({
  commandType: Type.Literal(commandType),
  input
});

export const Id = Type.String({ minLength: 3, maxLength: 160 });
export const LocalDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
export const DateTime = Type.String({ format: "date-time" });
const OpaqueTokenSecret = Type.String({ minLength: 47, maxLength: 47, pattern: "^qtp_[A-Za-z0-9_-]{43}$" });
const ShortText = Type.String({ minLength: 1, maxLength: 200 });
const Note = Type.String({ minLength: 1, maxLength: 1000 });
const OptionalNote = Type.String({ maxLength: 1000 });
const SafeInteger = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const PositiveAmount = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NonZeroInteger = Type.Union([
  Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: -1 }),
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
]);

export const AccessLevelSchema = Type.Union([Type.Literal("READ"), Type.Literal("WRITE")]);
export const InventoryUnitKindSchema = Type.Union([Type.Literal("ROOM"), Type.Literal("BED")]);
export const EntitlementUnitKindSchema = Type.Union([Type.Literal("ROOM_NIGHT"), Type.Literal("BED_NIGHT")]);
export const StayTypeSchema = Type.Union(stayTypes.map((stayType) => Type.Literal(stayType)));
export const CommandTypeSchema = Type.Union(commandTypes.map((commandType) => Type.Literal(commandType)));
export const RecoverableCommandTypeSchema = Type.Union(recoverableCommandTypes.map((commandType) => Type.Literal(commandType)));
export const OrderStatusSchema = Type.Union([
  Type.Literal("RESERVED"), Type.Literal("CHECKED_IN"), Type.Literal("CHECKED_OUT"),
  Type.Literal("CANCELLED"), Type.Literal("NO_SHOW")
]);

export const Money = strictObject({
  currency: Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" }),
  minorUnits: SafeInteger
});
export const CoverageItem = strictObject({
  serviceDate: LocalDate,
  inventoryUnitId: Id,
  unitKind: EntitlementUnitKindSchema,
  entitlementLotId: Id
});
export const CashLine = strictObject({
  serviceDate: LocalDate,
  inventoryUnitId: Id,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  amount: Money
});
export const AmountSummarySchema = strictObject({
  currentContractAmount: Money,
  netRecordedCollection: Money,
  collectionDifference: Money
});
export const CommandReasonSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 80 }),
  note: Note
});

const ErrorDetailsSchema = Type.Union([
  strictObject({ serviceDate: LocalDate, claimId: Id }),
  strictObject({ causeCode: Type.Union(errorCodes.map((code) => Type.Literal(code))) }),
  strictObject({ expiresOn: LocalDate, asOfDate: LocalDate }),
  strictObject({ remainingAvailable: SafeInteger }),
  strictObject({ expirationFactId: Id }),
  strictObject({ reversalFactId: Id }),
  strictObject({ activeRefunded: SafeInteger }),
  strictObject({ commandId: Id }),
  strictObject({ activeQuoteCount: Type.String({ pattern: "^\\d+$" }), limit: Type.Integer({ minimum: 1 }) }),
  strictObject({
    availableBalance: Type.String({ pattern: "^-?\\d+$" }),
    minimum: Type.Literal("0"),
    maximum: Type.Literal("2147483647")
  }),
  strictObject({ orderId: Id, serviceDate: LocalDate, coverageId: Id }),
  strictObject({ orderId: Id, serviceDate: LocalDate, activeClaimIds: Type.Array(Id) })
]);

export const ErrorResponse = strictObject({
  code: Type.Union(errorCodes.map((code) => Type.Literal(code))),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  correlationId: Type.String({ minLength: 1, maxLength: 160 }),
  retryable: Type.Boolean(),
  commandId: Type.Optional(Id),
  receiptId: Type.Optional(Id),
  details: Type.Optional(ErrorDetailsSchema)
});

export const WriteHeaders = Type.Object({
  "idempotency-key": Type.String({ minLength: 1, maxLength: 160 }),
  "x-correlation-id": Type.String({ minLength: 1, maxLength: 160 })
}, { additionalProperties: true });

const PrimaryGuestSchema = strictObject({
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  phone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
});
const PropertyInput = { propertyId: Id };
const OrderInput = { ...PropertyInput, orderId: Id };

export const CommandEnvelopeSchema = Type.Union([
  commandEnvelope("CREATE_ORDER", strictObject({ ...PropertyInput, quoteId: Id, primaryGuest: PrimaryGuestSchema })),
  commandEnvelope("EXTEND_STAY", strictObject({ ...OrderInput, newDepartureDate: LocalDate, manualAdjustmentMinor: Type.Optional(SafeInteger) })),
  commandEnvelope("SHORTEN_STAY", strictObject({ ...OrderInput, newDepartureDate: LocalDate, manualAdjustmentMinor: Type.Optional(SafeInteger) })),
  commandEnvelope("MOVE_UNIT", strictObject({ ...OrderInput, newInventoryUnitId: Id, effectiveDate: LocalDate, manualAdjustmentMinor: Type.Optional(SafeInteger) })),
  commandEnvelope("REPRICE_ORDER", strictObject({ ...OrderInput, manualAdjustmentMinor: SafeInteger })),
  commandEnvelope("CANCEL_ORDER", strictObject(OrderInput)),
  commandEnvelope("MARK_NO_SHOW", strictObject(OrderInput)),
  commandEnvelope("LOCK_MAINTENANCE", strictObject({ ...PropertyInput, inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate, reason: Note })),
  commandEnvelope("RELEASE_MAINTENANCE", strictObject({ ...PropertyInput, maintenanceLockId: Id })),
  commandEnvelope("RECORD_COLLECTION", strictObject({ ...OrderInput, amountMinor: PositiveAmount, method: ShortText, note: Type.Optional(OptionalNote) })),
  commandEnvelope("RECORD_REFUND", strictObject({ ...OrderInput, amountMinor: PositiveAmount, referencesFactId: Id, method: ShortText, note: Type.Optional(OptionalNote) })),
  commandEnvelope("REVERSE_FACT", strictObject({ ...OrderInput, reversesFactId: Id, note: Note })),
  commandEnvelope("CHECK_IN", strictObject(OrderInput)),
  commandEnvelope("CHECK_OUT", strictObject(OrderInput)),
  commandEnvelope("ADJUST_MEMBER_ENTITLEMENT", strictObject({ ...PropertyInput, entitlementLotId: Id, quantityDelta: NonZeroInteger, adjustmentReason: Note })),
  commandEnvelope("EXPIRE_MEMBER_ENTITLEMENT", strictObject({ ...PropertyInput, entitlementLotId: Id, asOfDate: LocalDate })),
  commandEnvelope("ISSUE_TOKEN", strictObject({
    ...PropertyInput,
    subjectId: Id,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    accessCeiling: AccessLevelSchema,
    expiresAt: DateTime,
    tokenSecret: OpaqueTokenSecret
  })),
  commandEnvelope("ROTATE_TOKEN", strictObject({
    ...PropertyInput,
    tokenId: Id,
    expiresAt: Type.Optional(DateTime),
    tokenSecret: OpaqueTokenSecret
  })),
  commandEnvelope("REVOKE_TOKEN", strictObject({ ...PropertyInput, tokenId: Id }))
]);

export const ConfirmSchema = strictObject({
  propertyId: Id,
  commandType: CommandTypeSchema,
  confirmation: Type.Literal(true),
  expectedEffectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  reason: CommandReasonSchema
});

const InventoryUnitRecordSchema = strictObject({
  id: Id,
  propertyId: Id,
  kind: InventoryUnitKindSchema,
  roomId: Id,
  code: Type.String({ minLength: 1, maxLength: 120 }),
  name: Type.String({ minLength: 1, maxLength: 240 })
});
const PricingResultSchema = strictObject({
  coverageSet: Type.Array(CoverageItem),
  cashLines: Type.Array(CashLine),
  cashRemainder: Money,
  currentContractAmount: Money
});
export const QuoteSchema = strictObject({
  quoteId: Id,
  propertyId: Id,
  inventoryUnitId: Id,
  stayType: StayTypeSchema,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  pricingPolicyVersionId: Id,
  coverageSet: Type.Array(CoverageItem),
  cashLines: Type.Array(CashLine),
  cashRemainder: Money,
  currentContractAmount: Money,
  expiresAt: DateTime,
  memberContractId: Type.Optional(Id),
  inputHash: Type.String({ minLength: 64, maxLength: 64 })
});

export const QuoteRequestSchema = strictObject({
  propertyId: Id,
  inventoryUnitId: Id,
  stayType: StayTypeSchema,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  pricingPolicyVersionId: Id,
  memberContractId: Type.Optional(Id)
});
const StayTimelineItemSchema = strictObject({ serviceDate: LocalDate, inventoryUnitId: Id });
const StayTimelineSchema = Type.Array(StayTimelineItemSchema, { minItems: 1 });

export const CommandEffectSchema = Type.Union([
  strictObject({
    quoteId: Id,
    primaryGuest: PrimaryGuestSchema,
    inventoryUnit: InventoryUnitRecordSchema,
    stayType: StayTypeSchema,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    pricingPolicyVersionId: Id,
    memberContractId: nullable(Id),
    pricing: PricingResultSchema
  }),
  strictObject({ inventoryUnit: InventoryUnitRecordSchema, arrivalDate: LocalDate, departureDate: LocalDate, reason: Note }),
  strictObject({ maintenanceLockId: Id, inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate }),
  strictObject({
    entitlementLotId: Id,
    contractId: Id,
    unitKind: EntitlementUnitKindSchema,
    quantityDelta: NonZeroInteger,
    adjustmentReason: Note,
    availableBefore: SafeInteger,
    availableAfter: SafeInteger
  }),
  strictObject({
    entitlementLotId: Id, contractId: Id, unitKind: EntitlementUnitKindSchema, expiresOn: LocalDate,
    asOfDate: LocalDate, remainingAvailable: Type.Integer({ minimum: 0 }), quantityDelta: Type.Integer({ maximum: 0 }), entryType: Type.Literal("EXPIRE")
  }),
  strictObject({ subjectId: Id, label: ShortText, accessCeiling: AccessLevelSchema, expiresAt: DateTime }),
  strictObject({
    tokenId: Id, subjectId: Id, label: ShortText, accessCeiling: AccessLevelSchema, expiresAt: DateTime,
    operation: Type.Union([Type.Literal("ROTATE"), Type.Literal("REVOKE")])
  }),
  strictObject({
    orderId: Id,
    inventoryUnitId: Id,
    before: strictObject({ departureDate: LocalDate, currentContractAmount: Money }),
    after: strictObject({
      departureDate: LocalDate,
      nights: Type.Optional(Type.Integer({ minimum: 1 })),
      stayTimeline: StayTimelineSchema,
      pricing: PricingResultSchema
    })
  }),
  strictObject({
    orderId: Id,
    fromInventoryUnit: InventoryUnitRecordSchema,
    toInventoryUnit: InventoryUnitRecordSchema,
    effectiveDate: LocalDate,
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  strictObject({
    orderId: Id,
    inventoryUnitId: Id,
    stayTimeline: StayTimelineSchema,
    before: strictObject({ currentContractAmount: Money }),
    pricing: PricingResultSchema,
    manualAdjustmentMinor: SafeInteger
  }),
  strictObject({ orderId: Id, amountMinor: PositiveAmount, currency: Type.String({ minLength: 3, maxLength: 3 }), method: ShortText, note: OptionalNote }),
  strictObject({ orderId: Id, amountMinor: PositiveAmount, currency: Type.String({ minLength: 3, maxLength: 3 }), referencesFactId: Id, method: ShortText, note: OptionalNote }),
  strictObject({ orderId: Id, reversesFactId: Id, amountMinor: PositiveAmount, netEffectMinor: SafeInteger, currency: Type.String({ minLength: 3, maxLength: 3 }), note: Note }),
  strictObject({
    orderId: Id,
    fromStatus: OrderStatusSchema,
    toStatus: OrderStatusSchema,
    inventoryUnitId: Id,
    amounts: Type.Optional(AmountSummarySchema)
  })
]);

export const PreviewSchema = strictObject({
  previewId: Id,
  commandType: CommandTypeSchema,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: CommandEffectSchema,
  expiresAt: DateTime
});

const CreateOrderResultSchema = strictObject({ orderId: Id, stayId: Id, segmentId: Id, pricingRevisionId: Id });
const MaintenanceLockResultSchema = strictObject({ maintenanceLockId: Id });
const MaintenanceReleaseResultSchema = strictObject({ maintenanceLockId: Id, status: Type.Literal("RELEASED") });
const EntitlementAdjustmentResultSchema = strictObject({ entitlementLotId: Id, adjustmentFactId: Id });
const EntitlementExpirationResultSchema = strictObject({
  entitlementLotId: Id,
  contractId: Id,
  factId: Id,
  entryType: Type.Literal("EXPIRE"),
  expiredUnits: Type.Integer({ minimum: 0 }),
  remainingAvailable: Type.Literal(0),
  asOfDate: LocalDate
});
const TokenIssueResultSchema = strictObject({
  tokenId: Id,
  subjectId: Id,
  accessCeiling: AccessLevelSchema,
  expiresAt: DateTime
});
const TokenRotationResultSchema = strictObject({
  tokenId: Id,
  rotatedFromTokenId: Id,
  subjectId: Id,
  accessCeiling: AccessLevelSchema,
  expiresAt: DateTime
});
const TokenRevocationResultSchema = strictObject({ tokenId: Id, revoked: Type.Literal(true) });
const StayChangeResultSchema = strictObject({ orderId: Id, amendmentId: Id, staySegmentId: Id, pricingRevisionId: Id });
const RepriceResultSchema = strictObject({ orderId: Id, amendmentId: Id, pricingRevisionId: Id });
const CollectionFactResultSchema = strictObject({
  orderId: Id,
  factId: Id,
  factType: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  netEffectMinor: SafeInteger
});
const OrderStatusResultSchema = strictObject({ orderId: Id, amendmentId: Id, status: OrderStatusSchema });
const PreviewReceiptResultSchema = strictObject({ preview: PreviewSchema });
const QuoteReceiptResultSchema = strictObject({ quote: QuoteSchema });

export const ExecutedCommandResultSchema = Type.Union([
  QuoteReceiptResultSchema,
  CreateOrderResultSchema,
  MaintenanceLockResultSchema,
  MaintenanceReleaseResultSchema,
  EntitlementAdjustmentResultSchema,
  EntitlementExpirationResultSchema,
  TokenIssueResultSchema,
  TokenRotationResultSchema,
  TokenRevocationResultSchema,
  StayChangeResultSchema,
  RepriceResultSchema,
  CollectionFactResultSchema,
  OrderStatusResultSchema,
  PreviewReceiptResultSchema
]);

export const ReceiptSchema = strictObject({
  receiptId: Id,
  commandId: Id,
  executionStatus: Type.Union([Type.Literal("EXECUTED"), Type.Literal("NOT_EXECUTED"), Type.Literal("UNKNOWN")]),
  businessCommitted: Type.Boolean(),
  correlationId: Type.String({ minLength: 1, maxLength: 160 }),
  result: Type.Optional(ExecutedCommandResultSchema),
  error: Type.Optional(ErrorResponse),
  resourceRefs: Type.Array(Id),
  factRefs: Type.Array(Id),
  committedAt: Type.Optional(DateTime)
});

export const QuoteCommandResponseSchema = strictObject({
  quote: QuoteSchema,
  receipt: ReceiptSchema
});

export const CommandResultRecoverySchema = Type.Union([
  ReceiptSchema,
  strictObject({ executionStatus: Type.Literal("NOT_EXECUTED"), businessCommitted: Type.Literal(false) }),
  strictObject({
    executionStatus: Type.Literal("UNKNOWN"),
    businessCommitted: Type.Literal(false),
    commandId: Type.Optional(Id),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 }))
  })
]);

export const AvailabilityUnitSchema = strictObject({
  id: Id,
  propertyId: Id,
  kind: InventoryUnitKindSchema,
  roomId: Id,
  code: Type.String({ minLength: 1, maxLength: 120 }),
  name: Type.String({ minLength: 1, maxLength: 240 }),
  nights: Type.Array(strictObject({ serviceDate: LocalDate, available: Type.Boolean(), blockingClaimIds: Type.Array(Id) })),
  available: Type.Boolean()
});

export const LoginSchema = strictObject({
  username: Type.String({ minLength: 1, maxLength: 120 }),
  password: Type.String({ minLength: 1, maxLength: 200 })
});
export const LoginResponseSchema = strictObject({ subjectId: Id, displayName: ShortText, expiresAt: DateTime });
export const MeResponseSchema = strictObject({
  subjectId: Id,
  displayName: ShortText,
  credentialType: Type.Union([Type.Literal("SESSION"), Type.Literal("TOKEN")]),
  propertyAccess: Type.Record(Type.String({ minLength: 3, maxLength: 160 }), AccessLevelSchema)
});

const PropertyRowSchema = strictObject({
  id: Id, code: ShortText, name: ShortText, timezone: ShortText,
  currency: Type.String({ minLength: 3, maxLength: 3 }), created_at: DateTime
});
const InventoryUnitRowSchema = strictObject({
  id: Id, property_id: Id, kind: InventoryUnitKindSchema, parent_room_id: nullable(Id), code: ShortText,
  name: ShortText, active: Type.Boolean(), created_at: DateTime
});
const PricingPolicyRowSchema = strictObject({
  id: Id, property_id: Id, code: ShortText, version: Type.Integer({ minimum: 1 }), stay_type: StayTypeSchema,
  calculation_kind: Type.Union([Type.Literal("FLAT_NIGHTLY"), Type.Literal("FREE")]),
  nightly_rate_minor: Type.Integer({ minimum: 0 }), currency: Type.String({ minLength: 3, maxLength: 3 }),
  status: Type.Literal("PUBLISHED"), created_at: DateTime
});
const MemberContractRowSchema = strictObject({
  id: Id, property_id: Id, member_name: ShortText,
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("EXPIRED")]),
  valid_from: LocalDate, valid_until: LocalDate, version: Type.Integer({ minimum: 1 }), created_at: DateTime
});

export const MetaResponseSchema = strictObject({
  properties: Type.Array(PropertyRowSchema),
  inventoryUnits: Type.Array(InventoryUnitRowSchema),
  pricingPolicyVersions: Type.Array(PricingPolicyRowSchema),
  memberContracts: Type.Array(MemberContractRowSchema)
});

export const OrderRowSchema = strictObject({
  id: Id,
  property_id: Id,
  status: OrderStatusSchema,
  stay_type: StayTypeSchema,
  arrival_date: LocalDate,
  departure_date: LocalDate,
  primary_guest_snapshot: PrimaryGuestSchema,
  pricing_policy_version_id: Id,
  member_contract_id: nullable(Id),
  current_revision_id: nullable(Id),
  version: Type.Integer({ minimum: 1 }),
  created_at: DateTime,
  updated_at: DateTime
});
export const OrdersListResponseSchema = strictObject({ orders: Type.Array(OrderRowSchema) });

const StaySegmentRowSchema = strictObject({
  id: Id, stay_id: Id, sequence: Type.Integer({ minimum: 1 }), inventory_unit_id: Id,
  arrival_date: LocalDate, departure_date: LocalDate, segment_type: ShortText,
  supersedes_segment_id: nullable(Id), amendment_id: Id, created_at: DateTime
});
const CreateOrderAmendmentPayloadSchema = strictObject({ quoteId: Id, inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate });
const AmendmentRowSchema = strictObject({
  id: Id, order_id: Id, sequence: Type.Integer({ minimum: 1 }), amendment_type: CommandTypeSchema,
  reason_code: Type.String({ minLength: 1, maxLength: 80 }), reason_note: Note,
  prior_version: Type.Integer({ minimum: 0 }), new_version: Type.Integer({ minimum: 1 }),
  payload: Type.Union([CreateOrderAmendmentPayloadSchema, CommandEffectSchema]), created_at: DateTime
});
const PricingRevisionRowSchema = strictObject({
  id: Id, order_id: Id, revision_no: Type.Integer({ minimum: 1 }), amendment_id: Id, policy_version_id: Id,
  arrival_date: LocalDate, departure_date: LocalDate, coverage_set: Type.Array(CoverageItem), cash_lines: Type.Array(CashLine),
  manual_adjustment_minor: SafeInteger, current_contract_amount_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }), created_at: DateTime
});
const CoverageRowSchema = strictObject({
  id: Id, order_id: Id, contract_id: Id, lot_id: Id, inventory_unit_id: Id, service_date: LocalDate,
  unit_kind: EntitlementUnitKindSchema,
  status: Type.Union([Type.Literal("HELD"), Type.Literal("CONSUMED"), Type.Literal("RELEASED")]),
  held_by_revision_id: Id, created_at: DateTime, updated_at: DateTime
});
export const CollectionFactRowSchema = strictObject({
  fact_id: Id, order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount, net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }), references_fact_id: nullable(Id), reverses_fact_id: nullable(Id),
  method: ShortText, note: OptionalNote, command_id: Id, created_at: DateTime
});

export const OrderDetailResponseSchema = strictObject({
  order: OrderRowSchema,
  stay: strictObject({ id: Id, status: Type.Union([
    Type.Literal("PLANNED"), Type.Literal("IN_HOUSE"), Type.Literal("COMPLETED"),
    Type.Literal("CANCELLED"), Type.Literal("NO_SHOW")
  ]) }),
  currentSegment: strictObject({ id: Id, sequence: Type.Integer({ minimum: 1 }), inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate }),
  segments: Type.Array(StaySegmentRowSchema),
  amendments: Type.Array(AmendmentRowSchema),
  pricingRevisions: Type.Array(PricingRevisionRowSchema),
  coverageSet: Type.Array(CoverageRowSchema),
  collectionFacts: Type.Array(CollectionFactRowSchema),
  amounts: AmountSummarySchema
});

const EntitlementLotRowSchema = strictObject({
  id: Id, contract_id: Id, unit_kind: EntitlementUnitKindSchema, total_units: Type.Integer({ minimum: 0 }),
  expires_on: LocalDate, version: Type.Integer({ minimum: 1 }), created_at: DateTime
});
export const EntitlementLedgerRowSchema = strictObject({
  fact_id: Id, lot_id: Id,
  entry_type: Type.Union([Type.Literal("ADJUST"), Type.Literal("HOLD"), Type.Literal("RELEASE"), Type.Literal("CONSUME"), Type.Literal("EXPIRE")]),
  quantity_delta: SafeInteger, service_date: nullable(LocalDate), order_id: nullable(Id), coverage_id: nullable(Id),
  reason: Type.String({ minLength: 1, maxLength: 1000 }), command_id: nullable(Id), created_at: DateTime
});
export const MemberResponseSchema = strictObject({
  contract: MemberContractRowSchema,
  lots: Type.Array(EntitlementLotRowSchema),
  ledger: Type.Array(EntitlementLedgerRowSchema)
});

const CollectionFactResponseSchema = strictObject({
  fact_id: Id, order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount, net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }), references_fact_id: nullable(Id), reverses_fact_id: nullable(Id),
  method: ShortText, note: OptionalNote, created_at: DateTime, property_id: Id
});
const EntitlementFactResponseSchema = strictObject({ ...EntitlementLedgerRowSchema.properties, property_id: Id });
export const FactResponseSchema = Type.Union([CollectionFactResponseSchema, EntitlementFactResponseSchema]);

const TokenRowSchema = strictObject({
  id: Id, label: ShortText, access_ceiling: AccessLevelSchema, property_scope: Id, expires_at: DateTime,
  revoked_at: nullable(DateTime), rotated_from_id: nullable(Id), replaced_by_id: nullable(Id), created_at: DateTime
});
export const TokensResponseSchema = strictObject({ tokens: Type.Array(TokenRowSchema) });

export const MaintenanceLockStatusSchema = Type.Union([Type.Literal("ACTIVE"), Type.Literal("RELEASED")]);
export const MaintenanceLocksQuerySchema = strictObject({
  propertyId: Id,
  status: Type.Optional(MaintenanceLockStatusSchema)
});
export const MaintenanceLockRowSchema = strictObject({
  id: Id,
  property_id: Id,
  inventory_unit_id: Id,
  arrival_date: LocalDate,
  departure_date: LocalDate,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  status: MaintenanceLockStatusSchema,
  version: Type.Integer({ minimum: 1 }),
  created_at: DateTime,
  released_at: nullable(DateTime)
});
export const MaintenanceLocksResponseSchema = strictObject({
  maintenanceLocks: Type.Array(MaintenanceLockRowSchema)
});

const AuditMetadataSchema = Type.Union([
  strictObject({ effectHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ previewId: Id, effectHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ quoteInputHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ errorCode: Type.Union(errorCodes.map((code) => Type.Literal(code))) })
]);
export const AuditResponseSchema = strictObject({
  entries: Type.Array(strictObject({
    id: Id, subject_id: Id, credential_id: Id, action: Type.String({ minLength: 1, maxLength: 200 }),
    decision: Type.Union([Type.Literal("ALLOWED"), Type.Literal("DENIED")]), command_id: nullable(Id),
    correlation_id: Type.String({ minLength: 1, maxLength: 160 }), reason: nullable(CommandReasonSchema),
    target_refs: Type.Array(Id), metadata: AuditMetadataSchema, created_at: DateTime
  }))
});

export const StoredPreviewResponseSchema = strictObject({
  id: Id,
  property_id: Id,
  command_type: CommandTypeSchema,
  input_hash: Type.String({ minLength: 64, maxLength: 64 }),
  effect: CommandEffectSchema,
  effect_hash: Type.String({ minLength: 64, maxLength: 64 }),
  expires_at: DateTime,
  status: Type.Union([Type.Literal("OPEN"), Type.Literal("USED"), Type.Literal("EXPIRED")]),
  created_at: DateTime,
  used_at: nullable(DateTime)
});

export const IdParams = strictObject({ id: Id });
export const PreviewParams = strictObject({ previewId: Id });
