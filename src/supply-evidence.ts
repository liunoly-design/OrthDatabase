import { read, utils } from "xlsx";
import type { IdentifierLink, RelatedSupplySystem, WorkbookEvidence } from "../contracts/price-v1.d.ts";
import { sha256 } from "./attachments.ts";
import { httpsUrl, object, requiredText } from "./governance-input.ts";

export function parseSupplyManifest(value: unknown) {
  if (value === undefined) return null;
  const input = object(value, "supply");
  const digest = requiredText(input.sha256, "supply.sha256");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("供应清单 SHA-256 无效");
  return {
    title: requiredText(input.title, "supply.title"),
    url: httpsUrl(input.url, "supply.url"),
    notice_url: httpsUrl(input.notice_url, "supply.notice_url"),
    sha256: digest,
    system_code: requiredText(input.system_code, "supply.system_code")
  };
}

export const supplyParserVersion = "joint-supply-xlsx/1";

const sheetName = "系统表";
const headers = {
  B: "产品系统编码", D: "关节系统类别", F: "产品系统名称", H: "申报企业",
  I: "是否中选系统", J: "中选系统申报价格", K: "部件编号", L: "部件产品名称",
  Q: "注册证号", R: "旧版注册证号", S: "部件部位", X: "是否配件", Z: "是否中选部件"
};

export function extractSupplyEvidence(
  supply: NonNullable<ReturnType<typeof parseSupplyManifest>>,
  workbook: Buffer,
  price: { product_system: string; applicant: string; amount: number }
) {
  if (sha256(workbook) !== supply.sha256) throw new Error("供应清单与 SHA-256 不一致");
  const sheet = read(workbook, { sheets: sheetName, dense: true, cellHTML: false }).Sheets[sheetName];
  if (!sheet?.["!ref"] || !Object.keys(headers).every((column) => {
    const cell = sheet["!data"]?.[0]?.[utils.decode_col(column)];
    return cell?.v === headers[column as keyof typeof headers] && !cell.f;
  })) {
    throw new Error("无法识别供应清单系统表表头");
  }

  const { system_code: systemCode, ...document } = supply;
  const location = (row: number, columns: string[]): WorkbookEvidence => ({
    ...document, sheet_name: sheetName, row_number: row, cells: columns.map((column) => column + row)
  });
  const category = price.product_system.replace(/髋关节产品系统$|产品系统$/, "");
  const members: RelatedSupplySystem["members"] = [];
  const links: IdentifierLink[] = [];
  let system: Omit<RelatedSupplySystem, "members"> | undefined;
  for (const [index, row] of (sheet["!data"] ?? []).entries()) {
    const value = (column: keyof typeof headers) => {
      const cell = row?.[utils.decode_col(column)];
      return cell?.f ? undefined : cell?.v;
    };
    if (value("B") !== systemCode) continue;

    const rowNumber = index + 1;
    const name = requiredText(value("F"), `F${rowNumber}`);
    if (value("D") !== category || value("H") !== price.applicant || value("I") !== "是" ||
        Number(value("J")) !== price.amount || (system && name !== system.name)) {
      throw new Error(`供应系统 ${sheetName} 第 ${rowNumber} 行与中选原表口径不一致`);
    }
    system ??= { system_code: systemCode, name, relationship: "category_award_example",
      evidence: location(rowNumber, ["B", "D", "F", "H", "I", "J"]) };
    const component = requiredText(value("K"), `K${rowNumber}`);
    const accessory = value("X");
    if (accessory !== "是" && accessory !== "否") throw new Error(`供应清单 X${rowNumber} 的配件分类未知`);
    members.push({
      component_code: component, name: requiredText(value("L"), `L${rowNumber}`),
      role: requiredText(value("S"), `S${rowNumber}`), accessory: accessory === "是",
      award_status: requiredText(value("Z"), `Z${rowNumber}`),
      evidence: location(rowNumber, ["B", "K", "L", "S", "X", "Z"])
    });
    links.push({ scheme: "platform_component_code", value: component, system_code: systemCode, component,
      evidence: [location(rowNumber, ["B", "K"])] });
    for (const [column, scheme] of [["Q", "registration_number"], ["R", "former_registration_number"]] as const) {
      const registration = value(column);
      if (typeof registration === "string" && registration.trim()) {
        links.push({ scheme, value: registration.trim(), system_code: systemCode, component,
          evidence: [location(rowNumber, ["B", "K", column])] });
      }
    }
  }
  if (!system) throw new Error(`供应清单未找到系统 ${systemCode}`);
  links.unshift({ scheme: "platform_system_code", value: systemCode, system_code: systemCode,
    evidence: [system.evidence] });
  return { related_system: { ...system, members }, identifier_links: links };
}
