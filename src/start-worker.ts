import { collectPrice } from "./collect-price.ts";

const [manifestFile, workbookFile, supplyFile, ...extra] = process.argv.slice(2);
if (!manifestFile || extra.length) {
  throw new Error("Usage: npm run start:worker -- <manifest.json> [workbook.xls] [supply.xlsx]");
}

const result = await collectPrice(manifestFile, workbookFile, "ORTH_WORKER_DATABASE_URL", supplyFile);
console.log(JSON.stringify(result));
