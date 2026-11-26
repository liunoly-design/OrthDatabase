import { collectPrice } from "./collect-price.ts";

const [manifestFile, resultsFile, supplyFile, ...extra] = process.argv.slice(2);
if (!manifestFile || extra.length) {
  throw new Error("Usage: npm run start:worker -- <manifest.json> [results.xls|results.html] [supply.xlsx]");
}

const result = await collectPrice(manifestFile, resultsFile, "ORTH_WORKER_DATABASE_URL", supplyFile);
console.log(JSON.stringify(result));
