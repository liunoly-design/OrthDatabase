-- The same approved candidate supplies both the governed price and its published group.
UPDATE orth_catalog.price_record AS price
SET published_group = orth_catalog.hunan_joint_group(candidate.original_rows, candidate.source)
FROM orth_governance.import_candidate AS candidate
WHERE candidate.price_id = price.origin_candidate_id;

CREATE FUNCTION orth_catalog.set_published_price_group()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    SELECT orth_catalog.hunan_joint_group(candidate.original_rows, candidate.source) INTO NEW.published_group
    FROM orth_governance.import_candidate AS candidate
    WHERE candidate.price_id = NEW.origin_candidate_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION orth_catalog.set_published_price_group() FROM PUBLIC;

CREATE TRIGGER set_published_price_group
BEFORE INSERT ON orth_catalog.price_record
FOR EACH ROW EXECUTE FUNCTION orth_catalog.set_published_price_group();
