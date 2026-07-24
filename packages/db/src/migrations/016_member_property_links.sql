LOCK TABLE member_contracts, member_external_references IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE member_property_links (
  member_id text NOT NULL REFERENCES members(id),
  property_id text NOT NULL REFERENCES properties(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, property_id)
);

INSERT INTO member_property_links (member_id, property_id)
SELECT member_id, property_id
FROM member_contracts
WHERE member_id IS NOT NULL
UNION
SELECT member_id, property_id
FROM member_external_references
ON CONFLICT (member_id, property_id) DO NOTHING;

CREATE INDEX member_property_links_property_member_idx
  ON member_property_links (property_id, member_id);

CREATE OR REPLACE FUNCTION qintopia_sync_member_property_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.member_id IS NOT NULL THEN
    INSERT INTO member_property_links (member_id, property_id)
    VALUES (NEW.member_id, NEW.property_id)
    ON CONFLICT (member_id, property_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER member_contracts_sync_property_link
AFTER INSERT OR UPDATE OF member_id, property_id ON member_contracts
FOR EACH ROW EXECUTE FUNCTION qintopia_sync_member_property_link();

CREATE TRIGGER member_external_references_sync_property_link
AFTER INSERT OR UPDATE OF member_id, property_id ON member_external_references
FOR EACH ROW EXECUTE FUNCTION qintopia_sync_member_property_link();

CREATE TRIGGER member_property_links_append_only
BEFORE UPDATE OR DELETE ON member_property_links
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
