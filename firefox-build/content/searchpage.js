// Tag search + discover result pages so the CSS can give Roblox's native result
// cards the CER look (rounded corners, themed surfaces, centered titles) without
// restyling those same card classes everywhere else on the site.
(function () {
  if (typeof CER === "undefined") return;
  function mark() {
    const p = location.pathname;
    const on = p.startsWith("/search") || p.startsWith("/discover");
    if (!document.body) return;
    document.body.classList.toggle("cer-search-page", on);
    // the people (users) results page keeps its title + search bar in a .top-row
    // that holds no filters, so a users-only class lets the CSS hide that whole
    // row without disturbing the games /discover filter + sort controls.
    document.body.classList.toggle("cer-search-users", on && p.startsWith("/search/users"));
    // communities has a no-keyword landing page (a tip banner + top search bar +
    // curated rows) that a class lets us clean up separately from the results.
    document.body.classList.toggle("cer-search-communities", on && p.startsWith("/search/communities"));
  }
  // People (users) search: give each result card the profile/home hero look — a
  // full-body avatar render across the top. Roblox only ships a small circular
  // headshot in the card, so we fetch the full-body render (the same thumbnail
  // the profile/home hero uses) and hide the native headshot via CSS. The real
  // profile picture is never restyled, only replaced by the render.
  function enhancePeople() {
    if (!location.pathname.startsWith("/search/users")) return;
    const cards = document.querySelectorAll(".avatar-card-container:not([data-cer-body])");
    const pending = [];
    cards.forEach((card) => {
      const link = card.querySelector("a[href*='/users/']");
      const m = link && link.href.match(/\/users\/(\d+)/);
      if (!m) return;
      card.dataset.cerBody = "1";
      // full-body render across the top
      const banner = CER.el("div", "cer-people-banner");
      const body = CER.el("img", "cer-people-body");
      body.loading = "lazy";
      banner.appendChild(body);
      card.insertBefore(banner, card.firstChild);
      // headshot (the profile picture) + names in a row overlapping the banner
      const meta = CER.el("div", "cer-people-meta");
      const head = CER.el("img", "cer-people-head");
      head.loading = "lazy";
      meta.appendChild(head);
      const cap = card.querySelector(".avatar-card-caption");
      if (cap) meta.appendChild(cap);
      banner.after(meta);
      // clicking the avatar / headshot / name opens the profile (the native card
      // has no obvious way in now); the Add-friend button is separate so it still
      // works on its own.
      const go = () => { location.href = "https://www.roblox.com/users/" + m[1] + "/profile"; };
      banner.style.cursor = "pointer";
      meta.style.cursor = "pointer";
      banner.addEventListener("click", go);
      meta.addEventListener("click", go);
      pending.push({ id: m[1], body, head });
    });
    if (!pending.length) return;
    const ids = [...new Set(pending.map((p) => p.id))];
    Promise.all([
      fetch(
        "https://thumbnails.roblox.com/v1/users/avatar?userIds=" + ids.join(",") + "&size=420x420&format=Png&isCircular=false",
        { credentials: "include" }
      ).then((r) => r.json()),
      fetch(
        "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=" + ids.join(",") + "&size=150x150&format=Png&isCircular=false",
        { credentials: "include" }
      ).then((r) => r.json()),
    ])
      .then(([bodies, heads]) => {
        const bm = {}, hm = {};
        (bodies.data || []).forEach((e) => (bm[e.targetId] = e.imageUrl));
        (heads.data || []).forEach((e) => (hm[e.targetId] = e.imageUrl));
        pending.forEach((p) => {
          if (bm[p.id]) p.body.src = bm[p.id];
          if (hm[p.id]) p.head.src = hm[p.id];
        });
      })
      .catch(() => {});
  }

  // cards stream in (async render + infinite scroll), so re-run on DOM changes,
  // debounced. enhancePeople bails instantly when we're not on the users page.
  let peopleTimer = null;
  function schedulePeople() {
    if (CER.alive && !CER.alive()) return;
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(enhancePeople, 150);
  }

  mark();
  enhancePeople();
  CER.onNavigate?.(() => { mark(); schedulePeople(); });
  new MutationObserver(schedulePeople).observe(document.documentElement, { childList: true, subtree: true });
})();
