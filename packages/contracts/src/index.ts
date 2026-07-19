export const accessLevels = ["READ", "WRITE"] as const;
export type AccessLevel = (typeof accessLevels)[number];

export const inventoryUnitKinds = ["ROOM", "BED"] as const;
export type InventoryUnitKind = (typeof inventoryUnitKinds)[number];
export type EntitlementUnitKind = "ROOM_NIGHT" | "BED_NIGHT";

export const stayTypes = ["TRANSIENT", "WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING", "FREE"] as const;
export type StayType = (typeof stayTypes)[number];

export const bookingChannelCodes = ["YOUMUDAO", "CTRIP", "MEITUAN", "WECOM"] as const;
export type BookingChannelCode = (typeof bookingChannelCodes)[number];

export const commandTypes = [
  "CREATE_MEMBER",
  "CREATE_ORDER",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "LOCK_MAINTENANCE",
  "RELEASE_MAINTENANCE",
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "REVERSE_FACT",
  "CHECK_IN",
  "CHECK_OUT",
  "REFRESH_MEMBER_COVERAGE",
  "ADD_MEMBER_ENTITLEMENT_LOT",
  "ADJUST_MEMBER_ENTITLEMENT",
  "EXPIRE_MEMBER_ENTITLEMENT",
  "ISSUE_TOKEN",
  "ROTATE_TOKEN",
  "REVOKE_TOKEN"
] as const;
export type CommandType = (typeof commandTypes)[number];

export const directCommandTypes = ["CREATE_QUOTE"] as const;
export type DirectCommandType = (typeof directCommandTypes)[number];
export const recoverableCommandTypes = [...directCommandTypes, ...commandTypes] as const;
export type RecoverableCommandType = (typeof recoverableCommandTypes)[number];

export const errorCodes = [
  "AUTHENTICATION_REQUIRED",
  "INVALID_CREDENTIALS",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "SUBJECT_DISABLED",
  "INSUFFICIENT_ACCESS",
  "RESOURCE_SCOPE_DENIED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "CORRELATION_ID_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "PREVIEW_REQUIRED",
  "PREVIEW_NOT_FOUND",
  "PREVIEW_STALE",
  "PREVIEW_ALREADY_USED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_MISMATCH",
  "REASON_REQUIRED",
  "AGGREGATE_VERSION_CONFLICT",
  "INVENTORY_CONFLICT",
  "ENTITLEMENT_CONFLICT",
  "INVALID_ORDER_STATE",
  "CROSS_ORDER_FACT_REFERENCE",
  "FACT_ALREADY_REVERSED",
  "REFUND_LIMIT_EXCEEDED",
  "PRICING_POLICY_UNCONFIGURED",
  "POLICY_VERSION_NOT_FOUND",
  "QUOTE_EXPIRED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "COMMAND_STATUS_UNKNOWN",
  "COMMAND_INTERRUPTED",
  "RATE_LIMITED",
  "SERVICE_NOT_READY",
  "INTERNAL_ERROR"
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export const errorCauseCodes = [...errorCodes, "PREVIEW_EXPIRED"] as const;
export type ErrorCauseCode = (typeof errorCauseCodes)[number];

export interface MoneyDto {
  currency: string;
  minorUnits: number;
}

export interface ReferenceCatalogBatchDto {
  id: string;
  propertyId: string;
  sourceRevision: number;
  sourceVersionDate: string | null;
  contentHash: string;
  executionState: "REFERENCE_ONLY";
  createdAt: string;
}

export interface ReferenceInventoryCatalogEntryDto {
  id: string;
  typeCode: string;
  typeName: string;
  bathroomType: "SHARED" | "ENSUITE";
  sellUnitKind: "ROOM" | "BED";
  physicalRoomCount: number;
  physicalBedCount: number;
  unitsPerRoom: number | null;
  sellableUnitCount: number;
  separateElectricityCharge: false;
  executionState: "REFERENCE_ONLY";
  sourceSheet: string;
  sourceRange: string;
}

export interface ReferencePhysicalRoomDto {
  operationalCode: string;
  buildingCode: string;
  roomTypeKey: string;
  sourceCode: string | null;
  sourceLabel: string;
  codeProvenance: "SOURCE_EXPLICIT" | "USER_CONFIRMED_RENAMED" | "PMS_GENERATED";
  physicalBedCount: number;
  physicalBedCodes: string[] | null;
  saleMode: "INDEPENDENT_ROOM" | "BED_WITH_WHOLE_ROOM_COMBINATION";
}

export interface ReferencePricingRuleDto {
  code: string;
  version: number;
  calculationKind: "DURATION_BAND_TOTAL";
  effectiveFrom: string;
  effectiveUntil: null;
  transientMaximumNightsExclusive: 7;
  bands: Array<{ minimumNights: number; maximumNightsExclusive: number | null; anchorNights: 1 | 7 | 14 | 30 }>;
  rounding: { stage: "FINAL_STAY_TOTAL"; unit: "CNY_YUAN"; mode: "HALF_UP_POSITIVE" };
  shorteningBasis: "FULL_STAY_FROM_ORIGINAL_ARRIVAL";
  extensionBasis: "FULL_STAY_FROM_ORIGINAL_ARRIVAL";
  crossCalendarMonthTreatment: "NO_SPLIT";
  antiInversionRule: "NONE";
  separateElectricityCharge: false;
}

export interface ReferencePricingProductDto {
  productCode: string;
  roomTypeKey: string;
  inventoryUnitKind: InventoryUnitKind;
  anchorMultiplier: 1 | 2 | 4;
  anchorsMinor: { "1": number; "7": number; "14": number; "30": number };
  derivation: "SOURCE_PUBLISHED" | "BED_ANCHORS_TIMES_PHYSICAL_BEDS";
}

export interface ReferenceRateDto {
  id: string;
  inventoryCatalogEntryId: string;
  packageNights: 1 | 7 | 14 | 30;
  packageAmountMinor: number;
  currency: string;
  executionState: "REFERENCE_ONLY";
  sourceSheet: string;
  sourceRange: string;
}

export interface ReferenceMembershipProductDto {
  id: string;
  inventoryCatalogEntryId: string;
  code: string;
  name: string;
  priceMinor: number;
  currency: string;
  salesLimit: number;
  entitlementNights: number;
  validityPeriod: string;
  executionState: "REFERENCE_ONLY";
  terms: {
    entitlementUnit: EntitlementUnitKind;
    quotaMeaning: "MEMBERSHIP_SLOTS_NOT_INVENTORY";
    validityStartsAt: "PAYMENT_DATE";
    membershipRules: {
      bookingRule: string;
      refundPolicy: "NON_REFUNDABLE_MEMBERSHIP";
      refundRule: string;
      overriddenSourceRefundRule: string;
      refundCalculation: null;
      sourceRange: string;
    };
  };
  sourceSheet: string;
  sourceRange: string;
}

export interface ReferenceCatalogDto {
  batch: ReferenceCatalogBatchDto;
  inventoryEntries: ReferenceInventoryCatalogEntryDto[];
  rates: ReferenceRateDto[];
  rooms: ReferencePhysicalRoomDto[];
  pricingRule: ReferencePricingRuleDto;
  pricingProducts: ReferencePricingProductDto[];
  rejectedSourceFigures: Array<{ name: string; value: number; reason: string }>;
  membershipProducts: ReferenceMembershipProductDto[];
  unresolvedIssues: Array<{ code: string; description: string }>;
}

export interface CoverageItemDto {
  serviceDate: string;
  inventoryUnitId: string;
  unitKind: EntitlementUnitKind;
  entitlementLotId: string;
}

export interface NightlyCashLineDto {
  lineKind?: "NIGHT";
  serviceDate: string;
  inventoryUnitId: string;
  description: string;
  amount: MoneyDto;
}

export interface StayTotalCashLineDto {
  lineKind: "STAY_TOTAL";
  arrivalDate: string;
  departureDate: string;
  inventoryUnitId: string;
  description: string;
  pricingBandAnchorNights: 1 | 7 | 14 | 30;
  calculationSegments: Array<{
    inventoryUnitId: string;
    pricingProductCode: string;
    arrivalDate: string;
    departureDate: string;
    nights: number;
    anchorAmountMinor: number;
    numeratorMinor: number;
    denominator: number;
  }>;
  amount: MoneyDto;
}

export type CashLineDto = NightlyCashLineDto | StayTotalCashLineDto;

export interface QuoteDto {
  quoteId: string;
  propertyId: string;
  inventoryUnitId: string;
  stayType: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  coverageSet: CoverageItemDto[];
  cashLines: CashLineDto[];
  cashRemainder: MoneyDto;
  currentContractAmount: MoneyDto;
  expiresAt: string;
}

export interface CreateQuoteCommandInputDto {
  propertyId: string;
  inventoryUnitId: string;
  stayType: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberContractId?: string;
}

export interface StoredQuoteDto extends QuoteDto {
  memberContractId?: string;
  inputHash: string;
}

export interface AmountSummaryDto {
  currentContractAmount: MoneyDto;
  netRecordedCollection: MoneyDto;
  collectionDifference: MoneyDto;
}

export interface CommandReason {
  code: string;
  note: string;
}

export interface PreviewDto {
  previewId: string;
  commandType: CommandType;
  effectHash: string;
  effect: Record<string, unknown>;
  expiresAt: string;
}

export interface ReceiptDto {
  receiptId: string;
  commandId: string;
  executionStatus: "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN";
  businessCommitted: boolean;
  correlationId: string;
  result?: Record<string, unknown>;
  error?: ErrorDto;
  resourceRefs: string[];
  factRefs: string[];
  committedAt?: string;
}

export interface CreateQuoteCommandResponseDto {
  quote: StoredQuoteDto;
  receipt: ReceiptDto;
}

export interface ErrorDto {
  code: ErrorCode;
  message: string;
  correlationId: string;
  retryable: boolean;
  commandId?: string;
  receiptId?: string;
  details?: Record<string, unknown>;
}

export interface AuthPrincipal {
  subjectId: string;
  credentialId: string;
  credentialType: "SESSION" | "TOKEN";
  displayName: string;
  propertyAccess: Map<string, AccessLevel>;
}

export interface CommandEnvelope {
  commandType: CommandType;
  input: Record<string, unknown>;
}

export interface CreateMemberInput {
  propertyId: string;
  fullName: string;
  identityCardNumber: string;
  phone: string;
  wechat: string;
  validFrom?: string;
  validUntil?: string;
  memberContractId?: string;
  sourceApplicationRecordId?: string;
}

export interface CreateMemberResultDto {
  memberId: string;
  memberContractId: string | null;
  memberCreated: boolean;
  memberContractCreated: boolean;
  memberExternalReferenceId: string | null;
  externalReferenceCreated: boolean;
}

export interface ExpireMemberEntitlementInput {
  propertyId: string;
  entitlementLotId: string;
  asOfDate: string;
}

export interface ExpireMemberEntitlementResultDto {
  entitlementLotId: string;
  contractId: string;
  factId: string;
  entryType: "EXPIRE";
  expiredUnits: number;
  remainingAvailable: 0;
  asOfDate: string;
}

export interface TokenIssueResultDto {
  tokenId: string;
  subjectId: string;
  accessCeiling: AccessLevel;
  expiresAt: string;
}

export interface TokenRotationResultDto extends TokenIssueResultDto {
  rotatedFromTokenId: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, statusCode = 400, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}
