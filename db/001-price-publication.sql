BEGIN;

CREATE TABLE IF NOT EXISTS import_candidate (
    price_id text PRIMARY KEY CHECK (price_id ~ '^aj_[a-f0-9]{32}$'),
    amount numeric(12, 2) NOT NULL CHECK (amount > 0),
    product_system text NOT NULL,
    applicant text NOT NULL,
    region text NOT NULL,
    effective_from date NOT NULL,
    service_fee_basis text NOT NULL,
    source jsonb NOT NULL,
    original_rows jsonb NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by text,
    CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);

CREATE TABLE IF NOT EXISTS price_record (
    price_id text PRIMARY KEY REFERENCES import_candidate (price_id),
    amount numeric(12, 2) NOT NULL CHECK (amount > 0),
    product_system text NOT NULL,
    applicant text NOT NULL,
    region text NOT NULL,
    effective_from date NOT NULL,
    service_fee_basis text NOT NULL,
    source jsonb NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    published_by text NOT NULL
);

COMMIT;
