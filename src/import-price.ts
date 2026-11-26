import { collectPrice } from "./collect-price.ts";

const [manifestFile, workbookFile, ...extra] = process.argv.slice(2);
if (!manifestFile || !workbookFile || extra.length) {
  throw new Error("Usage: npm run import:price -- <manifest.json> <workbook.xls>");
}

const { price_id } = await collectPrice(manifestFile, workbookFile, "ORTH_GOVERNANCE_DATABASE_URL");
console.log(JSON.stringify({ price_id }));
