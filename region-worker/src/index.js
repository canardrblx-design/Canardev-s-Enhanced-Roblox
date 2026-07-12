// CER region cache — a tiny shared cache of Roblox server -> datacenter.
//
// It stores NOTHING personal. Clients send only a server's jobId (a random GUID)
// and the datacenter number they read from that server's own join response, plus
// optionally when the server started (for uptime). Any later user viewing the
// same server gets the region instantly instead of probing it again.
//
// Routes:
//   GET  /v1/servers?ids=<guid>,<guid>,...   -> { jobId: { dc, claimed } }  (known ones only)
//   POST /v1/servers  body { jobId: { dc, claimed } }  -> caches them
//
// Storage: D1 (SQLite). Rows older than the TTL are pruned by a daily cron.

const TTL_MS = 12 * 60 * 60 * 1000; // a jobId is dead well before this; keeps the table small
const MAX_IDS = 300; // per request
const isJobId = (s) => typeof s === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
const isDc = (d) => Number.isInteger(d) && d > 0 && d < 1000000;
const isClaimed = (c) => c == null || (Number.isInteger(c) && c > 1e12 && c < 1e13); // ms epoch, roughly this decade

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/v1/servers" && request.method === "GET") {
      const ids = (url.searchParams.get("ids") || "")
        .split(",").map((s) => s.trim()).filter(isJobId).slice(0, MAX_IDS);
      if (!ids.length) return json({});
      const cutoff = Date.now() - TTL_MS;
      const q = `SELECT job_id, dc_id, claimed_at FROM servers WHERE updated_at > ? AND job_id IN (${ids.map(() => "?").join(",")})`;
      const { results } = await env.DB.prepare(q).bind(cutoff, ...ids).all();
      const out = {};
      for (const r of results) out[r.job_id] = { dc: r.dc_id, claimed: r.claimed_at ?? null };
      return json(out);
    }

    if (url.pathname === "/v1/servers" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
      const now = Date.now();
      const rows = Object.entries(body)
        .map(([jobId, v]) => {
          const dc = typeof v === "number" ? v : v && v.dc;
          const claimed = v && typeof v === "object" ? v.claimed ?? null : null;
          return { jobId, dc, claimed };
        })
        .filter((r) => isJobId(r.jobId) && isDc(r.dc) && isClaimed(r.claimed))
        .slice(0, MAX_IDS);
      if (!rows.length) return json({ ok: true, wrote: 0 });
      const stmt = env.DB.prepare(
        `INSERT INTO servers (job_id, dc_id, claimed_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET dc_id = excluded.dc_id,
           claimed_at = COALESCE(excluded.claimed_at, servers.claimed_at), updated_at = excluded.updated_at`
      );
      await env.DB.batch(rows.map((r) => stmt.bind(r.jobId, r.dc, r.claimed, now)));
      return json({ ok: true, wrote: rows.length });
    }

    return json({ name: "cer-region-cache", ok: true });
  },

  // daily prune of dead rows so the table never grows unbounded
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM servers WHERE updated_at < ?").bind(Date.now() - TTL_MS).run();
  },
};
