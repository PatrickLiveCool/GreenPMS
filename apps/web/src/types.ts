import type {
  AmountSummaryDto,
  CommandType,
  CreateQuoteCommandResponseDto,
  PreviewDto,
  QuoteDto,
  ReceiptDto,
  RecoverableCommandType,
  StayType
} from "@qintopia/contracts";

export interface PrincipalDto {
  subjectId: string;
  displayName: string;
  credentialType: "SESSION" | "TOKEN";
  propertyAccess: Record<string, "READ" | "WRITE">;
}

export interface ClientCommandMetadata {
  idempotencyKey: string;
  correlationId: string;
}

export type TrackedCommandState =
  | "LOCAL_ONLY"
  | "PREVIEWING"
  | "PREVIEW_UNKNOWN"
  | "PREVIEWED"
  | "CONFIRMING"
  | "UNKNOWN"
  | "EXECUTED"
  | "NOT_EXECUTED";

export interface PendingTokenCommand {
  operationId: string;
  request: CommandRequest;
  state: TrackedCommandState;
  previewMetadata?: ClientCommandMetadata;
  previewId?: string;
  confirmationKey?: string;
}

export interface RetainedTokenSecret {
  operationId: string;
  propertyId: string;
  operation: "ISSUE" | "ROTATE";
  label: string;
  value: string;
  command: CommandRequest;
  state: TrackedCommandState;
  previewMetadata?: ClientCommandMetadata;
  previewId?: string;
  confirmationKey?: string;
}

export interface TokenDto {
  id: string;
  label: string;
  access_ceiling: "READ" | "WRITE";
  property_scope: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from_id: string | null;
  replaced_by_id: string | null;
  created_at: string;
}

export interface PropertyDto {
  id: string;
  code: string;
  name: string;
  timezone: string;
  currency: string;
}

export interface InventoryUnitDto {
  id: string;
  property_id: string;
  kind: "ROOM" | "BED";
  parent_room_id: string | null;
  code: string;
  name: string;
  active: boolean;
}

export interface PricingPolicyVersionDto {
  id: string;
  property_id: string;
  code: string;
  version: number;
  stay_type: StayType;
  calculation_kind: "FLAT_NIGHTLY" | "FREE";
  nightly_rate_minor: number;
  currency: string;
  status: "PUBLISHED";
}

export interface MemberContractDto {
  id: string;
  property_id: string;
  member_name: string;
  status: "ACTIVE" | "EXPIRED";
  valid_from: string;
  valid_until: string;
  version: number;
  created_at: string;
}

export interface EntitlementLotDto {
  id: string;
  contract_id: string;
  unit_kind: "ROOM_NIGHT" | "BED_NIGHT";
  total_units: number;
  expires_on: string;
  version: number;
  created_at: string;
}

export interface EntitlementLedgerDto {
  fact_id: string;
  lot_id: string;
  entry_type: "ADJUST" | "HOLD" | "RELEASE" | "CONSUME" | "EXPIRE";
  quantity_delta: number;
  service_date: string | null;
  order_id: string | null;
  coverage_id: string | null;
  reason: string;
  command_id: string | null;
  created_at: string;
}

export interface MemberViewDto {
  contract: MemberContractDto;
  lots: EntitlementLotDto[];
  ledger: EntitlementLedgerDto[];
}

export interface MetaDto {
  properties: PropertyDto[];
  inventoryUnits: InventoryUnitDto[];
  pricingPolicyVersions: PricingPolicyVersionDto[];
  memberContracts: MemberContractDto[];
}

export interface AvailabilityNightDto {
  serviceDate: string;
  available: boolean;
  blockingClaimIds: string[];
}

export interface UnitAvailabilityDto {
  id: string;
  propertyId: string;
  kind: "ROOM" | "BED";
  roomId: string;
  code: string;
  name: string;
  nights: AvailabilityNightDto[];
  available: boolean;
}

export interface AvailabilityDto {
  propertyId: string;
  units: UnitAvailabilityDto[];
}

export interface MaintenanceLockDto {
  id: string;
  property_id: string;
  inventory_unit_id: string;
  arrival_date: string;
  departure_date: string;
  reason: string;
  status: "ACTIVE" | "RELEASED";
  version: number;
  created_at: string;
  released_at: string | null;
}

export interface OrderRowDto {
  id: string;
  property_id: string;
  status: string;
  stay_type: StayType;
  arrival_date: string;
  departure_date: string;
  primary_guest_snapshot: Record<string, unknown>;
  pricing_policy_version_id: string;
  member_contract_id: string | null;
  current_revision_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface StaySegmentDto {
  id: string;
  stay_id: string;
  sequence: number;
  inventory_unit_id: string;
  arrival_date: string;
  departure_date: string;
  segment_type: string;
  supersedes_segment_id: string | null;
  amendment_id: string;
  created_at: string;
}

export interface AmendmentDto {
  id: string;
  order_id: string;
  sequence: number;
  amendment_type: string;
  reason_code: string;
  reason_note: string;
  prior_version: number;
  new_version: number;
  payload: unknown;
  created_at: string;
}

export interface PricingRevisionDto {
  id: string;
  order_id: string;
  revision_no: number;
  amendment_id: string;
  policy_version_id: string;
  arrival_date: string;
  departure_date: string;
  coverage_set: unknown;
  cash_lines: unknown;
  manual_adjustment_minor: number;
  current_contract_amount_minor: number;
  currency: string;
  created_at: string;
}

export interface CoverageRowDto {
  id: string;
  order_id: string;
  contract_id: string;
  lot_id: string;
  inventory_unit_id: string;
  service_date: string;
  unit_kind: string;
  status: "HELD" | "CONSUMED" | "RELEASED";
  held_by_revision_id: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionFactDto {
  fact_id: string;
  order_id: string;
  fact_type: "COLLECTION" | "REFUND" | "REVERSAL";
  amount_minor: number;
  net_effect_minor: number;
  currency: string;
  references_fact_id: string | null;
  reverses_fact_id: string | null;
  method: string;
  note: string;
  command_id: string;
  created_at: string;
}

export interface OrderViewDto {
  order: OrderRowDto;
  stay: { id: string; status: string };
  currentSegment: {
    id: string;
    sequence: number;
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
  };
  segments: StaySegmentDto[];
  amendments: AmendmentDto[];
  pricingRevisions: PricingRevisionDto[];
  coverageSet: CoverageRowDto[];
  collectionFacts: CollectionFactDto[];
  amounts: AmountSummaryDto;
}

export interface CommandPreviewResponse {
  preview: PreviewDto;
  receipt: ReceiptDto;
}

export interface CommandRequest {
  commandType: CommandType;
  input: Record<string, unknown>;
  title: string;
  description: string;
}

export type {
  AmountSummaryDto,
  CommandType,
  CreateQuoteCommandResponseDto,
  PreviewDto,
  QuoteDto,
  ReceiptDto,
  RecoverableCommandType,
  StayType
};
