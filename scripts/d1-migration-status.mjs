import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const migrationsDir = path.join(projectRoot, "migrations");

const args = new Set(process.argv.slice(2));
const databaseName = process.env.D1_DATABASE_NAME || "stage5_db";
const useRemote = !args.has("--local");
const failIfPending = args.has("--fail-if-pending");

function runWranglerJson(sql) {
  const wranglerArgs = [
    "wrangler",
    "d1",
    "execute",
    databaseName,
    ...(useRemote ? ["--remote"] : []),
    "--command",
    sql,
    "--json",
  ];

  const raw = execFileSync("npx", wranglerArgs, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0]?.success) {
    throw new Error(`Unexpected Wrangler D1 response: ${raw}`);
  }
  return parsed[0].results;
}

function formatAppliedAt(value) {
  return value ? String(value) : "unknown time";
}

const localMigrations = fs
  .readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const appliedRows = runWranglerJson(
  "SELECT name, applied_at FROM d1_migrations ORDER BY id"
);
const appliedByName = new Map(
  appliedRows.map((row) => [String(row.name), row.applied_at])
);

const appliedLocal = localMigrations.filter((name) => appliedByName.has(name));
const pendingLocal = localMigrations.filter((name) => !appliedByName.has(name));
const extraApplied = appliedRows
  .map((row) => String(row.name))
  .filter((name) => !localMigrations.includes(name));

console.log(
  `D1 migration status for ${databaseName} (${useRemote ? "remote" : "local"})`
);
console.log(
  `Local migrations: ${localMigrations.length}  Applied local: ${appliedLocal.length}  Pending local: ${pendingLocal.length}`
);
console.log("");

if (appliedLocal.length > 0) {
  console.log("Applied local migrations");
  for (const name of appliedLocal) {
    console.log(`- ${name} (${formatAppliedAt(appliedByName.get(name))})`);
  }
  console.log("");
}

if (pendingLocal.length > 0) {
  console.log("Pending local migrations");
  for (const name of pendingLocal) {
    console.log(`- ${name}`);
  }
  console.log("");
} else {
  console.log("Pending local migrations");
  console.log("- none");
  console.log("");
}

if (extraApplied.length > 0) {
  console.log("Applied migrations not present in ./migrations");
  for (const name of extraApplied) {
    console.log(`- ${name} (${formatAppliedAt(appliedByName.get(name))})`);
  }
  console.log("");
}

console.log(
  "Status source: d1_migrations ledger in D1, not Wrangler's pending-file display."
);

if (failIfPending && pendingLocal.length > 0) {
  process.exitCode = 1;
}
