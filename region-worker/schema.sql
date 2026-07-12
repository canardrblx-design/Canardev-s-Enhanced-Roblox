CREATE TABLE IF NOT EXISTS servers (
  job_id     TEXT PRIMARY KEY,   -- server instance GUID (ephemeral)
  dc_id      INTEGER NOT NULL,   -- Roblox datacenter id (maps to a region client-side)
  claimed_at INTEGER,            -- server start time, ms epoch (for uptime); nullable
  updated_at INTEGER NOT NULL    -- last time we saw it, ms epoch (for TTL pruning)
);
CREATE INDEX IF NOT EXISTS idx_servers_updated ON servers(updated_at);
