// Profile enhancements on /users/{id}/profile:
//  - private local Player Notes
//  - Mutual friends
//  - Last online + Friendship duration (from friend since / presence)
//  - Copy user ID
// All rendered as a themed card slotted under the profile header.

(async function () {
  if (typeof CER === "undefined") return;
  const userId = location.pathname.match(/\/users\/(\d+)\/profile/)?.[1];
  if (!userId) return;

  let me = null;
  try {
    me = await (await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" })).json();
  } catch {
    /* not logged in — notes still work */
  }
  const isSelf = String(me?.id) === userId;

  // anchor under the names block (the profile header)
  const anchor = await CER.waitFor(
    () => [...document.querySelectorAll("h1, [class*='profile-name'], [class*='profile-display']")].find((h) => h.offsetParent),
    20000
  ).catch(() => null);
  if (!anchor || document.querySelector(".cer-psocial")) return;

  const card = CER.el("div", "cer-psocial");

  // --- chips row: copy id, last online, friendship ---
  const chips = CER.el("div", "cer-psocial-chips");

  const idChip = CER.el("button", "cer-psocial-chip", "Copy ID: " + userId);
  idChip.addEventListener("click", () => {
    navigator.clipboard?.writeText(userId).catch(() => {});
    idChip.textContent = "Copied!";
    setTimeout(() => (idChip.textContent = "Copy ID: " + userId), 1400);
  });
  chips.appendChild(idChip);
  card.appendChild(chips);

  const j = (url, method, body) =>
    method
      ? CER.bgFetch(url, method, body).then((r) => r.data)
      : fetch(url, { credentials: "include" }).then((r) => r.json()).catch(() => null);

  // presence → last online (best effort; Roblox has trimmed this field)
  if (!isSelf) {
    j("https://presence.roblox.com/v1/presence/users", "POST", { userIds: [Number(userId)] }).then((p) => {
      const pr = p?.userPresences?.[0];
      if (!pr) return;
      const TYPES = { 0: "Offline", 1: "Online", 2: "In game", 3: "In Studio" };
      let text = TYPES[pr.userPresenceType] ?? "";
      if (pr.userPresenceType === 0 && pr.lastOnline) {
        text = "Last online " + new Date(pr.lastOnline).toLocaleDateString();
      }
      if (text) chips.appendChild(CER.el("span", "cer-psocial-chip cer-psocial-stat", text));
    });

    // friendship duration (friends list carries no since-date, but the
    // friendship-created endpoint does when available)
    j(`https://friends.roblox.com/v1/users/${userId}/friends/statuses?userIds=${me?.id ?? 0}`).then(async () => {
      // no reliable public "friends since" — approximate via our own first-seen
      // record so the feature is honest rather than fabricated
      const KEY = "friendSince";
      const { [KEY]: since = {} } = await CER.ext.storage.local.get(KEY);
      if (me) {
        const areFriends = (await j(`https://friends.roblox.com/v1/users/${me.id}/friends`))?.data?.some?.(
          (f) => String(f.id) === userId
        );
        if (areFriends) {
          if (!since[userId]) {
            since[userId] = Date.now();
            await CER.ext.storage.local.set({ [KEY]: since });
          }
          const days = Math.floor((Date.now() - since[userId]) / 8.64e7);
          chips.appendChild(
            CER.el("span", "cer-psocial-chip cer-psocial-stat", days === 0 ? "Friends (tracked from today)" : `Friendship: ${days} day${days === 1 ? "" : "s"}`)
          );
        }
      }
    });

    // mutual friends
    if (me) {
      Promise.all([
        j(`https://friends.roblox.com/v1/users/${me.id}/friends`),
        j(`https://friends.roblox.com/v1/users/${userId}/friends`),
      ]).then(([mine, theirs]) => {
        const mineIds = new Set((mine?.data ?? []).map((f) => f.id));
        const mutuals = (theirs?.data ?? []).filter((f) => mineIds.has(f.id));
        if (mutuals.length === 0) return;
        const section = CER.el("div", "cer-psocial-mutuals");
        section.appendChild(CER.el("h3", "cer-h3", `${mutuals.length} Mutual Friend${mutuals.length === 1 ? "" : "s"}`));
        const row = CER.el("div", "cer-bf-row");
        fetch(
          "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=" + mutuals.slice(0, 20).map((m) => m.id).join(",") + "&size=150x150&format=Png&isCircular=true",
          { credentials: "include" }
        )
          .then((r) => r.json())
          .then((d) => {
            const heads = {};
            for (const it of d.data ?? []) heads[it.targetId] = it.imageUrl;
            for (const m of mutuals.slice(0, 20)) {
              const tile = CER.el("a", "cer-bf-tile");
              tile.href = "https://www.roblox.com/users/" + m.id + "/profile";
              const img = CER.el("img", "cer-bf-avatar");
              img.src = heads[m.id] ?? "";
              tile.appendChild(img);
              tile.appendChild(CER.el("span", "cer-bf-name", m.displayName || m.name));
              row.appendChild(tile);
            }
          })
          .catch(() => {});
        section.appendChild(row);
        card.appendChild(section);
      });
    }
  }

  // --- player notes (local, private) ---
  const notesWrap = CER.el("div", "cer-psocial-notes");
  notesWrap.appendChild(CER.el("h3", "cer-h3", "Private note (only you see this)"));
  const area = CER.el("textarea", "cer-psocial-note");
  area.placeholder = "Add a note about this user…";
  const { playerNotes = {} } = await CER.ext.storage.local.get("playerNotes");
  area.value = playerNotes[userId] ?? "";
  let saveTimer = null;
  area.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { playerNotes: cur = {} } = await CER.ext.storage.local.get("playerNotes");
      if (area.value.trim()) cur[userId] = area.value.trim();
      else delete cur[userId];
      await CER.ext.storage.local.set({ playerNotes: cur });
    }, 500);
  });
  notesWrap.appendChild(area);
  card.appendChild(notesWrap);

  anchor.closest("div")?.insertAdjacentElement("afterend", card) ?? anchor.insertAdjacentElement("afterend", card);
})();
