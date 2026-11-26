export interface PriceSource {
  publisher: string;
  notice_title: string;
  notice_url: string;
  attachment_title: string;
  attachment_url: string;
  sha256: string;
  sheet_name: string;
  row_number: number;
  price_cell: string;
}

type PricedSubject =
  | { subject_kind: "product_spec"; product_spec_id: string; kit_version_id: null }
  | { subject_kind: "kit"; product_spec_id: null; kit_version_id: string }
  | { subject_kind: "kit_category"; product_spec_id: null; kit_version_id: null };

export type PublishedPriceSnapshot = PricedSubject & {
  contract_version: 1;
  price_id: string;
  record_version: number;
  record_status: "published";
  supersedes_price_id: string | null;
  round_id: string | null;
  amount: string;
  currency: "CNY";
  unit: string;
  price_type: "正式中选价" | "挂网价" | "限价" | "医院公开单价";
  product_system: string;
  applicant: string;
  pack_quantity: number | null;
  region: string;
  hospital_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  service_fee_basis: string;
  source: PriceSource;
};

export type PublicPrice = PublishedPriceSnapshot & {
  published_at: string;
};

export type PriceSearchResult = PublicPrice & {
  published_group: string | null;
};

export interface PriceSearchFilters {
  round_id: string[];
  published_group: string[];
  price_type: PublicPrice["price_type"][];
  pack_quantity: (number | null)[];
  unit: string[];
}

export interface PriceSearchResponse {
  prices: PriceSearchResult[];
  filters: PriceSearchFilters;
  next_cursor: string | null;
}
