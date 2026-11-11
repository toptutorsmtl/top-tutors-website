import { PGlite } from "@electric-sql/pglite";
import { migrate, type Db } from "../src/shared/db.js";

export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  const db = pg as unknown as Db;
  await migrate(db);
  return db;
}
