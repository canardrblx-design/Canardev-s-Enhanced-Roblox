// Group/profile page tweaks + the charts filter row.
// - banner "un-blacker": class-agnostic repaint of black banner fades
// - group games: rebuilt from the API as a wide row (native tiles suppressed
//   every sweep — React keeps re-inserting them)
// - pill tabs (About / Games / Forums / Events...): About = description +
//   announcements only; Games = the row alone; section headings like
//   "Games"/"Events" are dropped since the tabs already say it

(async function () {
  if (typeof CER === "undefined") return;
  const settings = await CER.get();

  // ---- charts: remove the device/region filter pills ----

  if (location.pathname.startsWith("/charts")) {
    const style = document.createElement("style");
    style.textContent =
      ".filter-items-container { display: none !important; }" +
      // center the game name + rating/CCU under each chart tile. text-align alone
      // fails when the name sits in a flex row/column — so ALSO make the card
      // link/container a centered flex column and full-width the name block.
      ".game-card-container, .game-card-link, [class*='game-card-container']," +
      " [class*='game-tile-container'] {" +
      "  display: flex !important; flex-direction: column !important;" +
      "  align-items: center !important; text-align: center !important; }" +
      ".game-card-name, .game-name-title, .game-card-info, .base-metadata," +
      " .wide-game-tile-metadata, .info-metadata-container," +
      " [class*='game-card'] [class*='name'], [class*='game-tile'] [class*='name'] {" +
      "  text-align: center !important; justify-content: center !important;" +
      "  width: 100% !important; align-self: stretch !important; }";
    document.documentElement.appendChild(style);
    return;
  }

  const onGroups = () => /^\/(communities|groups)\//.test(location.pathname);
  const onProfile = () => /^\/users\/\d+\/profile/.test(location.pathname);

  // ---- banner un-blacker (groups + profiles), theme tints only ----

  function unblackBanners() {
    const preset = CER.THEMES.find((t) => t.id === settings.theme.preset);
    if (!preset || preset.native || preset.id === "" || !settings.features.theme) return;
    const flat = preset.flat ?? preset.bg;
    const BLACK = /rgba?\(0, 0, 0(?:, *(0\.[3-9]\d*|1))?\)|color\(srgb 0 0 0( \/ [\d.]+)?\)/;

    for (const el of document.querySelectorAll("div, section, span")) {
      if (el.dataset.cerUnblacked) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 250 || rect.height < 30 || rect.height > 700 || rect.top > 700) continue;
      const cs = getComputedStyle(el);
      if (BLACK.test(cs.backgroundColor)) {
        el.style.setProperty("background-color", flat, "important");
        el.dataset.cerUnblacked = "1";
      }
      if (cs.backgroundImage.includes("gradient") && BLACK.test(cs.backgroundImage)) {
        el.style.setProperty(
          "background-image",
          cs.backgroundImage
            .replace(/rgba?\(0, 0, 0(, [\d.]+)?\)/g, flat)
            .replace(/color\(srgb 0 0 0( \/ [\d.]+)?\)/g, flat),
          "important"
        );
        el.dataset.cerUnblacked = "1";
      }
    }
  }

  // ---- group games row (API-built) ----

  async function rebuildGroupGames() {
    if (!onGroups() || !settings.features.wideTiles) return;
    if (document.querySelector("[data-cer-groupgames]")) return;
    const groupId = location.pathname.match(/\/(?:communities|groups)\/(\d+)/)?.[1];
    if (!groupId) return;

    const heading = [...document.querySelectorAll("h1, h2, h3")].find((e) =>
      /^(games|experiences)$/i.test(e.textContent.trim())
    );
    if (!heading) return;

    let games = [];
    try {
      const r = await fetch(
        `https://games.roblox.com/v2/groups/${groupId}/games?accessFilter=2&limit=50&sortOrder=Desc`,
        { credentials: "include" }
      );
      games = ((await r.json()).data ?? [])
        .map((g) => ({ universeId: String(g.id), placeId: String(g.rootPlace?.id ?? ""), name: g.name ?? "Untitled" }))
        .filter((g) => g.placeId);
    } catch {
      games = [];
    }

    const grid = CER.el("div", "cer-grid cer-grid-wide");
    grid.dataset.cerGroupgames = "1";
    grid.style.display = "none"; // hidden until the Games tab is active (no About leak)
    if (games.length === 0) {
      grid.appendChild(CER.el("p", "cer-hint", "This group has no games."));
    } else {
      const universeIds = games.map((g) => g.universeId);
      const [thumbs, meta] = await Promise.all([CER.getGameThumbs(universeIds), CER.getGameMeta(universeIds)]);
      for (const game of games) {
        grid.appendChild(
          CER.buildGameCard(game, {
            wide: true,
            art: thumbs[game.universeId],
            meta: meta[game.universeId],
            features: settings.features,
          })
        );
      }
    }

    // header row ("Games" + Page controls) is redundant — the tab says it
    const headerRow = heading.parentElement;
    headerRow.dataset.cerGamesHeader = "1";
    headerRow.insertAdjacentElement("afterend", grid);
  }

  // React re-inserts native tiles and the header — keep them down, every sweep
  function suppressNativeGames() {
    const grid = document.querySelector("[data-cer-groupgames]");
    if (!grid) return;
    document.querySelector("[data-cer-games-header]")?.style.setProperty("display", "none");
    for (const child of grid.parentElement.children) {
      if (child === grid || child.dataset.cerGamesHeader) continue;
      if (child.querySelector?.('a[href*="/games/"]') && child.style.display !== "none") {
        child.style.display = "none";
      }
    }
  }

  // ---- empty announcements ----

  function hideEmptyAnnouncements() {
    for (const el of document.querySelectorAll(".group-announcements, group-announcements")) {
      if (/no announcements yet/i.test(el.textContent)) el.style.display = "none";
    }
    const none = [...document.querySelectorAll("div, section")].find(
      (e) => e.children.length <= 2 && /^no announcements yet/i.test(e.textContent.trim()) && e.offsetWidth > 200
    );
    if (none) {
      const heading = [...document.querySelectorAll("h1, h2, h3")].find((e) => /^announcements$/i.test(e.textContent.trim()));
      heading?.style.setProperty("display", "none");
      none.style.display = "none";
    }
  }

  // ---- pill tabs ----

  let groupMode = "About";
  let infoBlock = null;
  let infoHost = null;
  let groupSkelTimer = null;

  function commonAncestor(a, b) {
    let el = a;
    while (el && !el.contains(b)) el = el.parentElement;
    return el;
  }

  async function redesignGroupTabs() {
    if (!onGroups() || document.querySelector(".cer-group-tabs")) return;
    const groupId = location.pathname.match(/\/(?:communities|groups)\/(\d+)/)?.[1];
    if (!groupId) return;

    const LABELS = ["About", "Forums", "Events", "Store", "Affiliates", "Enemies"];
    const native = {};
    for (const el of document.querySelectorAll('[role="tab"], a, button')) {
      const t = el.textContent.trim();
      if (LABELS.includes(t) && el.offsetParent && !el.closest(".cer-group-tabs")) native[t] ??= el;
    }
    // proceed as long as About + at least one other tab exist (Forums, Events,
    // Store, Affiliates...) — store-only / game-less groups have no Forums
    const other = native.Forums ?? native.Events ?? native.Store ?? native.Affiliates ?? native.Enemies;
    if (!native.About || !other) return; // truly old page variant

    const strip = commonAncestor(native.About, other);
    if (!strip || strip.tagName === "BODY") return;
    strip.style.display = "none";

    const bar = CER.el("div", "cer-gp-tabs cer-group-tabs");
    strip.insertAdjacentElement("beforebegin", bar);
    // infoBlock lives right after OUR bar (a spot React never touches), so it
    // can't be wiped by re-renders — we just toggle its display by mode
    infoHost = bar;

    let description = "";
    try {
      description = (await (await fetch("https://groups.roblox.com/v1/groups/" + groupId, { credentials: "include" })).json()).description ?? "";
    } catch {
      /* About just shows announcements */
    }
    infoBlock = CER.el("div", "cer-group-info");
    infoBlock.appendChild(CER.el("h2", "cer-group-title", "Info"));
    const desc = CER.el("p", "cer-group-desc", description.trim() || "No bio yet.");
    desc.classList.toggle("cer-profile-desc-empty", !description.trim());
    infoBlock.appendChild(desc);

    // give the native Announcements section a proper title if it lacks one
    const annH = [...document.querySelectorAll("h1, h2, h3")].find((e) => /^announcements$/i.test(e.textContent.trim()));
    if (annH) annH.classList.add("cer-group-title");

    // header bio ("No bio yet" + more) moves into About
    const moreLink = [...document.querySelectorAll("a, button, span")].find(
      (e) => e.children.length === 0 && /^more$/i.test(e.textContent.trim()) && e.getBoundingClientRect().top < 700
    );
    moreLink?.parentElement?.style.setProperty("display", "none");

    // only offer the Games tab if the group actually has games
    let hasGames = false;
    try {
      const gr = await fetch(`https://games.roblox.com/v2/groups/${groupId}/games?accessFilter=2&limit=10`, { credentials: "include" });
      hasGames = ((await gr.json()).data ?? []).length > 0;
    } catch {
      /* assume none */
    }

    // only offer the Store tab if the group actually sells something (default to
    // showing it if the lookup fails, so a working store never gets hidden)
    let hasStore = true;
    try {
      const sr = await fetch(`https://catalog.roblox.com/v1/search/items?creatorTargetId=${groupId}&creatorType=2&limit=10`, { credentials: "include" });
      const sd = await sr.json();
      if (sr.ok && Array.isArray(sd.data)) hasStore = sd.data.length > 0;
    } catch {
      /* keep the tab on error */
    }

    const TABS = ["About", ...(hasGames ? ["Games"] : []), ...LABELS.slice(1).filter((l) => native[l] && (l !== "Store" || hasStore))];
    let activePill = null;
    for (const label of TABS) {
      const pill = CER.el("button", "cer-tab", label);
      pill.addEventListener("click", () => {
        activePill?.classList.remove("cer-tab-active");
        activePill = pill;
        pill.classList.add("cer-tab-active");
        groupMode = label;
        if (label === "Games" || label === "About") native.About.click();
        else native[label]?.click();
        if (label === "Forums") showForumSkeleton(bar);
        setTimeout(applyGroupMode, 350);
      });
      bar.appendChild(pill);
      if (label === "About") {
        activePill = pill;
        pill.classList.add("cer-tab-active");
      }
    }
  }

  // forums take a moment to load — show a skeleton right under our tab bar until
  // the first forum post/category renders
  function showForumSkeleton(bar) {
    document.querySelector(".cer-forum-skel")?.remove();
    const skel = CER.el("div", "cer-forum-skel");
    for (let i = 0; i < 5; i++) {
      const row = CER.el("div", "cer-skel-tile");
      row.style.height = "64px";
      row.style.width = "100%";
      row.style.marginBottom = "10px";
      skel.appendChild(row);
    }
    bar.insertAdjacentElement("afterend", skel);
    CER.waitFor(() => document.querySelector("[class*='forum-post'], [class*='forum-thread'], .group-forums-category-pill"), 8000)
      .then(() => setTimeout(() => skel.remove(), 200))
      .catch(() => skel.remove());
  }

  // The native "About" tab dumps games + announcements + top-posts together.
  // We re-slice it: reference-based so load-order races can't leak games in.
  function announcementsSection() {
    const h = [...document.querySelectorAll("h1, h2, h3")].find((e) => /^announcements$/i.test(e.textContent.trim()));
    return h ? h.closest("section, div[class*='section']") ?? h.parentElement : null;
  }

  function applyGroupMode() {
    if (!document.querySelector(".cer-group-tabs")) return;
    const grid = document.querySelector("[data-cer-groupgames]");

    // ALWAYS hide native game containers + games header + top posts + the
    // redundant "Events"/"Games" section headings (our tabs already label them)
    for (const el of document.querySelectorAll(".group-games, [data-cer-games-header], .container-header")) {
      el.style.setProperty("display", "none", "important");
    }
    for (const link of document.querySelectorAll('a[href*="/games/"]')) {
      const tile = link.closest("li, [class*='game-card'], [class*='grid-item']");
      if (tile && !grid?.contains(link)) tile.style.setProperty("display", "none", "important");
    }
    const tp = [...document.querySelectorAll("h1, h2, h3")].find((e) => /top community posts/i.test(e.textContent));
    (tp?.closest("section") ?? tp?.parentElement?.parentElement)?.style.setProperty("display", "none");
    for (const h of document.querySelectorAll("h1, h2, h3")) {
      if (/^(events|games)$/i.test(h.textContent.trim())) h.style.setProperty("display", "none");
    }

    // keep the info block attached to our own bar (React-proof), just toggle it
    if (infoBlock && infoHost && !infoHost.nextElementSibling?.classList?.contains("cer-group-info")) {
      infoHost.insertAdjacentElement("afterend", infoBlock);
    }

    const ann = announcementsSection();
    if (groupMode === "Games") {
      grid?.style.setProperty("display", "flex", "important");
      ann?.style.setProperty("display", "none", "important");
      if (infoBlock) infoBlock.style.display = "none";
    } else if (groupMode === "About") {
      grid?.style.setProperty("display", "none", "important");
      ann?.style.removeProperty("display");
      if (infoBlock) infoBlock.style.display = "";
    } else {
      grid?.style.setProperty("display", "none", "important");
      if (infoBlock) infoBlock.style.display = "none";
    }
  }

  // Class-agnostic banner fade: find the banner-sized element that paints an
  // image, mask it to TRANSPARENT at the bottom (page shows through — works on
  // any theme), and kill any color/blur fade overlay sitting over it. This is
  // the "transparency gradient, not color gradient" the user asked for.
  function maskBanners() {
    const preset = CER.THEMES.find((t) => t.id === settings.theme.preset);
    if (!preset || preset.native || preset.id === "" || !settings.features.theme) return;
    for (const el of document.querySelectorAll("div, span, img, section")) {
      if (el.dataset.cerMasked) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 600 || r.height < 150 || r.top > 500) continue;
      const cs = getComputedStyle(el);
      const hasImg = cs.backgroundImage.includes("url(") || el.tagName === "IMG";
      if (!hasImg) continue;
      el.style.setProperty("-webkit-mask-image", "linear-gradient(180deg, #000 62%, transparent 100%)", "important");
      el.style.setProperty("mask-image", "linear-gradient(180deg, #000 62%, transparent 100%)", "important");
      el.dataset.cerMasked = "1";
      // hide sibling color/blur fade overlays that would re-darken it
      for (const sib of el.parentElement?.children ?? []) {
        if (sib === el) continue;
        const sc = getComputedStyle(sib);
        if (sc.backgroundImage.includes("gradient") || /overlay|gradient|fade/i.test(sib.className)) {
          sib.style.setProperty("display", "none", "important");
        }
      }
    }
  }

  // Forum category pills: my CSS chip rule out-specifies any override I write,
  // so set the active pill's colour INLINE (inline !important beats the whole
  // cascade — the only thing that reliably wins here). Verified live.
  function themeForumPills() {
    const preset = CER.THEMES.find((t) => t.id === settings.theme.preset);
    if (!preset || preset.native || preset.id === "" || !settings.features.theme) return;
    for (const pill of document.querySelectorAll(".group-forums-category-pill")) {
      if (pill.classList.contains("active")) {
        pill.style.setProperty("background-color", preset.accent, "important");
        pill.style.setProperty("color", "#fff", "important");
      } else {
        pill.style.removeProperty("background-color");
        pill.style.removeProperty("color");
      }
    }
  }

  // SAFETY: hide (never touch) leave-group / transfer-ownership controls so
  // they can't be clicked by accident. Pure display:none on text matches —
  // this code never clicks, submits, or interacts with anything.
  // Runs on EVERY page (not just group pages) — the transfer/change-owner
  // control also lives in group Configure and the account Settings pages, and in
  // dropdowns that only render when opened. It never clicks anything.
  function protectGroups() {
    if (!settings.features.protectGroups) return;
    const DANGER = /^\s*(leave (group|community)|delete (group|community)|change (group )?owner|transfer (group )?ownership|transfer owner|change owner)\s*$/i;
    for (const el of document.querySelectorAll("a, button, li, span, div, [role='menuitem']")) {
      if (el.children.length > 1) continue; // leaf-ish only
      if (DANGER.test(el.textContent.trim())) {
        const row = el.closest("li, .dropdown-item, [role='menuitem'], .menu-item") ?? el;
        row.style.setProperty("display", "none", "important");
      }
    }
  }

  // hide the "communities can create and sell official shirts/pants…" promo box
  // Roblox shows in an empty group store
  function hideStorePromo() {
    for (const el of document.querySelectorAll("p, div, span")) {
      if (el.children.length > 1) continue;
      if (/ability to (create|crea)|create and sell (official )?(shirts|clothing)/i.test(el.textContent)) {
        (el.closest("[class*='container'], section, .stack") ?? el).style.setProperty("display", "none", "important");
      }
    }
  }

  // hide the "automatic payouts" list Roblox drops under groups you own — ugly.
  // Only ever hide the payout widget itself (a .*payout* container), NEVER climb
  // to a generic <section> — that was blanking the whole group page.
  function hideGroupPayouts() {
    for (const el of document.querySelectorAll("[class*='payout'], [class*='Payout']")) {
      const box = el.closest("[class*='payout'], [class*='Payout']") ?? el;
      // stay narrow: bail if this "box" wraps big chunks of the page
      if (box.querySelectorAll("a[href*='/games/'], .container-header").length > 1) continue;
      box.style.setProperty("display", "none", "important");
    }
  }

  // hide the forum category PAGE title (e.g. a big "Bug Reports" heading) —
  // our pills already label it, and it was picking up an odd background
  function hideForumTitle() {
    if (!onGroups()) return;
    const active = document.querySelector(".group-forums-category-pill.active");
    if (!active) return;
    const label = active.textContent.trim();
    for (const h of document.querySelectorAll("h1, h2")) {
      if (h.textContent.trim() === label && !h.closest(".cer-group-tabs")) {
        h.style.setProperty("display", "none", "important");
      }
    }
  }

  async function sweep() {
    // SAFETY runs everywhere; the rest only on group/profile pages
    protectGroups();
    hideGroupPayouts();
    hideStorePromo();
    if (!onGroups() && !onProfile()) return;
    if (onGroups()) document.body.classList.add("cer-group-page");
    unblackBanners();
    maskBanners();
    themeForumPills();
    hideForumTitle();
    hideEmptyAnnouncements();
    await rebuildGroupGames();
    suppressNativeGames();
    await redesignGroupTabs();
    applyGroupMode();
    // drop the skeleton only once the group's own content (description / tabs)
    // has actually rendered and the page has gone quiet for a beat
    if (onGroups() && document.querySelector(".cer-group-tabs")) {
      clearTimeout(groupSkelTimer);
      groupSkelTimer = setTimeout(() => CER.skelDone?.("group"), 700);
    }
  }

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(sweep, 500);
  }).observe(document.body, { childList: true, subtree: true });
  CER.onNavigate(sweep);
  await sweep();
})();
