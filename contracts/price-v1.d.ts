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

export interface SheetLocation {
  sheet_name: string;
  row_number: number;
  cells: string[];
}

export type EvidenceLocation =
  | { section: string }
  | { page: number }
  | SheetLocation;

export type EvidenceReference = EvidenceLocation & {
  title: string;
  url: string;
  sha256?: string;
};

export type WorkbookEvidence = SheetLocation & {
  title: string;
  url: string;
  notice_url: string;
  sha256: string;
};

export interface RelatedSupplySystem {
  relationship: "category_award_example";
  system_code: string;
  name: string;
  evidence: WorkbookEvidence;
  members: {
    component_code: string;
    name: string;
    role: string;
    accessory: boolean;
    award_status: string;
    evidence: WorkbookEvidence;
  }[];
}

export interface ComponentQuantity {
  name: string;
  quantity: number;
  unit: string;
}

export interface IdentifierLink {
  scheme: "platform_system_code" | "platform_component_code" | "registration_number" | "former_registration_number";
  value: string;
  system_code: string;
  component?: string;
  evidence: EvidenceReference[];
}

export interface GovernanceEvidence {
  related_system: RelatedSupplySystem | null;
  category_composition: {
    product_system: string;
    members: ComponentQuantity[];
    note?: string;
    evidence: EvidenceReference[];
  } | null;
  identifier_links: IdentifierLink[];
  unresolved: string[];
}

export type PublicationOperation = "initial" | "additional_evidence" | "official_correction" | "platform_correction";

export interface PublicPriceEvidence {
  contract_version: 1;
  price_id: string;
  superseded_by_price_id: string | null;
  current_governance: GovernanceEvidence[];
  revisions: {
    record_version: number;
    operation: PublicationOperation;
    reason: string | null;
    source: PriceSource;
    governance: GovernanceEvidence | null;
    price: PublishedPriceSnapshot;
    published_at: string;
  }[];
}
