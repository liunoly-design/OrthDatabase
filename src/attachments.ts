import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewCandidate } from "./price-store.ts";

export function sha256(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex");
}

export function attachmentPath(root: string, digest: string, format: "xls" | "xlsx" = "xls") {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid attachment digest");
  return join(root, `${digest}.${format}`);
}

export async function saveAttachment(root: string, digest: string, workbook: Buffer, format: "xls" | "xlsx" = "xls") {
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".import-"));
  const file = join(staging, "source.xls");
  try {
    await writeFile(file, workbook);
    await rename(file, attachmentPath(root, digest, format));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function candidateAttachment(candidate: ReviewCandidate, document: string) {
  if (document === "attachment") {
    return { digest: candidate.source.sha256, title: candidate.source.attachment_title, format: "xls" } as const;
  }
  const supply = candidate.governance?.related_system?.evidence;
  if (document === "supply" && supply) {
    return { digest: supply.sha256, title: supply.title, format: "xlsx" } as const;
  }
}
