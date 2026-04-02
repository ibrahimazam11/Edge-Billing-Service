import { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type DrizzleDatabase = NodePgDatabase<typeof schema>;

export type TransactionClient = Pick<
  DrizzleDatabase,
  "select" | "insert" | "update" | "delete"
>;

export type DbOrTx = DrizzleDatabase | TransactionClient;
