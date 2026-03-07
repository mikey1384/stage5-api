import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../migrations");
const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS credits (
  device_id TEXT PRIMARY KEY,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  meta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entitlements (
  device_id TEXT PRIMARY KEY,
  byo_openai INTEGER NOT NULL DEFAULT 0,
  byo_anthropic INTEGER NOT NULL DEFAULT 0,
  unlocked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

const RESET_TABLES_SQL = `
DROP TABLE IF EXISTS relay_translation_jobs;
DROP TABLE IF EXISTS stripe_fulfillments;
DROP TABLE IF EXISTS processed_events;
DROP TABLE IF EXISTS runtime_state;
DROP TABLE IF EXISTS billing_reservations;
DROP TABLE IF EXISTS device_api_tokens;
DROP TABLE IF EXISTS billing_idempotency;
DROP TABLE IF EXISTS credit_ledger;
DROP TABLE IF EXISTS entitlements;
DROP TABLE IF EXISTS credits;
`;

function wrapStatement(statement) {
  let bindings = [];

  return {
    bind(...params) {
      bindings = params;
      return this;
    },
    async run() {
      const info = statement.run(...bindings);
      return {
        meta: {
          changes: info.changes,
          last_row_id: Number(info.lastInsertRowid ?? 0),
        },
      };
    },
    async first() {
      const row = statement.get(...bindings);
      return row ?? null;
    },
    async all() {
      const results = statement.all(...bindings);
      return { results };
    },
  };
}

export function createSqliteD1Database() {
  const sqlite = new DatabaseSync(":memory:");

  const db = {
    prepare(query) {
      return wrapStatement(sqlite.prepare(query));
    },
    async exec(query) {
      sqlite.exec(query);
      return {};
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          // Ignore rollback failures in tests.
        }
        throw error;
      }
    },
  };

  return { sqlite, db };
}

export function resetSqliteD1Database(sqlite) {
  sqlite.exec(RESET_TABLES_SQL);
  sqlite.exec(BASE_SCHEMA_SQL);
  for (const name of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
    sqlite.exec(sql);
  }
}
