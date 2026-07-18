CREATE OR REPLACE FUNCTION qintopia_prevent_fact_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_protect_order_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.primary_guest_snapshot IS DISTINCT FROM OLD.primary_guest_snapshot
    OR NEW.pricing_policy_version_id IS DISTINCT FROM OLD.pricing_policy_version_id
    OR NEW.stay_type IS DISTINCT FROM OLD.stay_type
    OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id THEN
    RAISE EXCEPTION 'order identity, guest snapshot, membership, stay type, and locked pricing policy are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pricing_policy_versions_append_only BEFORE UPDATE OR DELETE ON pricing_policy_versions FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER stay_segments_append_only BEFORE UPDATE OR DELETE ON stay_segments FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER amendments_append_only BEFORE UPDATE OR DELETE ON amendments FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER pricing_revisions_append_only BEFORE UPDATE OR DELETE ON pricing_revisions FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER entitlement_ledger_append_only BEFORE UPDATE OR DELETE ON entitlement_ledger FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER collection_facts_append_only BEFORE UPDATE OR DELETE ON collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER command_receipts_append_only BEFORE UPDATE OR DELETE ON command_receipts FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER audit_entries_append_only BEFORE UPDATE OR DELETE ON audit_entries FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER orders_protect_identity BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION qintopia_protect_order_identity();
