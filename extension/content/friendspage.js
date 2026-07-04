// Redesigned Friends page (/users/friends) — clean grid of friend cards with
// presence, plus a Requests tab with accept/decline. Replaces the native UI
// (features.friendsPage).

(async function () {
  if (typeof CER === "undefined") return;
  if (!location.pathname.startsWith("/users/friends")) return;
  const settings = await CER.get();
  if (!settings.features.friendsPage) return;

  let me = null;
  try {
    me = await (await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" })).json();
  } catch {
    return;
  }
  if (!me?.id) return;

  const host = await CER.waitFor(() => document.querySelector("#content, main"), 20000).catch(() => null);
  if (!host) return;

  const root = CER.el("div", "cer-page");
  for (const child of host.children) child.style.display = "none";
  host.appendChild(root);
  new MutationObserver(() => {
    for (const child of host.children) {
      if (child !== root && child.style.display !== "none") child.style.display = "none";
    }
  }).observe(host, { childList: true });

  const head = CER.el("div", "cer-avatar-head");
  head.appendChild(CER.el("h1", "cer-avatar-title", "Friends"));
  root.appendChild(head);

  const tabs = CER.el("div", "cer-gp-tabs");
  const body = CER.el("div");
  root.appendChild(tabs);
  root.appendChild(body);

  let activeTab = null;
  for (const name of ["Friends", "Requests"]) {
    const tab = CER.el("button", "cer-tab", name);
    tab.addEventListener("click", () => {
      activeTab?.classList.remove("cer-tab-active");
      activeTab = tab;
      tab.classList.add("cer-tab-active");
      name === "Friends" ? renderFriends() : renderRequests();
    });
    tabs.appendChild(tab);
    if (!activeTab) {
      activeTab = tab;
      tab.classList.add("cer-tab-active");
    }
  }

  const PRESENCE = { 0: ["Offline", ""], 1: ["Online", "cer-presence-online"], 2: ["In game", "cer-presence-game"], 3: ["In Studio", "cer-presence-studio"] };

  async function getHeads(ids) {
    if (ids.length === 0) return {};
    try {
      const r = await fetch(
        "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=" + ids.join(",") + "&size=150x150&format=Png&isCircular=false",
        { credentials: "include" }
      );
      const map = {};
      for (const d of (await r.json()).data ?? []) map[d.targetId] = d.imageUrl;
      return map;
    } catch {
      return {};
    }
  }

  async function renderFriends() {
    body.textContent = "";
    body.appendChild(CER.skelGrid(8, 150, 150));
    let friends = [];
    try {
      friends = (await (await fetch(`https://friends.roblox.com/v1/users/${me.id}/friends`, { credentials: "include" })).json()).data ?? [];
    } catch {
      body.textContent = "Couldn't load friends.";
      return;
    }
    const ids = friends.map((f) => f.id);
    // the friends list now returns empty name/displayName — backfill from the
    // users endpoint (batched)
    try {
      const res = await CER.robloxWrite("https://users.roblox.com/v1/users", "POST", { userIds: ids, excludeBannedUsers: false });
      const byId = {};
      for (const u of (await res.json()).data ?? []) byId[u.id] = u;
      for (const f of friends) {
        if (byId[f.id]) {
          f.name = byId[f.id].name;
          f.displayName = byId[f.id].displayName;
        }
      }
    } catch {
      /* names stay as-is */
    }
    let presence = {};
    try {
      const res = await CER.robloxWrite("https://presence.roblox.com/v1/presence/users", "POST", { userIds: ids });
      for (const p of (await res.json()).userPresences ?? []) presence[p.userId] = p;
    } catch {
      /* cards render without presence */
    }
    const heads = await getHeads(ids);

    body.textContent = "";
    if (friends.length === 0) {
      body.appendChild(CER.el("p", "cer-hint", "No friends yet."));
      return;
    }
    // online first
    friends.sort((a, b) => (presence[b.id]?.userPresenceType ?? 0) - (presence[a.id]?.userPresenceType ?? 0));

    const grid = CER.el("div", "cer-friend-grid");
    for (const f of friends) {
      const p = presence[f.id];
      const [label, cls] = PRESENCE[p?.userPresenceType ?? 0] ?? PRESENCE[0];
      const card = CER.el("div", "cer-friend-card");
      const link = CER.el("a", "cer-friend-link");
      link.href = "https://www.roblox.com/users/" + f.id + "/profile";
      const img = CER.el("img", "cer-friend-avatar " + cls);
      img.src = heads[f.id] ?? "";
      link.appendChild(img);
      link.appendChild(CER.el("div", "cer-friend-name", f.displayName || f.name));
      const status = CER.el("div", "cer-friend-status " + cls, p?.userPresenceType === 2 && p?.lastLocation ? p.lastLocation : label);
      link.appendChild(status);
      card.appendChild(link);

      // same card layout as requests — Chat + Unfriend (matching roundedness)
      const row = CER.el("div", "cer-friend-actions");
      const chat = CER.el("button", "cer-friend-btn cer-friend-btn-primary", "Chat");
      chat.addEventListener("click", () => {
        if (CER.toggleChat) CER.toggleChat();
        else location.href = "https://www.roblox.com/my/messages";
      });
      const unfriend = CER.el("button", "cer-friend-btn cer-friend-btn-danger", "Unfriend");
      unfriend.addEventListener("click", async () => {
        if (!unfriend.dataset.arm) {
          unfriend.dataset.arm = "1";
          unfriend.textContent = "Sure?";
          setTimeout(() => {
            delete unfriend.dataset.arm;
            unfriend.textContent = "Unfriend";
          }, 3000);
          return;
        }
        await CER.robloxWrite(`https://friends.roblox.com/v1/users/${f.id}/unfriend`, "POST", {}).catch(() => {});
        card.remove();
      });
      row.appendChild(chat);
      row.appendChild(unfriend);
      card.appendChild(row);
      grid.appendChild(card);
    }
    body.appendChild(grid);
    CER.skelDone?.("friends"); // all friend cards rendered
  }

  async function renderRequests() {
    body.textContent = "";
    body.appendChild(CER.skelGrid(6, 150, 150));
    let requests = [];
    try {
      // the request inbox is /my/friends/requests, not /users/{id}/...
      requests = (await (await fetch("https://friends.roblox.com/v1/my/friends/requests?limit=50&sortOrder=Desc", { credentials: "include" })).json()).data ?? [];
    } catch {
      body.textContent = "Couldn't load requests.";
      return;
    }
    const heads = await getHeads(requests.map((r) => r.id));
    body.textContent = "";
    if (requests.length === 0) {
      body.appendChild(CER.el("p", "cer-hint", "No pending requests."));
      return;
    }

    // some request payloads omit name/displayName — backfill from user details
    const needNames = requests.filter((r) => !r.name && !r.displayName).map((r) => r.id);
    if (needNames.length) {
      try {
        const res = await CER.robloxWrite("https://users.roblox.com/v1/users", "POST", { userIds: needNames, excludeBannedUsers: false });
        const byId = {};
        for (const u of (await res.json()).data ?? []) byId[u.id] = u;
        for (const r of requests) {
          if (byId[r.id]) {
            r.name = byId[r.id].name;
            r.displayName = byId[r.id].displayName;
          }
        }
      } catch {
        /* names stay blank */
      }
    }
    const grid = CER.el("div", "cer-friend-grid");
    for (const r of requests) {
      const card = CER.el("div", "cer-friend-card");
      const link = CER.el("a", "cer-friend-link");
      link.href = "https://www.roblox.com/users/" + r.id + "/profile";
      const img = CER.el("img", "cer-friend-avatar");
      img.src = heads[r.id] ?? "";
      link.appendChild(img);
      link.appendChild(CER.el("div", "cer-friend-name", r.displayName || r.name));
      card.appendChild(link);
      const row = CER.el("div", "cer-friend-actions");
      const accept = CER.el("button", "cer-friend-btn cer-friend-btn-primary", "Accept");
      accept.addEventListener("click", async () => {
        await CER.robloxWrite(`https://friends.roblox.com/v1/users/${r.id}/accept-friend-request`, "POST", {}).catch(() => {});
        card.remove();
      });
      const decline = CER.el("button", "cer-friend-btn cer-friend-btn-danger", "Decline");
      decline.addEventListener("click", async () => {
        await CER.robloxWrite(`https://friends.roblox.com/v1/users/${r.id}/decline-friend-request`, "POST", {}).catch(() => {});
        card.remove();
      });
      row.appendChild(accept);
      row.appendChild(decline);
      card.appendChild(row);
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  renderFriends();
})();
