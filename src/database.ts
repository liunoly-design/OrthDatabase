import { Pool } from "pg";

export function connect() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString });
}

export function attachmentRoot() {
  return process.env.ORTH_DATA_DIR ?? ".orth-data";
}
