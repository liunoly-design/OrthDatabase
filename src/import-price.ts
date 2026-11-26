import { readFile } from "node:fs/promises";
import { read, utils } from "xlsx";
import { saveAttachment, sha256 } from "./attachments.ts";
import { attachmentRoot, connect } from "./database.ts";
import { addCandidate } from "./price-store.ts";
import type { Candidate } from "./price-store.ts";

function manifestField(manifest: unknown, key: string): unknown {
  if (!manifest || typeof manifest !== "object") throw new Error("导入清单必须是 JSON 对象");
  return (manifest as Record<string, unknown>)[key];
}

function extractCandidate(manifest: unknown, workbook: Buffer): Candidate {
  const text = (key: string) => {
    const value = manifestField(manifest, key);
    if (typeof value !== "string" || !value.trim()) throw new Error(`缺少导入字段 ${key}`);
    return value.trim();
  };
  const officialUrl = (key: string) => {
    const value = new URL(text(key));
    if (value.protocol !== "https:" || value.username || value.password) {
      throw new Error(`${key} 必须为公开 HTTPS 链接`);
    }
    return value.href;
  };

  const digest = sha256(workbook);
  if (digest !== text("sha256")) throw new Error("原表与导入清单的 SHA-256 不一致");
  const effectiveFrom = text("effective_from");
  const date = new Date(effectiveFrom);
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ||
      Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== effectiveFrom) {
    throw new Error("effective_from 必须是 YYYY-MM-DD 格式的有效日期");
  }
  const sheetName = text("sheet_name");
  const rowNumber = manifestField(manifest, "row_number");
  if (typeof rowNumber !== "number" || !Number.isInteger(rowNumber) ||
      rowNumber < 5 || rowNumber > 65536) {
    throw new Error("row_number 必须是有效的 Excel 明细行号");
  }

  const sheet = read(workbook, { type: "buffer", sheets: sheetName, cellHTML: false }).Sheets[sheetName];
  if (sheet?.A2?.v !== "国家组织人工关节集中带量采购协议期满接续中选结果" ||
      sheet.B3?.v !== "产品系统类别" || sheet.E3?.v !== "申报企业" ||
      sheet.G3?.v !== "申报产品系统类别" || sheet.G4?.v !== "中选价格") {
    throw new Error("无法识别工作表的产品系统中选价格表头");
  }

  const priceCell = `G${rowNumber}`;
  const productSystem = sheet[`B${rowNumber}`]?.v;
  const applicant = sheet[`E${rowNumber}`]?.v;
  const amount = sheet[priceCell]?.v;
  if (!Number.isSafeInteger(sheet[`A${rowNumber}`]?.v) ||
      typeof productSystem !== "string" || !productSystem.trim() ||
      typeof applicant !== "string" || !applicant.trim() ||
      typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 ||
      sheet[priceCell].f) {
    throw new Error(`所选位置 ${sheetName}!${priceCell} 不是有效的产品系统中选价`);
  }

  const source = {
    publisher: text("publisher"),
    notice_title: text("notice_title"),
    notice_url: officialUrl("notice_url"),
    attachment_title: text("attachment_title"),
    attachment_url: officialUrl("attachment_url"),
    sha256: digest,
    sheet_name: sheetName,
    row_number: rowNumber,
    price_cell: priceCell
  };
  const identity = [source.notice_url, source.attachment_url, digest, sheetName, rowNumber];
  const originalRows = [2, 3, 4, rowNumber].map((number) => ({
    number,
    cells: Array.from({ length: 8 }, (_, column) => {
      const cell = sheet[utils.encode_cell({ r: number - 1, c: column })];
      return cell?.w ?? String(cell?.v ?? "");
    })
  }));
  return {
    price_id: "aj_" + sha256(JSON.stringify(identity)).slice(0, 32),
    amount: amount.toFixed(2),
    product_system: productSystem.trim(),
    applicant: applicant.trim(),
    region: text("region"),
    effective_from: effectiveFrom,
    service_fee_basis: text("service_fee_basis"),
    source,
    original_rows: originalRows
  };
}

const [manifestFile, workbookFile, ...extra] = process.argv.slice(2);
if (!manifestFile || !workbookFile || extra.length) {
  throw new Error("Usage: npm run import:price -- <manifest.json> <workbook.xls>");
}

const [manifest, workbook] = await Promise.all([
  readFile(manifestFile, "utf8"),
  readFile(workbookFile)
]);
const candidate = extractCandidate(JSON.parse(manifest), workbook);
await saveAttachment(attachmentRoot(), candidate.source.sha256, workbook);
const pool = connect("ORTH_GOVERNANCE_DATABASE_URL");
try {
  await addCandidate(pool, candidate);
  console.log(JSON.stringify({ price_id: candidate.price_id }));
} finally {
  await pool.end();
}
