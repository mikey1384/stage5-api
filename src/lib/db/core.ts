// Database interface - works with both D1 and regular SQLite
export interface Database {
  prepare(query: string): any;
  exec(query: string): Promise<any>;
  // D1 supports batch() which executes statements in a single transaction.
  batch?: (statements: any[]) => Promise<any>;
}

// For Cloudflare Workers with D1
declare global {
  interface CloudflareBindings {
    DB: D1Database;
  }
}

// Initialize database (D1 in Workers, SQLite elsewhere)
let db: Database | undefined;
let tablesCreated = false;

export const ensureDatabase = async (env: { DB: D1Database }) => {
  if (!db) {
    db = env.DB; // Bind the Worker's D1 instance
  }
  // Tables already exist in production - use `wrangler d1 migrations` for schema changes
  tablesCreated = true;
};

export const getDatabase = (): Database => {
  if (!db) throw new Error("Database not initialized");
  return db;
};

export const isDatabaseReady = (): boolean => !!db && tablesCreated;

export function hasAtomicBatch(
  candidate: Database = getDatabase()
): candidate is Database & { batch: (statements: any[]) => Promise<any> } {
  return typeof candidate.batch === "function";
}

export function buildRollbackIfNoChangesStatement(tag: string): any {
  const db = getDatabase();
  const rollbackTag = `rollback:${tag}`;
  return db
    .prepare(
      `INSERT INTO billing_idempotency (
         device_id,
         reason,
         idempotency_key,
         spend,
         meta,
         created_at
       )
       SELECT ?, NULL, ?, 0, ?, CURRENT_TIMESTAMP
        WHERE (SELECT changes()) = 0`
    )
    .bind(
      rollbackTag,
      `${rollbackTag}:${Date.now()}:${Math.random()}`,
      JSON.stringify({ rollbackTag })
    );
}

export function isRollbackIfNoChangesError(error: any): boolean {
  const msg = String(error?.message || error || "");
  return msg.includes("NOT NULL constraint failed: billing_idempotency.reason");
}

export async function executeAtomicBatch(statements: any[]): Promise<any[]> {
  const db = getDatabase();
  if (hasAtomicBatch(db)) {
    return db.batch(statements);
  }

  await db.exec("BEGIN");
  try {
    const results: any[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    await db.exec("COMMIT");
    return results;
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}

export async function runInTransaction<T>(work: () => Promise<T>): Promise<T> {
  const db = getDatabase();
  if (hasAtomicBatch(db)) {
    throw new Error(
      "runInTransaction is not safe for D1-backed databases; use executeAtomicBatch or atomic SQL instead."
    );
  }
  await db.exec("BEGIN");
  try {
    const result = await work();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}
