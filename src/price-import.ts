import { read, utils } from "xlsx";
import { sha256 } from "./attachments.ts";
import { httpsUrl, object, parseChangeRequest, parseGovernanceEvidence, requiredText } from "./governance-input.ts";
import { parseSupplyManifest, extractSupplyEvidence } from "./supply-evidence.ts";
import type { Candidate } from "./price-store.ts";

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
  const sheetName = text("sheet_name");
  const rowNumber = manifest.row_number;
  if (typeof rowNumber !== "number" || !Number.isInteger(rowNumber) ||
      rowNumber < 5 || rowNumber > 65536) {
    throw new Error("row_number 必须是有效的 Excel 明细行号");
  }

  const source = {
    publisher: text("publisher"),
    notice_title: text("notice_title"),
    notice_url: officialUrl("notice_url"),
    attachment_title: text("attachment_title"),
    attachment_url: officialUrl("attachment_url"),
    sha256: text("sha256"),
    sheet_name: sheetName,
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

export function extractCandidate(manifest: ImportManifest, workbook: Buffer, supplyWorkbook?: Buffer): Candidate {
  const { source, supply, change, governance, region, effective_from, service_fee_basis } = manifest;
  const { sheet_name: sheetName, row_number: rowNumber, price_cell: priceCell } = source;
  const digest = sha256(workbook);
  if (digest !== source.sha256) throw new Error("原表与导入清单的 SHA-256 不一致");
  const sheet = read(workbook, { type: "buffer", sheets: sheetName, cellHTML: false }).Sheets[sheetName];
  if (sheet?.A2?.v !== "国家组织人工关节集中带量采购协议期满接续中选结果" ||
      sheet.B3?.v !== "产品系统类别" || sheet.E3?.v !== "申报企业" ||
      sheet.G3?.v !== "申报产品系统类别" || sheet.G4?.v !== "中选价格") {
    throw new Error("无法识别工作表的产品系统中选价格表头");
  }

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

  if (manifest.governance?.category_composition &&
      manifest.governance.category_composition.product_system !== productSystem.trim()) {
    throw new Error("类别组成与原表产品系统类别不一致");
  }
  const identity = [source.notice_url, source.attachment_url, digest, sheetName, rowNumber];
  const originalRows = [2, 3, 4, rowNumber].map((number) => ({
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
