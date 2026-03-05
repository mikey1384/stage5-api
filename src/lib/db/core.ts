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
