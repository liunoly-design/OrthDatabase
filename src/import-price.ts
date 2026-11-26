import { collectPrice } from "./collect-price.ts";

const [manifestFile, resultsFile, supplyFile, ...extra] = process.argv.slice(2);
if (!manifestFile || !resultsFile || extra.length) {
  throw new Error("Usage: npm run import:price -- <manifest.json> <results.xls|results.html> [supply.xlsx]");
}

const { price_id } = await collectPrice(manifestFile, resultsFile, "ORTH_GOVERNANCE_DATABASE_URL", supplyFile);
console.log(JSON.stringify({ price_id }));
