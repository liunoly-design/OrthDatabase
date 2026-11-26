import type { EvidenceReference, PublicPrice, WorkbookEvidence } from "./price-v1.d.ts";

export type SpecificationIdentifierScheme = "registration_number" | "nhsa_27" | "udi_di" | "platform_component_code";

export interface ProductSpecification {
  id: string;
  name: string;
  registrant: string;
  model: string;
  specification: string;
  evidence: EvidenceReference[];
}

interface IdentifierObservation {
  id: string;
  value: string;
  evidence: EvidenceReference[];
}

export type SpecificationIdentifier = IdentifierObservation & (
  | { scheme: "registration_number"; certificate: { valid_from: string | null; valid_to: string | null }; via_component?: string }
  | { scheme: "nhsa_27" }
  | { scheme: "udi_di"; packaging: { description: string; quantity: number | null } }
  | { scheme: "platform_component_code"; namespace: string }
);

interface PriceFacts {
  price_id: string;
  amount: string;
  price_type: PublicPrice["price_type"];
  unit: string | null;
  pack_quantity: number | null;
  region: string;
  hospital_id: string | null;
  round_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  effective_to_exclusive?: string | null;
  effective_to_basis?: "known" | "open" | "unknown";
  effective_date_text?: string;
  service_fee_basis: string;
  evidence: EvidenceReference[];
}

export interface SpecificationPrice extends PriceFacts {
  unit: string;
  original_identifier_ids: string[];
}

export interface ComponentPrice extends PriceFacts {
  component: { namespace: string; value: string };
  original_registration_numbers: string[];
  source_nhsa_20?: { current: string; former: string };
}

export type SpecificationPriceTrace = Omit<SpecificationPrice, "original_identifier_ids"> & {
  original_identifiers: SpecificationIdentifier[];
  matched_original_identifier: boolean;
  packaging_match: "matched" | "other" | "unverified" | null;
};

export interface SamePhysicalSpecification {
  id: string;
  left_spec_id: string;
  right_spec_id: string;
  evidence: EvidenceReference[];
  reason: string;
}

export interface PublishedPriceReference {
  price_id: string;
  component_identifier_id?: string;
}

export type PublishedPriceLink = {
  price_id: string;
  relationship: "product_spec";
} | {
  price_id: string;
  relationship: "category_award_example";
  system_code: string;
  evidence: WorkbookEvidence;
};

export type SpecificationProposal =
  | { kind: "specification"; specification: ProductSpecification; identifiers: SpecificationIdentifier[];
      prices: SpecificationPrice[]; published_price_references?: PublishedPriceReference[]; unresolved: string[] }
  | { kind: "component_price"; price: ComponentPrice }
  | { kind: "same_physical"; relation: SamePhysicalSpecification }
  | { kind: "revoke"; relation_id: string; reason: string };

export interface SpecificationTrace {
  specification: ProductSpecification;
  matched_identifiers: SpecificationIdentifier[];
  identifiers: SpecificationIdentifier[];
  prices: SpecificationPriceTrace[];
  component_prices: ComponentPrice[];
  published_price_links: PublishedPriceLink[];
  relations: SamePhysicalSpecification[];
}

export interface SpecificationLookupResponse {
  contract_version: 1;
  status: "matched" | "ambiguous" | "component_only" | "unverified";
  next_cursor: string | null;
  matches: SpecificationTrace[];
  component_matches: SpecificationTrace[];
  related: SpecificationTrace[];
}

export type TracePriceDetail =
  | ({ contract_version: 1; subject_kind: "product_spec"; product_spec_id: string; currency: "CNY" } &
      SpecificationPriceTrace)
  | ({ contract_version: 1; subject_kind: "component"; currency: "CNY" } & ComponentPrice);
