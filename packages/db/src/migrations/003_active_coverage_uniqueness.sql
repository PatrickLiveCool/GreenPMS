ALTER TABLE coverage_items
  DROP CONSTRAINT coverage_items_order_id_service_date_inventory_unit_id_key;

CREATE UNIQUE INDEX coverage_items_active_order_date_idx
  ON coverage_items (order_id, service_date)
  WHERE status <> 'RELEASED';
