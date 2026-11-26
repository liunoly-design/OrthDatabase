import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function sha256(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex");
}

export function attachmentPath(root: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid attachment digest");
  return join(root, digest + ".xls");
}

export async function saveAttachment(root: string, digest: string, workbook: Buffer) {
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".import-"));
  const file = join(staging, "source.xls");
  try {
    await writeFile(file, workbook);
    await rename(file, attachmentPath(root, digest));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
