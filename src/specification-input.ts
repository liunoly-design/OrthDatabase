import type {
  ComponentPrice, ProductSpecification, SpecificationIdentifier, SpecificationPrice, SpecificationProposal
} from "../contracts/specification-v1.d.ts";
import { list, object, parseDate, parseEvidenceReferences, positiveInteger, requiredText } from "./governance-input.ts";

const priceTypes = new Set(["正式中选价", "挂网价", "限价", "医院公开单价"]);

function internalId(value: unknown, field: string) {
  const id = requiredText(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error(`${field} 无效`);
  return id;
}

export function parseIdentifierKey(scheme: unknown, value: unknown, namespace?: unknown) {
  const code = requiredText(value, "value");
  if (code.length > 200) throw new Error("标识过长");
  switch (scheme) {
    case "registration_number":
      if (!/^[\p{L}\p{N}（）()－-]+$/u.test(code)) throw new Error("注册证号无效");
      break;
    case "nhsa_27":
      if (!/^C\d{26}$/.test(code)) throw new Error("医保耗材代码必须为 C 加 26 位数字");
      break;
    case "udi_di":
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.+/_-]*$/.test(code)) throw new Error("应提供已解析的 UDI-DI");
      break;
    case "platform_component_code":
      return { scheme, value: code, namespace: internalId(namespace, "namespace") } as const;
    default:
      throw new Error("标识类型无效");
  }
  if (namespace !== undefined) throw new Error("此标识类型无需 namespace");
  return { scheme, value: code, namespace: "" } as const;
}

function checkInterval(from: string | null, to: string | null) {
  if (from !== null && to !== null && from > to) throw new Error("起始日期晚于截止日期");
}

function nullableQuantity(value: unknown, field: string) {
  if (value === null) return null;
  const quantity = positiveInteger(value, field);
  if (quantity > 2_147_483_647) throw new Error(`${field} 超出范围`);
  return quantity;
}

function parseSpecification(value: unknown): ProductSpecification {
  const data = object(value, "specification");
  return {
    id: internalId(data.id, "id"), name: requiredText(data.name, "name"),
    registrant: requiredText(data.registrant, "registrant"), model: requiredText(data.model, "model"),
    specification: requiredText(data.specification, "specification"),
    evidence: parseEvidenceReferences(data.evidence)
  };
}

function parseIdentifier(value: unknown): SpecificationIdentifier {
  const data = object(value, "identifier");
  const key = parseIdentifierKey(data.scheme, data.value, data.namespace);
  const identifier = { id: internalId(data.id, "identifier.id"), value: key.value,
    evidence: parseEvidenceReferences(data.evidence) };
  switch (key.scheme) {
    case "registration_number": {
      const certificate = object(data.certificate, "certificate");
      const valid_from = parseDate(certificate.valid_from, "valid_from");
      const valid_to = parseDate(certificate.valid_to, "valid_to");
      checkInterval(valid_from, valid_to);
      return { ...identifier, scheme: key.scheme, certificate: { valid_from, valid_to },
        ...(data.via_component === undefined ? {} : { via_component: internalId(data.via_component, "via_component") }) };
    }
    case "udi_di": {
      const packaging = object(data.packaging, "packaging");
      return { ...identifier, scheme: key.scheme, packaging: {
        description: requiredText(packaging.description, "description"),
        quantity: nullableQuantity(packaging.quantity, "quantity")
      } };
    }
    case "platform_component_code":
      return { ...identifier, scheme: key.scheme, namespace: key.namespace };
    case "nhsa_27":
      return { ...identifier, scheme: key.scheme };
  }
}

function parsePriceFacts(
  data: Record<string, unknown>, prefix: string
): Omit<SpecificationPrice, "unit" | "original_identifier_ids"> {
  const priceId = internalId(data.price_id, "price_id");
  const amount = requiredText(data.amount, "amount");
  const priceType = requiredText(data.price_type, "price_type");
  if (!priceId.startsWith(prefix) || !/^(0|[1-9]\d{0,9})\.\d{2}$/.test(amount) || amount === "0.00" ||
      !priceTypes.has(priceType)) throw new Error("品规价格编号、金额或类型无效");
  const effective_from = parseDate(data.effective_from, "effective_from");
  const effective_to = parseDate(data.effective_to, "effective_to");
  checkInterval(effective_from, effective_to);
  const exclusiveEndDate = effective_to === null ? null : new Date(effective_to);
  if (exclusiveEndDate) exclusiveEndDate.setUTCDate(exclusiveEndDate.getUTCDate() + 1);
  const effective_to_exclusive = exclusiveEndDate?.toISOString().split("T")[0] ?? null;
  if (data.effective_to_exclusive !== undefined && data.effective_to_exclusive !== effective_to_exclusive) {
    throw new Error("归一化价格截止日须与原截止日一致");
  }
  const effectiveToBasis = effective_to !== null ? "known" : data.effective_to_basis === "open" ? "open" : "unknown";
  if (data.effective_to_basis !== undefined && data.effective_to_basis !== effectiveToBasis) {
    throw new Error("价格截止日期与披露状态不一致");
  }
  return {
    price_id: priceId, amount, price_type: priceType as SpecificationPrice["price_type"],
    pack_quantity: nullableQuantity(data.pack_quantity, "pack_quantity"),
    region: requiredText(data.region, "region"),
    hospital_id: data.hospital_id === null ? null : requiredText(data.hospital_id, "hospital_id"),
    round_id: data.round_id === null ? null : requiredText(data.round_id, "round_id"),
    effective_from, effective_to, effective_to_exclusive, effective_to_basis: effectiveToBasis,
    ...(data.effective_date_text === undefined ? {} : { effective_date_text: requiredText(data.effective_date_text, "effective_date_text") }),
    service_fee_basis: requiredText(data.service_fee_basis, "service_fee_basis"),
    evidence: parseEvidenceReferences(data.evidence)
  };
}

function parseSpecificationPrice(value: unknown): SpecificationPrice {
  const data = object(value, "price");
  const originalIdentifiers = list(data.original_identifier_ids, "original_identifier_ids",
    (id) => internalId(id, "original_identifier_ids"));
  if (new Set(originalIdentifiers).size !== originalIdentifiers.length) throw new Error("原始标识重复");
  return { ...parsePriceFacts(data, "sp_"), unit: requiredText(data.unit, "unit"),
    original_identifier_ids: originalIdentifiers };
}

function parseComponentPrice(value: unknown): ComponentPrice {
  const data = object(value, "price");
  const component = object(data.component, "component");
  const { value: code, namespace } = parseIdentifierKey("platform_component_code", component.value, component.namespace);
  let sourceNhsa: ComponentPrice["source_nhsa_20"];
  if (data.source_nhsa_20 !== undefined) {
    const codes = object(data.source_nhsa_20, "source_nhsa_20");
    const current = requiredText(codes.current, "current");
    const former = requiredText(codes.former, "former");
    if (![current, former].every((code) => /^C\d{19}$/.test(code))) throw new Error("原表医保编码须为 20 位");
    sourceNhsa = { current, former };
  }
  return {
    ...parsePriceFacts(data, "cp_"),
    unit: data.unit === null ? null : requiredText(data.unit, "unit"),
    component: { namespace, value: code },
    original_registration_numbers: list(data.original_registration_numbers, "original_registration_numbers",
      (entry) => parseIdentifierKey("registration_number", entry).value),
    ...(sourceNhsa ? { source_nhsa_20: sourceNhsa } : {})
  };
}

export function parseSpecificationProposal(value: unknown): SpecificationProposal {
  const data = object(value, "proposal");
  switch (data.kind) {
    case "specification": {
      const identifiers = list(data.identifiers ?? [], "identifiers", parseIdentifier);
      const prices = list(data.prices ?? [], "prices", parseSpecificationPrice);
      const references = list(data.published_price_references ?? [], "published_price_references", (entry) => {
        const reference = object(entry, "published_price_reference");
        const priceId = requiredText(reference.price_id, "price_id");
        if (!/^aj_[a-f0-9]{32}$/.test(priceId)) throw new Error("既有价格编号无效");
        return { price_id: priceId, ...(reference.component_identifier_id === undefined ? {} : {
          component_identifier_id: internalId(reference.component_identifier_id, "component_identifier_id")
        }) };
      });
      if (new Set(identifiers.map(({ id }) => id)).size !== identifiers.length ||
          new Set(prices.map(({ price_id }) => price_id)).size !== prices.length ||
          new Set(references.map(({ price_id }) => price_id)).size !== references.length) {
        throw new Error("候选内的标识或价格编号重复");
      }
      return {
        kind: data.kind, specification: parseSpecification(data.specification), identifiers, prices,
        ...(references.length ? { published_price_references: references } : {}),
        unresolved: list(data.unresolved ?? [], "unresolved", (note) => requiredText(note, "unresolved"))
      };
    }
    case "component_price":
      return { kind: data.kind, price: parseComponentPrice(data.price) };
    case "same_physical": {
      const relation = object(data.relation, "relation");
      const left = internalId(relation.left_spec_id, "left_spec_id");
      const right = internalId(relation.right_spec_id, "right_spec_id");
      if (left === right) throw new Error("同一实物关联须指向两个独立品规");
      const [left_spec_id, right_spec_id] = [left, right].sort();
      return { kind: data.kind, relation: { id: internalId(relation.id, "relation.id"), left_spec_id, right_spec_id,
        evidence: parseEvidenceReferences(relation.evidence), reason: requiredText(relation.reason, "reason") } };
    }
    case "revoke":
      return { kind: data.kind, relation_id: internalId(data.relation_id, "relation_id"),
        reason: requiredText(data.reason, "reason") };
    default:
      throw new Error("品规候选类型无效");
  }
}
