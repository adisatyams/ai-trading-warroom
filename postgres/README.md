# Aiven PostgreSQL setup

The Worker uses PostgreSQL through a Cloudflare Hyperdrive binding named
`HYPERDRIVE`. Do not put an Aiven connection URL or password in source control,
`.env` files, Wrangler variables, or logs.

## One-time setup

1. Rotate the Aiven database password: the previous connection URL was shared
   in chat and must no longer be used.
2. In Cloudflare, create a Hyperdrive configuration for the Aiven PostgreSQL
   database using the new URL, then bind it to the Worker as `HYPERDRIVE`.
   Add this configuration to `wrangler.jsonc`, replacing the placeholder with
   the ID Cloudflare returns:

   ```jsonc
   "compatibility_flags": ["nodejs_compat"],
   "hyperdrive": [
     { "binding": "HYPERDRIVE", "id": "<hyperdrive-configuration-id>" }
   ]
   ```

   Remove the `d1_databases` section when adding this binding.
3. Apply `001_initial_schema.sql` to the empty Aiven database using the Aiven
   console or `psql`. This schema includes the scanner, risk checker, position
   sizer, heartbeat, market, and legacy control-plane tables.
4. Remove the old D1 binding from the Cloudflare Worker configuration after
   the Hyperdrive binding is available.

This cutover intentionally starts with an empty database. D1 data is not
exported or copied. Keep the existing Worker deployment and D1 binding in place
until Hyperdrive is configured, the schema is applied, and the replacement has
been verified.

Trading remains disabled; the PostgreSQL connection does not add an order path.

For a database that already has `001_initial_schema.sql` applied, apply
`002_multi_timeframe_scanner.sql` before deploying the multi-timeframe Worker.
It adds per-timeframe result keys and the completed-candle snapshot table.
