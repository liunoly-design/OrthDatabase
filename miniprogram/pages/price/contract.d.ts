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

export interface PublicPrice {
  price_id: string;
  amount: string;
  currency: "CNY";
  unit: "元/套";
  price_type: "正式中选价";
  product_system: string;
  applicant: string;
  region: string;
  effective_from: string;
  service_fee_basis: string;
  source: PriceSource;
}
