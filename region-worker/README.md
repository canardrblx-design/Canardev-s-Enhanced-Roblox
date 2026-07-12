# CER region cache (Cloudflare Worker)

A tiny shared cache so CER users don't each have to probe every server for its
region. Stores only `jobId -> { datacenter, serverStartTime }`. No user data.

## Deploy (about 5 minutes)

You need the Cloudflare CLI: `npm i -g wrangler` then `wrangler login`.

From this folder:

```bash
# 1. create the database
wrangler d1 create cer-region-cache
#    -> copy the printed "database_id" into wrangler.toml (replace the placeholder)

# 2. create the table
wrangler d1 execute cer-region-cache --remote --file=schema.sql

# 3. ship it
wrangler deploy
```

`wrangler deploy` prints a URL like `https://cer-region-cache.<you>.workers.dev`.
Give that URL to the extension (it goes in one constant in the CER background
script). That's the whole backend.

## What it does

- `GET  /v1/servers?ids=<guid>,<guid>,...` -> `{ "<jobId>": { "dc": 25798, "claimed": 1720000000000 }, ... }` (only servers it already knows)
- `POST /v1/servers` body `{ "<jobId>": { "dc": 25798, "claimed": 1720000000000 } }` -> caches them

The datacenter id maps to a region on the extension side (bundled map), so the
worker never needs to know regions, IPs, or anything about the user.

## Cost

Free tier is 100,000 requests/day **per Cloudflare account** (shared across all
your Workers). CER batches one request per server-list view, so a niche userbase
stays far under that. If it grows, the Workers Paid plan is $5/mo for 10M requests.
