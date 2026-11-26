import { collectPrice } from "./collect-price.ts";

const [manifestFile, workbookFile, supplyFile, ...extra] = process.argv.slice(2);
if (!manifestFile || !workbookFile || extra.length) {
  throw new Error("Usage: npm run import:price -- <manifest.json> <workbook.xls> [supply.xlsx]");
}

const { price_id } = await collectPrice(manifestFile, workbookFile, "ORTH_GOVERNANCE_DATABASE_URL", supplyFile);
console.log(JSON.stringify({ price_id }));
