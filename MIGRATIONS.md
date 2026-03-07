# D1 Migrations

Use these commands from `stage5-api/`:

```bash
npm run migrations:status
npm run migrations:apply
npm run migrations:verify
```

What they do:

- `migrations:status`: reads the live `d1_migrations` ledger and compares it against files in `./migrations`
- `migrations:apply`: applies remote migrations, then prints the ledger-backed status
- `migrations:verify`: same as `migrations:status`, but exits non-zero if any local migration is still pending

Why this exists:

- `wrangler d1 migrations list` was not a reliable source of truth for this project
- the real source of truth is the `d1_migrations` table in D1

Deployment rule:

1. Run `npm run migrations:verify`
2. If anything is pending, run `npm run migrations:apply`
3. Re-run `npm run migrations:verify`
4. Only then deploy `stage5-api`
