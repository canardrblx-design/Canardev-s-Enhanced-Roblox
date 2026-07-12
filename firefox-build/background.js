// Background service worker.
// Its one job: an authenticated fetch relay. Content scripts run in the page's
// origin, so POSTs to apis.roblox.com (chat send etc.) hit a CORS preflight the
// page isn't allowed to make. The worker holds our host_permissions, so it can
// fetch those hosts directly — cookies included, CSRF dance handled here.
const ext = globalThis.browser ?? globalThis.chrome;

ext.runtime.onInstalled.addListener(() => {
  console.log("Canardev's Enhanced Roblox installed");
  checkForUpdate();
  ext.storage.local.remove("regionCooldownUntil"); // clear any stale region cooldown on update
});
ext.runtime.onStartup?.addListener(checkForUpdate);

// ---- update check ----
// Compares the running version to the latest GitHub release and stashes the
// result. Only nags UNPACKED / development installs (people who load CER from a
// git clone). Store installs auto-update, so we never bother them.
const CER_REPO = "canardrblx/Canardev-s-Enhanced-Roblox";
function cerVersionOlder(current, latest) {
  const a = String(current).replace(/^v/, "").split(".").map(Number);
  const b = String(latest).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}
async function checkForUpdate() {
  try {
    // Store installs (Chrome Web Store / Firefox AMO) auto-update and get an
    // update_url injected into the runtime manifest; unpacked/git installs do
    // not. This needs no permission, unlike management.getSelf() which Firefox
    // gates behind the "management" permission.
    if (ext.runtime.getManifest().update_url) {
      await ext.storage.local.set({ cerUpdate: { available: false } });
      return;
    }
    const res = await fetch(`https://api.github.com/repos/${CER_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const latest = (await res.json())?.tag_name?.replace(/^v/, "");
    if (!latest) return;
    const current = ext.runtime.getManifest().version;
    await ext.storage.local.set({
      cerUpdate: { available: cerVersionOlder(current, latest), current, latest, checkedAt: Date.now() },
    });
  } catch {
    /* offline or rate-limited — try again next time */
  }
}

async function robloxFetch({ url, method = "GET", body }) {
  const opts = { method, credentials: "include", headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res = await fetch(url, opts);
  // CSRF: first write 403s with a token, retry once with it
  if (res.status === 403 && method !== "GET") {
    const token = res.headers.get("x-csrf-token");
    if (token) {
      opts.headers["X-CSRF-TOKEN"] = token;
      res = await fetch(url, opts);
    }
  }
  const text = await res.text();
  let data = null;
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    // Roblox's join-game-instance now streams Server-Sent Events instead of
    // returning JSON; the real payload rides in the ResponseReady event's data.
    data = cerParseSSE(text);
  } else {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
  }
  return { ok: res.ok, status: res.status, data, text: data ? undefined : text.slice(0, 500) };
}

// Pull the JSON payload out of a Server-Sent Events response: prefer the
// ResponseReady event, else the first event that carries JSON data.
function cerParseSSE(text) {
  const blocks = String(text).split(/\r?\n\r?\n/);
  const parse = (block) => {
    let ev = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      let val = i === -1 ? "" : line.slice(i + 1);
      if (val.charCodeAt(0) === 32) val = val.slice(1);
      if (field === "event") ev = val;
      else if (field === "data") dataLines.push(val);
    }
    return { ev, data: dataLines.join("\n") };
  };
  const events = blocks.map(parse).filter((e) => e.data);
  const chosen = events.find((e) => e.ev === "ResponseReady") || events[0];
  if (chosen) {
    try {
      return JSON.parse(chosen.data);
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// ---- playtime tracker ----
// The page can't see into a game, but the presence API reports OUR OWN status.
// Poll every minute; when we're in-game (presenceType 2), bank the elapsed
// time against that universe, bucketed per day. This is exactly how the
// big extensions do it — all local, no telemetry.

const POLL_MS = 60000;

ext.alarms?.create("cer-playtime", { periodInMinutes: 1 });
ext.alarms?.onAlarm.addListener((a) => {
  // never let a failed presence poll surface as an uncaught rejection (which
  // Chrome flags as a persistent service-worker error on the extensions page)
  if (a.name === "cer-playtime") tickPlaytime().catch(() => {});
});

function todayKey(now) {
  // local-date YYYY-MM-DD
  const d = new Date(now);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

let playtimeBusy = false;
async function tickPlaytime() {
  // the alarm and the settings Playtime tab can both fire this; without a lock
  // two overlapping runs read the same stale lastTick and one clobbers the
  // other's write (lost or double-counted minutes)
  if (playtimeBusy) return;
  playtimeBusy = true;
  try {
    await tickPlaytimeInner();
  } finally {
    playtimeBusy = false;
  }
}

async function tickPlaytimeInner() {
  const now = Date.now();
  const store = await ext.storage.local.get(["playtime", "playtimeState", "cerUserId"]);
  const playtime = store.playtime ?? {};
  const state = store.playtimeState ?? { lastTick: null, lastUniverse: null };

  // cache our own user id
  let userId = store.cerUserId;
  if (!userId) {
    try {
      userId = (await (await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" })).json()).id;
      if (userId) await ext.storage.local.set({ cerUserId: userId });
    } catch {
      return;
    }
  }
  if (!userId) return;

  // presence write needs the bg CSRF path
  const res = await robloxFetch({
    url: "https://presence.roblox.com/v1/presence/users",
    method: "POST",
    body: { userIds: [userId] },
  });
  const pres = res.data?.userPresences?.[0];
  const inGame = pres?.userPresenceType === 2 && pres?.universeId;

  if (inGame) {
    const uni = String(pres.universeId);
    // bank the gap since last tick (capped so a slept worker can't over-count)
    let delta = POLL_MS;
    if (state.lastTick && state.lastUniverse === uni) {
      delta = Math.min(now - state.lastTick, 2 * POLL_MS);
    }
    const day = todayKey(now);
    const entry = playtime[uni] ?? { name: pres.lastLocation || "Game", total: 0, days: {} };
    entry.name = pres.lastLocation || entry.name;
    entry.total += delta;
    entry.days[day] = (entry.days[day] ?? 0) + delta;
    // prune days older than ~14 months
    for (const k of Object.keys(entry.days)) {
      if (now - new Date(k).getTime() > 3.7e10) delete entry.days[k];
    }
    playtime[uni] = entry;
    state.lastUniverse = uni;
  } else {
    state.lastUniverse = null;
  }
  state.lastTick = now;
  await ext.storage.local.set({ playtime, playtimeState: state });
}

// Feedback webhook. The URL lives ONLY here (not in any content script), and
// the content script can only send { text } — never a URL — so it can't be
// tricked into posting elsewhere. The page can't reach Discord directly
// (Roblox CSP blocks it), so this relays it.
const FEEDBACK_WEBHOOK =
  "https://discord.com/api/webhooks/1522790720040075406/JRxhPZt8FiBZJ2cHBwpsU03873F6xWBXux2c_SsgBI1DRFTDaX-ve77OTRXNHg2g2DC4";

async function sendFeedback(text) {
  const res = await fetch(FEEDBACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: String(text).slice(0, 1900) }),
  });
  return { ok: res.ok, status: res.status };
}

// ---- preferred-region server search ----
// Find a live server in the user's chosen region by probing Roblox's own join
// endpoint one server at a time (the join response carries the server's
// coordinates). This all runs in the single background worker, so no matter how
// many tabs are open there is only ever ONE search in flight and one shared,
// persistent cooldown — a second tab can't multiply the requests.
const CER_REGIONS = {
  "us-east": { name: "US East", lat: 39.04, lon: -77.49 },
  "us-central": { name: "US Central", lat: 32.78, lon: -96.8 },
  "us-west": { name: "US West", lat: 37.77, lon: -122.42 },
  brazil: { name: "Brazil", lat: -23.55, lon: -46.63 },
  uk: { name: "UK", lat: 51.51, lon: -0.13 },
  europe: { name: "Europe", lat: 50.11, lon: 8.68 },
  india: { name: "India", lat: 19.08, lon: 72.88 },
  singapore: { name: "Singapore", lat: 1.35, lon: 103.82 },
  japan: { name: "Japan", lat: 35.68, lon: 139.69 },
  australia: { name: "Australia", lat: -33.87, lon: 151.21 },
};
function cerNearestRegion(lat, lon) {
  let best = null, bestD = Infinity;
  for (const key of Object.keys(CER_REGIONS)) {
    const r = CER_REGIONS[key];
    const dLat = ((lat - r.lat) * Math.PI) / 180, dLon = ((lon - r.lon) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat * Math.PI) / 180) * Math.cos((r.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    const d = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (d < bestD) { bestD = d; best = key; }
  }
  return best;
}
// Roblox datacenter id -> nearest CER region. Data adapted from RoValra
// (github.com/NotValra/RoValra, GPL-3.0): public/Assets/data/ServerList.json.
const CER_DATACENTERS = {
  295:"singapore",299:"us-east",302:"uk",306:"us-east",332:"us-east",335:"us-east",337:"japan",352:"europe",
  359:"india",363:"us-east",365:"us-west",366:"us-east",369:"australia",370:"us-west",372:"singapore",
  374:"us-east",375:"us-central",377:"japan",378:"europe",380:"us-west",386:"us-east",387:"us-east",388:"uk",
  390:"us-east",397:"us-west",401:"us-east",403:"us-west",404:"us-west",405:"us-west",412:"us-west",
  413:"us-west",414:"us-west",415:"us-west",416:"singapore",417:"singapore",418:"us-east",425:"japan",
  426:"us-east",427:"us-east",428:"us-east",429:"us-west",430:"singapore",431:"us-west",432:"us-east",
  433:"us-east",434:"us-east",436:"us-west",437:"uk",438:"us-east",439:"us-east",440:"singapore",
  441:"singapore",442:"us-east",447:"us-west",448:"uk",449:"uk",450:"australia",455:"singapore",456:"singapore",
  457:"europe",458:"europe",460:"us-west",462:"singapore",463:"us-east",464:"us-east",465:"singapore",
  468:"us-east",471:"australia",473:"us-east",474:"us-east",475:"us-east",476:"us-east",477:"us-east",
  478:"us-east",479:"us-east",480:"us-east",481:"us-east",482:"us-east",485:"us-east",486:"us-east",
  487:"us-east",488:"us-east",489:"us-east",490:"us-west",491:"us-east",493:"us-west",494:"us-west",
  495:"us-west",496:"us-west",497:"us-west",498:"us-east",499:"us-east",500:"us-east",501:"us-east",
  502:"us-east",503:"us-east",504:"us-east",505:"us-east",506:"us-east",507:"us-east",508:"us-east",
  509:"us-east",510:"us-east",511:"us-east",512:"europe",513:"singapore",514:"singapore",515:"singapore",
  516:"singapore",517:"singapore",518:"india",519:"india",520:"india",521:"india",522:"india",523:"us-east",
  524:"uk",525:"us-east",526:"us-east",527:"us-east",528:"us-east",529:"us-west",530:"us-east",531:"us-east",
  532:"us-east",533:"india",534:"india",535:"us-east",536:"us-east",537:"us-east",25492:"europe",25494:"europe",
  25495:"europe",25496:"europe",25497:"europe",25506:"japan",25507:"japan",25508:"japan",25509:"japan",
  25510:"japan",25512:"us-east",25513:"us-east",25514:"us-east",25515:"us-east",25516:"us-east",25517:"us-east",
  25518:"us-east",25519:"us-east",25520:"us-east",25521:"us-east",25522:"us-west",25523:"us-west",
  25524:"us-west",25525:"us-west",25526:"us-west",25527:"singapore",25528:"singapore",25529:"singapore",
  25531:"singapore",25532:"singapore",25535:"india",25536:"india",25537:"india",25538:"europe",25543:"japan",
  25544:"japan",25545:"japan",25546:"japan",25547:"japan",25548:"us-east",25774:"brazil",25775:"uk",25776:"uk",
  25777:"uk",25778:"uk",25779:"uk",25781:"uk",25782:"uk",25783:"uk",25784:"uk",25785:"us-west",25787:"us-west",
  25788:"us-west",25789:"us-west",25790:"us-west",25791:"us-west",25792:"us-west",25793:"us-west",
  25794:"us-west",25795:"us-west",25796:"brazil",25798:"australia",25804:"australia",25805:"us-west",
  25806:"us-west",25808:"us-west",25809:"brazil",25810:"brazil",25811:"us-west",25813:"india",25817:"singapore",
  25818:"us-west",25819:"us-west",25820:"us-west",25821:"us-west",25822:"us-west",25823:"us-west",25825:"japan",
  25826:"japan",25827:"japan",25828:"japan",25829:"japan",25830:"japan",25832:"japan",25833:"japan",
  25834:"japan",25835:"japan",25836:"japan",25837:"japan",25838:"japan",25839:"japan",25840:"japan",
  25841:"japan",25842:"japan",25843:"japan",25844:"japan",25845:"japan",25846:"japan",25847:"japan",
  25848:"japan",25849:"japan",25850:"japan",25851:"us-central",25853:"europe",25861:"us-west",25862:"us-east",
  25865:"japan",25866:"japan",25868:"japan",25869:"japan",25870:"japan",25871:"japan",25872:"japan",
  25873:"japan",25874:"japan",25875:"japan",25876:"japan",25877:"japan",25878:"japan",25879:"japan",
  25880:"japan",25881:"japan",25882:"japan",25883:"japan",25884:"japan",25885:"japan",25886:"japan",
  25887:"japan",25888:"japan",25889:"japan",25890:"japan",25891:"japan",25892:"japan",25893:"japan",
  25894:"japan",25895:"japan",25896:"japan",25897:"japan",25898:"japan",25899:"japan",25900:"japan",
  25905:"india",25906:"india",25908:"india",25909:"india",25910:"india",25912:"india",25913:"india",
  25914:"india",25915:"india",25916:"india",25917:"india",25918:"india",25919:"india",25920:"india",
  25921:"india",25924:"india",25925:"india",25926:"india",25928:"india",25929:"india",25930:"singapore",
  25931:"singapore",25932:"singapore",25933:"singapore",25934:"singapore",25935:"singapore",25936:"singapore",
  25937:"singapore",25938:"singapore",25939:"singapore",25940:"singapore",25941:"singapore",25942:"singapore",
  25943:"singapore",25944:"singapore",25945:"singapore",25946:"singapore",25947:"singapore",25948:"singapore",
  25949:"singapore",25950:"singapore",25951:"singapore",25952:"singapore",25953:"singapore",25954:"singapore",
  25955:"singapore",25956:"singapore",25957:"singapore",25958:"singapore",25960:"uk",26016:"us-east",
  26021:"us-east",26030:"singapore",26032:"singapore",26033:"singapore",26034:"singapore",26035:"singapore",
  26036:"singapore",26037:"singapore",26040:"us-east",26041:"us-east",26048:"us-east",26049:"us-east",
  26050:"us-east",26051:"us-east",26052:"us-east",26053:"us-east",26054:"us-east",26057:"us-east",26059:"uk",
  26060:"uk",26061:"uk",26062:"uk",26063:"uk",26064:"uk",26074:"us-west",26075:"us-west",26077:"us-east",
};

// ---- shared region cache (Cloudflare Worker) ----
// A tiny public cache of jobId -> datacenter shared by all CER users, so one
// user's probe spares everyone else's. It stores nothing personal: a server's
// random GUID, its datacenter number, and when it started. See region-worker/.
const CER_WORKER = "https://cer-region-cache.canard-rblx.workers.dev";
async function cerWorkerLookup(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    try {
      const res = await fetch(`${CER_WORKER}/v1/servers?ids=${chunk.join(",")}`);
      if (res.ok) Object.assign(out, await res.json());
    } catch { /* worker unreachable — probing below still works */ }
  }
  return out;
}
function cerWorkerReport(entries) {
  // fire and forget; the shared cache is a courtesy, never a dependency
  if (!Object.keys(entries).length) return;
  fetch(`${CER_WORKER}/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entries),
  }).catch(() => {});
}

const cerRegionCache = new Map(); // jobId -> { region, dc, claimed } (or null if unknown)
async function cerProbeRegion(placeId, jobId) {
  // the same call the client makes to join. joinScript.DataCenterId is a stable
  // integer identifying the physical datacenter, which we map straight to a
  // region; ServerClaimedTime is when the server started (drives the uptime
  // badge). The old SessionId lat/long stays only as a legacy fallback.
  const res = await robloxFetch({
    url: "https://gamejoin.roblox.com/v2/join-game-instance",
    method: "POST",
    body: { placeId: Number(placeId), gameId: jobId, gameJoinAttemptId: crypto.randomUUID() },
  });
  const js = res.data?.joinScript;
  const claimed = typeof js?.ServerClaimedTime === "number" && js.ServerClaimedTime > 0 ? Math.round(js.ServerClaimedTime) : null;
  const dcId = js?.DataCenterId;
  if (dcId != null && CER_DATACENTERS[dcId]) return { region: CER_DATACENTERS[dcId], dc: dcId, claimed };
  const sess = js?.SessionId;
  if (typeof sess === "string" && !sess.startsWith("http")) {
    try {
      const coords = JSON.parse(sess);
      if (typeof coords.Latitude === "number" && typeof coords.Longitude === "number") {
        return { region: cerNearestRegion(coords.Latitude, coords.Longitude), dc: null, claimed };
      }
    } catch {}
  }
  return null;
}

// Resolve a batch of jobIds to regions: memory -> shared cache -> live probes
// (throttled, capped at maxProbes), reporting fresh finds back for everyone.
// stopWhen(id, region) lets a caller bail as soon as it sees what it wants.
async function cerRegionDetails(placeId, ids, maxProbes, onProgress, stopWhen) {
  const known = {}; // jobId -> { region, claimed }
  const misses = [];
  for (const id of ids) {
    const c = cerRegionCache.get(id);
    if (c !== undefined) { if (c) known[id] = { region: c.region, claimed: c.claimed }; }
    else misses.push(id);
  }
  if (misses.length) {
    const fromWorker = await cerWorkerLookup(misses);
    for (const [id, v] of Object.entries(fromWorker)) {
      const region = CER_DATACENTERS[v.dc] ?? null;
      const entry = region ? { region, dc: v.dc, claimed: v.claimed ?? null } : null;
      cerRegionCache.set(id, entry);
      if (entry) known[id] = { region: entry.region, claimed: entry.claimed };
    }
  }
  if (stopWhen) for (const id of ids) if (known[id] && stopWhen(id, known[id].region)) return { known, probed: 0 };
  const unknown = ids.filter((id) => cerRegionCache.get(id) === undefined);
  let probes = 0;
  const fresh = {};
  for (const id of unknown) {
    if (probes >= maxProbes) break;
    probes++;
    try { onProgress?.(probes, Math.min(maxProbes, unknown.length)); } catch {}
    let info = null;
    try { info = await cerProbeRegion(placeId, id); } catch { /* skip */ }
    cerRegionCache.set(id, info);
    if (info) {
      known[id] = { region: info.region, claimed: info.claimed };
      if (info.dc) fresh[id] = { dc: info.dc, claimed: info.claimed };
      if (stopWhen && stopWhen(id, info.region)) break;
    }
    await new Promise((r) => setTimeout(r, 400)); // throttle between probes
  }
  cerWorkerReport(fresh);
  return { known, probed: probes };
}

// ---- region ping ----
// Latency from THIS user to each region, measured against AWS endpoints that
// sit in (or next to) Roblox's datacenter cities. no-cors: we only time the
// round trip, never read the response. us-central has no AWS region, so Ohio
// stands in as the nearest approximation.
const CER_PING_HOSTS = {
  "us-east": "dynamodb.us-east-1.amazonaws.com",
  "us-central": "dynamodb.us-east-2.amazonaws.com",
  "us-west": "dynamodb.us-west-1.amazonaws.com",
  brazil: "dynamodb.sa-east-1.amazonaws.com",
  uk: "dynamodb.eu-west-2.amazonaws.com",
  europe: "dynamodb.eu-central-1.amazonaws.com",
  india: "dynamodb.ap-south-1.amazonaws.com",
  singapore: "dynamodb.ap-southeast-1.amazonaws.com",
  japan: "dynamodb.ap-northeast-1.amazonaws.com",
  australia: "dynamodb.ap-southeast-2.amazonaws.com",
};
let cerPingCache = { at: 0, data: null };
async function cerPingRegions() {
  if (cerPingCache.data && Date.now() - cerPingCache.at < 10 * 60e3) return cerPingCache.data;
  const one = async (host) => {
    const t0 = performance.now();
    try { await fetch("https://" + host + "/", { mode: "no-cors", cache: "no-store" }); } catch { return null; }
    return performance.now() - t0;
  };
  const measure = async (host) => {
    await one(host); // warm-up: absorbs DNS + TLS setup
    const a = await one(host);
    const b = await one(host);
    const vals = [a, b].filter((x) => x != null);
    return vals.length ? Math.round(Math.min(...vals)) : null;
  };
  const keys = Object.keys(CER_PING_HOSTS);
  const results = await Promise.all(keys.map((k) => measure(CER_PING_HOSTS[k])));
  const data = {};
  keys.forEach((k, i) => { if (results[i] != null) data[k] = results[i]; });
  cerPingCache = { at: Date.now(), data };
  return data;
}

const CER_REGION_MAX_PROBES = 15;
async function cerFindRegionServer(placeId, regionKey, onProgress) {
  const listRes = await robloxFetch({
    url: `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&excludeFullGames=true`,
    method: "GET",
  });
  const servers = (listRes.data?.data ?? []).filter((s) => s && s.id && s.playing < s.maxPlayers);
  if (servers.length === 0) return { empty: true }; // nothing to search (e.g. a game with no players)
  const ids = servers.map((s) => s.id);
  const { known, probed } = await cerRegionDetails(placeId, ids, CER_REGION_MAX_PROBES, onProgress, (_id, region) => region === regionKey);
  const match = ids.find((id) => known[id]?.region === regionKey);
  if (match) return { jobId: match };
  return { probed, detected: Object.keys(known).length };
}
let cerRegionBusy = false;
const CER_REGION_COOLDOWN_MS = 15 * 60 * 1000;
async function cerRegionJoin(placeId, regionKey, onProgress) {
  if (!CER_REGIONS[regionKey]) return { error: "badregion" };
  const { regionCooldownUntil = 0 } = await ext.storage.local.get("regionCooldownUntil");
  if (Date.now() < regionCooldownUntil) return { error: "cooldown", until: regionCooldownUntil };
  if (cerRegionBusy) return { error: "busy" }; // one search at a time across all tabs
  cerRegionBusy = true;
  try {
    const r = await cerFindRegionServer(placeId, regionKey, onProgress);
    if (r.jobId) return { ok: true, jobId: r.jobId };
    if (r.empty) return { error: "empty" }; // no servers to search — caller just joins normally, NO cooldown
    let until = 0;
    if (r.probed >= CER_REGION_MAX_PROBES) {
      // exhausted the live-probe budget -> cooldown. A cache-only miss costs
      // almost nothing, so searching again right away stays allowed.
      until = Date.now() + CER_REGION_COOLDOWN_MS;
      await ext.storage.local.set({ regionCooldownUntil: until });
    }
    return { error: "notfound", until, probed: r.probed, detected: r.detected };
  } finally {
    cerRegionBusy = false;
  }
}
// streaming port: the content script gets live "N/15" progress plus the result
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== "region-join") return;
  port.onMessage.addListener((msg) => {
    if (msg?.cer !== "start") return;
    cerRegionJoin(String(msg.placeId), msg.region, (n, total) => {
      try { port.postMessage({ progress: n, total }); } catch {}
    }).then(
      (res) => { try { port.postMessage({ done: true, ...res }); } catch {} },
      () => { try { port.postMessage({ done: true, error: "failed" }); } catch {} }
    );
  });
});

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cer === "playtime-tick") {
    tickPlaytime().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.cer === "check-update") {
    checkForUpdate().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.cer === "region-ping") {
    cerPingRegions().then((data) => sendResponse({ ok: true, pings: data }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.cer === "region-details") {
    const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 100) : [];
    // if a region-join search is mid-flight, stay lookup-only so we never stack probes
    const probes = cerRegionBusy ? 0 : Math.min(Number(msg.probe) || 0, 15);
    cerRegionDetails(String(msg.placeId), ids, probes).then(
      (r) => sendResponse({ ok: true, known: r.known, probed: r.probed }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (msg?.cer === "region-join") {
    cerRegionJoin(String(msg.placeId), msg.region).then(sendResponse, () => sendResponse({ error: "failed" }));
    return true;
  }
  if (msg?.cer === "feedback") {
    sendFeedback(msg.text).then(sendResponse, (e) => sendResponse({ ok: false, status: 0, error: String(e) }));
    return true;
  }
  if (msg?.cer !== "fetch") return false;
  // only same-site hosts, ever
  try {
    if (!/^https:\/\/([a-z0-9-]+\.)?roblox\.com\//i.test(msg.url)) {
      sendResponse({ ok: false, status: 0, error: "blocked host" });
      return true;
    }
  } catch {
    sendResponse({ ok: false, status: 0, error: "bad url" });
    return true;
  }
  robloxFetch(msg).then(sendResponse, (e) => sendResponse({ ok: false, status: 0, error: String(e) }));
  return true; // async response
});
