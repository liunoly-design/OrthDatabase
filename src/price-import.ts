import { read, utils, type WorkSheet } from "xlsx";
import { sha256 } from "./attachments.ts";
import { httpsUrl, object, parseChangeRequest, parseGovernanceEvidence, positiveInteger, requiredText } from "./governance-input.ts";
import { parseSupplyManifest, extractSupplyEvidence } from "./supply-evidence.ts";
import type { PriceSource } from "../contracts/price-v1.d.ts";
import type { Candidate } from "./price-store.ts";

function parseLocalAwardReference(input: unknown): PriceSource["local_award_reference"] {
  if (input === undefined) return undefined;
  const reference = object(input, "local_award_reference");
  const digest = requiredText(reference.sha256, "local_award_reference.sha256");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("地方中选资格附件须提供 SHA-256");
  const url = new URL(httpsUrl(reference.url, "local_award_reference.url"));
  url.hash = "";
  return {
    title: requiredText(reference.title, "local_award_reference.title"),
    url: url.href,
    sha256: digest,
    page: positiveInteger(reference.page, "local_award_reference.page"),
    serial_number: positiveInteger(reference.serial_number, "local_award_reference.serial_number"),
    applicant: requiredText(reference.applicant, "local_award_reference.applicant"),
    product_system: requiredText(reference.product_system, "local_award_reference.product_system")
  };
}

export function parseImportManifest(input: unknown) {
  const manifest = object(input, "导入清单");
  const text = (key: string) => requiredText(manifest[key], key);
  const officialUrl = (key: string) => httpsUrl(manifest[key], key);

  const effectiveFrom = manifest.effective_from === null ? null : text("effective_from");
  if (effectiveFrom !== null) {
    const date = new Date(effectiveFrom);
    if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ||
        Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== effectiveFrom) {
      throw new Error("effective_from 必须是 YYYY-MM-DD 格式的有效日期或 null");
    }
  }
  const format = manifest.attachment_format;
  if (format !== undefined && format !== "html") throw new Error("无法识别 attachment_format");
  const rowNumber = manifest.row_number;
  const firstDataRow = format === "html" ? 2 : 5;
  if (typeof rowNumber !== "number" || !Number.isInteger(rowNumber) ||
      rowNumber < firstDataRow || rowNumber > 65536) {
    throw new Error("row_number 必须是有效的明细行号");
  }

  const localAward = parseLocalAwardReference(manifest.local_award_reference);
  const source: PriceSource = {
    publisher: text("publisher"),
    notice_title: text("notice_title"),
    notice_url: officialUrl("notice_url"),
    attachment_title: text("attachment_title"),
    attachment_url: officialUrl("attachment_url"),
    ...(format === "html" ? { attachment_format: format } : {}),
    ...(localAward ? { local_award_reference: localAward } : {}),
    sha256: text("sha256"),
    sheet_name: text("sheet_name"),
    row_number: rowNumber,
    price_cell: `G${rowNumber}`
  };
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("sha256 必须是 64 位小写十六进制摘要");
  return {
    source,
    governance: parseGovernanceEvidence(manifest.governance),
    change: parseChangeRequest(manifest.change),
    supply: parseSupplyManifest(manifest.supply),
    region: text("region"),
    effective_from: effectiveFrom,
    service_fee_basis: text("service_fee_basis")
  };
}

export type ImportManifest = ReturnType<typeof parseImportManifest>;

export const htmlResultsParserVersion = "joint-results-html/1";

export function awardTableBytes(source: PriceSource, document: Buffer) {
  if (source.attachment_format !== "html") return document;
  // The official table sits inside a page with per-request navigation and form state.
  const tables = [...document.toString("utf8").matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)]
    .filter(([table]) => table.includes("竞价单元") && table.includes("中选价格"));
  if (tables.length !== 1) throw new Error("无法唯一识别网页中的正式中选结果表");
  return Buffer.from(tables[0][0], "utf8");
}

function readResults(source: PriceSource, attachment: Buffer): { sheet: WorkSheet; headerRows: number[] } {
  if (source.attachment_format === "html") {
    const workbook = read(attachment.toString("utf8"), { type: "string", cellHTML: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (sheet?.A1?.v === "序号" && sheet.B1?.v === "产品系统类别" &&
        sheet.C1?.v === "竞价单元" && sheet.E1?.v === "申报企业" &&
        String(sheet.G1?.v).replace(/\s+/g, "") === "申报产品系统类别中选价格") {
      return { sheet, headerRows: [1] };
    }
  } else {
    const sheet = read(attachment, { type: "buffer", sheets: source.sheet_name, cellHTML: false }).Sheets[source.sheet_name];
    if (sheet?.A2?.v === "国家组织人工关节集中带量采购协议期满接续中选结果" &&
        sheet.B3?.v === "产品系统类别" && sheet.E3?.v === "申报企业" &&
        sheet.G3?.v === "申报产品系统类别" && sheet.G4?.v === "中选价格") {
      return { sheet, headerRows: [2, 3, 4] };
    }
  }
  throw new Error("无法识别产品系统中选价格表头");
}

export function extractCandidate(manifest: ImportManifest, workbook: Buffer, supplyWorkbook?: Buffer): Candidate {
  const { source, supply, change, governance, region, effective_from, service_fee_basis } = manifest;
  const { sheet_name: sheetName, row_number: rowNumber, price_cell: priceCell } = source;
  const digest = sha256(workbook);
  if (digest !== source.sha256) throw new Error("原表与导入清单的 SHA-256 不一致");
  const { sheet, headerRows } = readResults(source, workbook);

  const productSystem = sheet[`B${rowNumber}`]?.v;
  const applicant = sheet[`E${rowNumber}`]?.v;
  const amount = sheet[priceCell]?.v;
  const amountText = typeof amount === "number" ? amount.toFixed(2) : "";
  const validAmount = typeof amount === "number" && /^\d{1,10}\.\d{2}$/.test(amountText) &&
    amount > 0 && Number(amountText) === amount;
  if (!Number.isSafeInteger(sheet[`A${rowNumber}`]?.v) ||
      typeof productSystem !== "string" || !productSystem.trim() ||
      typeof applicant !== "string" || !applicant.trim() ||
      !validAmount ||
      sheet[priceCell].f) {
    throw new Error(`所选位置 ${sheetName}!${priceCell} 不是有效的产品系统中选价`);
  }

  const localAward = source.local_award_reference;
  if (localAward && (localAward.applicant !== applicant.trim() || localAward.product_system !== productSystem.trim())) {
    throw new Error("地方中选资格证据与中选原表的企业或产品系统类别不一致");
  }

  if (manifest.governance?.category_composition &&
      manifest.governance.category_composition.product_system !== productSystem.trim()) {
    throw new Error("类别组成与原表产品系统类别不一致");
  }
  const identity = [source.notice_url, source.attachment_url, digest, sheetName, rowNumber];
  const originalRows = [...headerRows, rowNumber].map((number) => ({
    number,
    cells: Array.from({ length: 8 }, (_, column) => {
      const cell = sheet[utils.encode_cell({ r: number - 1, c: column })];
      return cell?.w ?? String(cell?.v ?? "");
    })
  }));
  if (Boolean(supply) !== Boolean(supplyWorkbook)) {
    throw new Error("供应清单须同时提供清单信息和原始工作簿");
  }
  const supporting = supply && supplyWorkbook ? extractSupplyEvidence(supply, supplyWorkbook, {
    product_system: productSystem.trim(), applicant: applicant.trim(), amount
  }) : undefined;
  const details = supporting ? {
    category_composition: governance?.category_composition ?? null,
    unresolved: governance?.unresolved ?? [],
    ...supporting
  } : governance;
  const sourcePriceId = "aj_" + sha256(JSON.stringify(identity)).slice(0, 32);
  const candidateId = change
    ? "aj_" + sha256(JSON.stringify([sourcePriceId, change.operation, change.target_price_id,
      change.target_record_version, details, region, effective_from, service_fee_basis])).slice(0, 32)
    : sourcePriceId;
  return {
    price_id: candidateId, source_price_id: sourcePriceId,
    amount: amountText,
    product_system: productSystem.trim(),
    applicant: applicant.trim(),
    source, change, governance: details, region, effective_from, service_fee_basis,
    original_rows: originalRows
  };
}
