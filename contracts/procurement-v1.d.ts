import type { PriceSearchResult } from "./price-v1.d.ts";

export type ProcurementEventType =
  "submission" | "official_award" | "annual_renewal" | "local_execution" |
  "product_information_maintenance" | "product_information_confirmation" | "product_information_notice";

export interface ProcurementSource {
  title: string;
  url: string;
  location: string;
  sha256?: string;
}

export interface ProcurementEvent {
  event_id: string;
  round_id: string;
  round_title: string;
  categories: string[];
  region: string | null;
  event_type: ProcurementEventType;
  announced_on: string;
  effective_from: string | null;
  effective_to: string | null;
  summary: string;
  price_disclosure: "not_disclosed" | "disclosed" | "referenced" | "not_stated";
  source: ProcurementSource & { publisher: string };
  evidence: {
    execution_date_location?: string;
    execution_end_basis?: string;
    price_rule_location?: string;
    applicable_price_basis?: string;
    pricing_unit_source?: ProcurementSource;
    attachments?: ProcurementSource[];
    referenced_award_event_id?: string;
  };
}

export interface ProcurementResponse {
  contract_version: 1;
  events: ProcurementEvent[];
  prices: (PriceSearchResult & { execution: ProcurementEvent; applicable_to: string | null })[];
  next_price_cursor: string | null;
}
