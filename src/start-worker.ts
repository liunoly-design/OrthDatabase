import { collectPrice } from "./collect-price.ts";

const [manifestFile, workbookFile, ...extra] = process.argv.slice(2);
if (!manifestFile || extra.length) {
  throw new Error("Usage: npm run start:worker -- <manifest.json> [workbook.xls]");
}

const result = await collectPrice(manifestFile, workbookFile, "ORTH_WORKER_DATABASE_URL");
console.log(JSON.stringify(result));
