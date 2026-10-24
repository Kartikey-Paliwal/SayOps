import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

/** Works with the Postgres container on EC2, Neon or RDS — only DATABASE_URL changes. */
export function getDb() {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = drizzle(new Pool({ connectionString: url, max: 5 }), { schema });
  }
  return db;
}
