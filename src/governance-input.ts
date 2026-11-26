import type { EvidenceReference, GovernanceEvidence, PublicationOperation } from "../contracts/price-v1.d.ts";

export interface ChangeRequest {
  operation: Exclude<PublicationOperation, "initial">;
  target_price_id: string;
  target_record_version: number;
  reason: string;
}

export function parseChangeRequest(value: unknown): ChangeRequest | null {
  if (value === undefined) return null;
  const item = object(value, "change");
  const operation = item.operation;
  if (operation !== "additional_evidence" && operation !== "official_correction" && operation !== "platform_correction") {
    throw new Error("change.operation 无效");
  }
  const targetPriceId = requiredText(item.target_price_id, "target_price_id");
  if (!/^aj_[a-f0-9]{32}$/.test(targetPriceId)) throw new Error("target_price_id 无效");
  const version = positiveInteger(item.target_record_version, "target_record_version");
  if (version > 2_147_483_647) throw new Error("target_record_version 超出范围");
  return { operation, target_price_id: targetPriceId, target_record_version: version,
    reason: requiredText(item.reason, "reason") };
}

export const skillVersion = "orth-price-governance/2";
export const parserVersion = "joint-results-xls/1";

export function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须为对象`);
  return value as Record<string, unknown>;
}

export function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error(`${field} 必须为有效文本`);
  return value.trim();
}

export function httpsUrl(value: unknown, field: string) {
  const url = new URL(requiredText(value, field));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${field} 必须为公开 HTTPS 链接`);
  return url.href;
}

export function positiveInteger(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} 必须为正整数`);
  }
  return value;
}

function list<T>(value: unknown, field: string, parse: (entry: unknown) => T, required = false) {
  if (!Array.isArray(value) || value.length > 100 || (required && value.length === 0)) {
    throw new Error(`${field} 必须为有效列表`);
  }
  return value.map(parse);
}

function evidence(value: unknown): EvidenceReference[] {
  return list(value, "evidence", (entry) => {
    const item = object(entry, "evidence");
    const reference = { title: requiredText(item.title, "title"), url: httpsUrl(item.url, "url") };
    if (item.sheet_name !== undefined) {
      const digest = requiredText(item.sha256, "sha256");
      const rowNumber = positiveInteger(item.row_number, "row_number");
      const cells = list(item.cells, "cells", (cell) => {
        const address = requiredText(cell, "cell");
        if (!/^[A-Z]{1,3}[1-9]\d*$/.test(address) || Number(address.replace(/^[A-Z]+/, "")) !== rowNumber) {
          throw new Error("证据单元格与证据行不一致");
        }
        return address;
      }, true);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("表格证据须提供 SHA-256");
      return { ...reference, sha256: digest, sheet_name: requiredText(item.sheet_name, "sheet_name"),
        row_number: rowNumber, cells };
    }
    if (item.page !== undefined) {
      const digest = item.sha256 === undefined ? undefined : requiredText(item.sha256, "sha256");
      if (digest && !/^[a-f0-9]{64}$/.test(digest)) throw new Error("证据 SHA-256 无效");
      return { ...reference, ...(digest ? { sha256: digest } : {}), page: positiveInteger(item.page, "page") };
    }
    return { ...reference, section: requiredText(item.section, "section") };
  }, true);
}

export function parseGovernanceEvidence(value: unknown): GovernanceEvidence | null {
  if (value === undefined) return null;
  const data = object(value, "governance");
  let composition: GovernanceEvidence["category_composition"] = null;
  if (data.category_composition !== undefined) {
    const group = object(data.category_composition, "category_composition");
    const members = list(group.members, "members", (value) => {
      const member = object(value, "member");
      return { name: requiredText(member.name, "name"), quantity: positiveInteger(member.quantity, "quantity"),
        unit: requiredText(member.unit, "unit") };
    }, true);
    composition = { product_system: requiredText(group.product_system, "product_system"), members,
      ...(group.note === undefined ? {} : { note: requiredText(group.note, "note") }), evidence: evidence(group.evidence) };
  }
  return {
    category_composition: composition,
    related_system: null,
    identifier_links: [],
    unresolved: list(data.unresolved ?? [], "unresolved", (entry) => requiredText(entry, "unresolved"))
  };
}
