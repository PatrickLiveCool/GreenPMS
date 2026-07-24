ALTER TABLE inventory_units DISABLE TRIGGER inventory_units_protect_identity;

UPDATE inventory_units
SET catalog_version = 'qintopia-2026-feishu-revision-561-user-confirmed-v4'
WHERE catalog_version = 'qintopia-2026-feishu-revision-561-user-confirmed-v3';

UPDATE inventory_units
SET code = replacements.new_code,
    name = regexp_replace(inventory_units.name, '^' || replacements.old_code, replacements.new_code)
FROM (
  VALUES
    ('unit_room_d_gen_01', 'D-GEN-01', 'D01'),
    ('unit_room_d_gen_02', 'D-GEN-02', 'D02'),
    ('unit_room_d_gen_03', 'D-GEN-03', 'D03'),
    ('unit_room_d_gen_04', 'D-GEN-04', 'D04'),
    ('unit_room_d_gen_05', 'D-GEN-05', 'D05'),
    ('unit_room_e_gen_01', 'E-GEN-01', 'E01'),
    ('unit_room_e_gen_02', 'E-GEN-02', 'E02'),
    ('unit_room_e_gen_03', 'E-GEN-03', 'E03')
) AS replacements(unit_id, old_code, new_code)
WHERE inventory_units.id = replacements.unit_id
  AND inventory_units.code = replacements.old_code;

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE inventory_units ENABLE TRIGGER inventory_units_protect_identity;
