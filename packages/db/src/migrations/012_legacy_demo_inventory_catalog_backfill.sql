ALTER TABLE inventory_units DISABLE TRIGGER inventory_units_protect_identity;

UPDATE inventory_units AS unit
SET catalog_version = target.catalog_version,
    building_code = target.building_code,
    room_type_code = target.room_type_code,
    pricing_product_code = target.pricing_product_code,
    inventory_basis = target.inventory_basis,
    code_provenance = target.code_provenance,
    physical_bed_count = target.physical_bed_count
FROM (
  VALUES
    (
      'unit_room_101', 'ROOM', NULL, '101', 'Room 101',
      'qintopia-2026-feishu-revision-561-user-confirmed-v3', '1', 'shared_bath_quad',
      'shared_bath_quad_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 4
    ),
    (
      'unit_room_102', 'ROOM', NULL, '102', 'Room 102',
      'qintopia-2026-feishu-revision-561-user-confirmed-v3', '1', 'shared_bath_quad',
      'shared_bath_quad_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 4
    ),
    (
      'unit_room_101_bed_a', 'BED', 'unit_room_101', '101-A', 'Room 101 / Bed A',
      'qintopia-2026-feishu-revision-561-user-confirmed-v3', '1', 'shared_bath_quad',
      'shared_bath_quad_bed', 'INDEPENDENT', 'SOURCE_EXPLICIT', NULL
    ),
    (
      'unit_room_101_bed_b', 'BED', 'unit_room_101', '101-B', 'Room 101 / Bed B',
      'qintopia-2026-feishu-revision-561-user-confirmed-v3', '1', 'shared_bath_quad',
      'shared_bath_quad_bed', 'INDEPENDENT', 'SOURCE_EXPLICIT', NULL
    )
) AS target(
  id,
  kind,
  parent_room_id,
  code,
  legacy_name,
  catalog_version,
  building_code,
  room_type_code,
  pricing_product_code,
  inventory_basis,
  code_provenance,
  physical_bed_count
)
WHERE unit.property_id = 'prop_qintopia_demo'
  AND unit.id = target.id
  AND unit.kind = target.kind
  AND unit.parent_room_id IS NOT DISTINCT FROM target.parent_room_id
  AND unit.code = target.code
  AND unit.name = target.legacy_name
  AND unit.active IS TRUE
  AND unit.catalog_version IS NULL
  AND unit.building_code IS NULL
  AND unit.room_type_code IS NULL
  AND unit.pricing_product_code IS NULL
  AND unit.inventory_basis IS NULL
  AND unit.code_provenance IS NULL
  AND unit.physical_bed_count IS NULL;

ALTER TABLE inventory_units ENABLE TRIGGER inventory_units_protect_identity;
