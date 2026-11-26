import { Pool } from "pg";

export function connect(variable: string) {
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`${variable} is required`);
  return new Pool({ connectionString });
}

export function attachmentRoot() {
  return process.env.ORTH_DATA_DIR ?? ".orth-data";
}
