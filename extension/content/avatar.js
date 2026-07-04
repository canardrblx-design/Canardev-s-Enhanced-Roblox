// CER Avatar Editor (beta) — replaces the avatar page interface.
// Wearing uses avatar v2 set-wearing-assets (stacks accessories beyond the
// UI limits). Equip requests run through a serial queue with optimistic UI
// (rapid clicks used to race each other and drop changes). The preview
// re-downloads the render with cache:'reload' — Roblox often regenerates
// the image BEHIND THE SAME URL, which is why swapping src never updated.

(async function () {
  if (typeof CER === "undefined") return;
  const settings = await CER.get();
  if (!settings.features.avatarEditor) return;

  const CATEGORIES = [
    { label: "Characters", characters: true },
    {
      label: "Accessories",
      sub: [
        ["Hats", 8],
        ["Hair", 41],
        ["Face", 42],
        ["Neck", 43],
        ["Shoulder", 44],
        ["Front", 45],
        ["Back", 46],
        ["Waist", 47],
      ],
    },
    {
      label: "Shirts",
      sub: [
        ["Classic", 11],
        ["Layered", 65],
        ["Jackets (layered)", 67],
        ["Sweaters (layered)", 68],
      ],
    },
    {
      label: "Pants",
      sub: [
        ["Classic", 12],
        ["Layered", 66],
        ["Shorts (layered)", 69],
        ["Skirts (layered)", 72],
      ],
    },
    {
      label: "T-Shirts",
      sub: [
        ["Classic", 2],
        ["Layered", 64],
      ],
    },
    { label: "Shoes", type: [70, 71] },
    { label: "Faces", type: 18 },
    { label: "Animations", animations: true },
    { label: "Scale", scale: true },
  ];

  let me = null;
  try {
    me = await (await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" })).json();
  } catch {
    return;
  }
  if (!me?.id) return;

  const host = await CER.waitFor(() => document.querySelector("#avatar-web-app"), 20000).catch(() => null);
  if (!host) return;

  // ---- take over the page (reversible) ----

  let active = true;
  const root = CER.el("div", "cer-avatar-inline");

  function hideNative() {
    for (const child of host.children) {
      if (child !== root && child.style.display !== "none") {
        child.dataset.cerHidden = "1";
        child.style.display = "none";
      }
    }
  }
  hideNative();
  host.appendChild(root);
  new MutationObserver(() => {
    if (active) hideNative();
  }).observe(host, { childList: true });

  // ---- worn state + serial equip queue ----

  // declared up top: renderWearing() (awaited mid-file) reads this cache, so
  // a bottom-of-file `const` would be in the temporal dead zone and throw,
  // killing the editor right after the preview.
  const thumbCache = {};
  let worn = new Map();
  let queue = Promise.resolve();

  function enqueue(fn) {
    queue = queue.then(fn).catch(() => {});
    return queue;
  }

  async function refreshWorn() {
    const av = await (await fetch("https://avatar.roblox.com/v1/avatar", { credentials: "include" })).json();
    worn = new Map((av.assets ?? []).map((a) => [a.id, a]));
  }

  async function setWearing() {
    const assets = [...worn.values()].map((a) => (a.meta ? { id: a.id, meta: a.meta } : { id: a.id }));
    const res = await CER.robloxWrite("https://avatar.roblox.com/v2/avatar/set-wearing-assets", "POST", { assets });
    // re-sync from the server so meta-bearing assets (faces, adjustable layered
    // items) carry their real meta on the next write — a freshly-clicked tile
    // only knows {id, name}, and sending that repeatedly would drop the meta.
    if (res?.ok) await refreshWorn().catch(() => {});
    return res?.ok;
  }

  // ---- emotes (separate API — set-wearing-assets ignores them) ----
  // Equipped emotes live in numbered slots 1–8. Equipping fills the first free
  // slot; when all 8 are taken we unequip the first (lowest slot) and reuse it.
  let emotes = new Map(); // assetId -> position

  async function refreshEmotes() {
    try {
      const list = await (await fetch("https://avatar.roblox.com/v1/emotes", { credentials: "include" })).json();
      emotes = new Map((Array.isArray(list) ? list : []).map((e) => [e.assetId, e.position]));
    } catch {
      /* keep old state */
    }
  }

  async function toggleEmote(assetId) {
    if (emotes.has(assetId)) {
      const res = await CER.robloxWrite(`https://avatar.roblox.com/v1/emotes/${assetId}`, "DELETE");
      if (res?.ok) emotes.delete(assetId);
      return res?.ok;
    }
    const used = new Set(emotes.values());
    let slot = 0;
    for (let p = 1; p <= 8; p++) {
      if (!used.has(p)) {
        slot = p;
        break;
      }
    }
    if (!slot) {
      // full: unequip the first (lowest-position) emote, reuse its slot
      let firstId = null,
        firstPos = 9;
      for (const [id, pos] of emotes) {
        if (pos < firstPos) {
          firstPos = pos;
          firstId = id;
        }
      }
      const del = await CER.robloxWrite(`https://avatar.roblox.com/v1/emotes/${firstId}`, "DELETE");
      if (!del?.ok) return false;
      emotes.delete(firstId);
      slot = firstPos;
    }
    const res = await CER.robloxWrite(`https://avatar.roblox.com/v1/emotes/${assetId}/${slot}`, "POST", {});
    if (res?.ok) emotes.set(assetId, slot);
    return res?.ok;
  }

  await refreshWorn();
  refreshEmotes();

  // ---- header ----

  const head = CER.el("div", "cer-avatar-head");
  head.appendChild(CER.el("h1", "cer-avatar-title", "Avatar Editor"));
  const classic = CER.el("button", "cer-profile-btn", "Use classic editor");
  classic.addEventListener("click", () => {
    active = false;
    root.remove();
    for (const child of host.querySelectorAll('[data-cer-hidden="1"]')) child.style.display = "";
  });
  head.appendChild(classic);
  root.appendChild(head);

  // ---- preview (cache-busting blob refresh) ----

  const preview = CER.el("div", "cer-avatar-preview");
  const img = CER.el("img", "cer-avatar-preview-img");
  img.alt = me.displayName;
  preview.appendChild(img);
  const refreshBtn = CER.el("button", "cer-profile-btn cer-avatar-refresh", "↻ Refresh preview");
  refreshBtn.addEventListener("click", () => pollPreview());
  preview.appendChild(refreshBtn);
  root.appendChild(preview);

  let blobUrl = null;
  let lastThumbUrl = ""; // regenerated thumbnails get a NEW hash URL — that's
  // the reliable "it updated" signal (re-downloading the old URL isn't)
  async function loadPreviewImage() {
    try {
      const r = await fetch(
        `https://thumbnails.roblox.com/v1/users/avatar?userIds=${me.id}&size=720x720&format=Png&isCircular=false`,
        { credentials: "include", cache: "no-store" }
      );
      const d = (await r.json()).data?.[0];
      if (!d?.imageUrl || d.state === "Pending") return false;
      const changed = d.imageUrl !== lastThumbUrl;
      if (!changed && img.src) return false;
      lastThumbUrl = d.imageUrl;
      const imgRes = await fetch(d.imageUrl, { cache: "reload" });
      const fresh = URL.createObjectURL(await imgRes.blob());
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = fresh;
      img.src = fresh;
      return true;
    } catch {
      return false; /* keep old preview */
    }
  }
  await loadPreviewImage();

  let pollToken = 0;
  function pollPreview() {
    const token = ++pollToken;
    img.classList.add("cer-avatar-preview-stale");
    CER.robloxWrite("https://avatar.roblox.com/v1/avatar/redraw-thumbnail", "POST", {}).catch(() => {});
    // poll until the thumbnail URL hash actually changes (regen done) — up to
    // ~18s. The old 4-try loop gave up before slow regens finished, which is
    // why the preview "never refreshed".
    let tries = 0;
    const tick = async () => {
      if (token !== pollToken) return;
      tries++;
      const updated = await loadPreviewImage();
      if (updated || tries >= 20) {
        img.classList.remove("cer-avatar-preview-stale");
        return;
      }
      setTimeout(tick, tries < 6 ? 500 : 900); // fast at first, back off after
    };
    setTimeout(tick, 400);
  }

  // ---- currently wearing ----

  const wearingWrap = CER.el("div", "cer-avatar-wearing");
  root.appendChild(wearingWrap);

  let wearingTimer = null;
  function scheduleRenderWearing() {
    clearTimeout(wearingTimer);
    wearingTimer = setTimeout(renderWearing, 600);
  }

  async function renderWearing() {
    wearingWrap.textContent = "";
    wearingWrap.appendChild(CER.el("h3", "cer-h3", "Currently wearing"));
    const strip = CER.el("div", "cer-avatar-strip");
    const wearable = [...worn.values()].filter(
      (a) => !a.assetType || ![24, 27, 28, 29, 30, 31, 48, 49, 50, 51, 52, 53, 54, 55, 56, 61].includes(a.assetType.id)
    );
    const thumbs = await assetThumbs(wearable.map((a) => a.id));
    for (const a of wearable) {
      const chip = CER.el("button", "cer-avatar-wornchip");
      const t = CER.el("img");
      t.src = thumbs[a.id] ?? "";
      chip.appendChild(t);
      chip.appendChild(CER.el("span", "", a.name ?? String(a.id)));
      chip.title = "Remove";
      chip.addEventListener("click", () => {
        worn.delete(a.id);
        chip.remove();
        grid.querySelectorAll(".cer-avatar-item-worn").forEach((el) => {
          if (Number(el.dataset.assetId) === a.id) el.classList.remove("cer-avatar-item-worn");
        });
        enqueue(async () => {
          await setWearing();
          pollPreview();
        });
      });
      strip.appendChild(chip);
    }
    if (wearable.length === 0) strip.appendChild(CER.el("p", "cer-hint", "Nothing wearable equipped."));
    wearingWrap.appendChild(strip);
  }
  await renderWearing();

  // ---- tabs + sub-dropdown + grid ----

  const tabs = CER.el("div", "cer-avatar-tabs");
  const subRow = CER.el("div", "cer-avatar-subrow");
  const grid = CER.el("div", "cer-avatar-grid");
  root.appendChild(tabs);
  root.appendChild(subRow);
  root.appendChild(grid);

  let loadSeq = 0; // invalidates in-flight loads when the view changes

  function openTab(cat) {
    subRow.textContent = "";
    if (cat.characters) {
      subRow.appendChild(
        CER.dropdown(
          [
            ["owned", "Owned characters"],
            ["created", "Created characters"],
          ],
          "owned",
          (v) => (v === "owned" ? loadBundles("BodyParts") : loadOutfits())
        )
      );
      loadBundles("BodyParts");
    } else if (cat.animations) {
      subRow.appendChild(
        CER.dropdown(
          [
            ["packs", "Animation packs"],
            ["emotes", "Emotes"],
          ],
          "packs",
          // Roblox's bundleType for animation packs is "AvatarAnimations"
          (v) => (v === "packs" ? loadBundles("AvatarAnimations") : loadCategory(61, false, true))
        )
      );
      loadBundles("AvatarAnimations");
    } else if (cat.scale) {
      renderScale();
    } else if (cat.sub) {
      subRow.appendChild(CER.dropdown(cat.sub.map(([n, t]) => [JSON.stringify(t), n]), JSON.stringify(cat.sub[0][1]), (v) => loadCategory(JSON.parse(v))));
      loadCategory(cat.sub[0][1]);
    } else {
      loadCategory(cat.type);
    }
  }

  let activeBtn = null;
  for (const cat of CATEGORIES) {
    const b = CER.el("button", "cer-tab", cat.label);
    b.addEventListener("click", () => {
      activeBtn?.classList.remove("cer-tab-active");
      activeBtn = b;
      b.classList.add("cer-tab-active");
      openTab(cat);
    });
    tabs.appendChild(b);
    if (!activeBtn) {
      activeBtn = b;
      b.classList.add("cer-tab-active");
    }
  }

  let cursor = "";

  async function loadCategory(typeId, append, isEmote) {
    const seq = append ? loadSeq : ++loadSeq;
    if (!append) {
      grid.textContent = "";
      cursor = "";
    }
    const loading = CER.el("p", "cer-hint", "Loading…");
    grid.appendChild(loading);
    try {
      if (isEmote) await refreshEmotes(); // tiles show live equipped state
      const typeIds = Array.isArray(typeId) ? typeId : [typeId];
      let items = [];
      let nextCursor = "";
      for (const t of typeIds) {
        const url =
          `https://inventory.roblox.com/v2/users/${me.id}/inventory/${t}?limit=50&sortOrder=Desc` +
          (cursor && typeIds.length === 1 ? "&cursor=" + encodeURIComponent(cursor) : "");
        const pageRes = await fetch(url, { credentials: "include" });
        if (!pageRes.ok) throw new Error("inventory " + pageRes.status);
        const page = await pageRes.json();
        items = items.concat(page.data ?? []);
        if (typeIds.length === 1) nextCursor = page.nextPageCursor ?? "";
      }
      loading.remove();
      if (seq !== loadSeq) return;
      const thumbs = await assetThumbs(items.map((i) => i.assetId));
      for (const item of items) grid.appendChild(itemTile(item, thumbs[item.assetId], isEmote));
      cursor = nextCursor;
      if (cursor) {
        const more = CER.el("button", "cer-profile-btn cer-avatar-more", "Load more");
        more.addEventListener("click", () => {
          more.remove();
          loadCategory(typeId, true, isEmote);
        });
        grid.appendChild(more);
      }
      if (items.length === 0 && !append) grid.appendChild(CER.el("p", "cer-hint", "You don't own anything here yet."));
      CER.skelDone?.("avatar"); // first category rendered — editor is usable
    } catch {
      CER.skelDone?.("avatar");
      loading.textContent = "Couldn't load items.";
    }
  }

  function itemTile(item, thumb, isEmote) {
    const name = item.assetName ?? item.name ?? String(item.assetId);
    const tile = CER.el("button", "cer-avatar-item");
    tile.dataset.assetId = item.assetId;
    const isWorn = isEmote ? emotes.has(item.assetId) : worn.has(item.assetId);
    if (isWorn) tile.classList.add("cer-avatar-item-worn");
    const t = CER.el("img");
    t.src = thumb ?? "";
    t.alt = name;
    tile.appendChild(t);
    const label = CER.el("span", "", name);
    label.title = name;
    tile.appendChild(label);

    if (isEmote) {
      // emotes use their own slot API — no set-wearing-assets, no preview change
      tile.addEventListener("click", () => {
        tile.classList.toggle("cer-avatar-item-worn");
        enqueue(async () => {
          const ok = await toggleEmote(item.assetId);
          tile.classList.toggle("cer-avatar-item-worn", emotes.has(item.assetId));
          if (!ok) tile.title = "Couldn't update emote";
        });
      });
      return tile;
    }

    // optimistic: flip the UI instantly, sync through the queue, revert on failure
    tile.addEventListener("click", () => {
      const wearing = worn.has(item.assetId);
      if (wearing) worn.delete(item.assetId);
      else worn.set(item.assetId, { id: item.assetId, name });
      tile.classList.toggle("cer-avatar-item-worn", !wearing);
      enqueue(async () => {
        const ok = await setWearing();
        if (!ok) {
          if (wearing) worn.set(item.assetId, { id: item.assetId, name });
          else worn.delete(item.assetId);
          tile.classList.toggle("cer-avatar-item-worn", wearing);
          CER.toast("Couldn't update " + name, "error");
        } else {
          CER.toast((wearing ? "Removed " : "Put on ") + name);
        }
        scheduleRenderWearing();
        pollPreview();
      });
    });
    return tile;
  }

  // ---- body scale sliders (Roblox's valid ranges; set-scales + preview poll) ----

  async function renderScale() {
    const seq = ++loadSeq;
    grid.textContent = "";
    const loading = CER.el("p", "cer-hint", "Loading…");
    grid.appendChild(loading);
    let scales;
    try {
      scales = (await (await fetch("https://avatar.roblox.com/v1/avatar", { credentials: "include" })).json()).scales;
    } catch {
      loading.textContent = "Couldn't load your scales.";
      return;
    }
    if (seq !== loadSeq || !scales) return;
    loading.remove();

    const panel = CER.el("div", "cer-scale-panel");
    grid.appendChild(panel);

    // R6 / R15 body type switch
    let curType = "R15";
    try {
      curType = (await (await fetch("https://avatar.roblox.com/v1/avatar", { credentials: "include" })).json()).playerAvatarType ?? "R15";
    } catch {}
    const typeRow = CER.el("div", "cer-scale-row");
    typeRow.appendChild(CER.el("span", "cer-scale-label", "Avatar type"));
    const typeWrap = CER.el("div", "cer-avatar-typeswitch");
    for (const type of ["R6", "R15"]) {
      const b = CER.el("button", "cer-avatar-typebtn" + (curType === type ? " cer-avatar-typebtn-on" : ""), type);
      b.addEventListener("click", async () => {
        const res = await CER.robloxWrite("https://avatar.roblox.com/v1/avatar/set-player-avatar-type", "POST", { playerAvatarType: type });
        if (res?.ok) {
          curType = type;
          for (const btn of typeWrap.children) btn.classList.toggle("cer-avatar-typebtn-on", btn.textContent === type);
          CER.toast("Switched to " + type, "success");
          pollPreview();
        } else {
          CER.toast("Couldn't switch avatar type", "error");
        }
      });
      typeWrap.appendChild(b);
    }
    typeRow.appendChild(typeWrap);
    panel.appendChild(typeRow);

    const DEFS = [
      ["height", "Height", 0.9, 1.05, "%"],
      ["width", "Width", 0.7, 1.0, "%"],
      ["head", "Head", 0.95, 1.0, "%"],
      ["proportion", "Proportions", 0, 1, ""],
      ["bodyType", "Body type", 0, 1, ""],
    ];

    let saveTimer = null;
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        // width drives depth on Roblox's own editor — mirror that
        scales.depth = scales.width;
        const res = await CER.robloxWrite("https://avatar.roblox.com/v1/avatar/set-scales", "POST", scales);
        if (res?.ok) pollPreview();
      }, 500);
    }

    for (const [key, label, min, max, unit] of DEFS) {
      const row = CER.el("div", "cer-scale-row");
      row.appendChild(CER.el("span", "cer-scale-label", label));
      const slider = CER.el("input", "cer-scale-slider");
      slider.type = "range";
      slider.min = String(min * 100);
      slider.max = String(max * 100);
      slider.value = String(Math.round((scales[key] ?? min) * 100));
      const val = CER.el("span", "cer-scale-val");
      const show = () => (val.textContent = unit === "%" ? slider.value + "%" : slider.value + "");
      show();
      slider.addEventListener("input", () => {
        scales[key] = Number(slider.value) / 100;
        show();
        scheduleSave();
      });
      row.appendChild(slider);
      row.appendChild(val);
      panel.appendChild(row);
    }
  }

  // ---- bundles (characters / animation packs), dynamic heads excluded ----

  async function loadBundles(kind) {
    const seq = ++loadSeq;
    grid.textContent = "";
    const loading = CER.el("p", "cer-hint", "Loading…");
    grid.appendChild(loading);
    try {
      const res = await fetch(`https://catalog.roblox.com/v1/users/${me.id}/bundles?limit=100&sortOrder=Desc`, {
        credentials: "include",
      });
      const bundles = ((await res.json()).data ?? []).filter((b) => String(b.bundleType) === kind);
      loading.remove();
      if (seq !== loadSeq) return;
      if (bundles.length === 0) {
        grid.appendChild(CER.el("p", "cer-hint", kind === "BodyParts" ? "You don't own any character bundles." : "You don't own any animation packs."));
        return;
      }
      let thumbs = {};
      try {
        const r = await fetch(
          "https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=" + bundles.map((b) => b.id).join(",") + "&size=150x150&format=Png",
          { credentials: "include" }
        );
        for (const d of (await r.json()).data ?? []) thumbs[d.targetId] = d.imageUrl;
      } catch {
        /* tiles render without images */
      }
      for (const bundle of bundles) {
        const tile = CER.el("button", "cer-avatar-item");
        const t = CER.el("img");
        t.src = thumbs[bundle.id] ?? "";
        tile.appendChild(t);
        const label = CER.el("span", "", bundle.name);
        label.title = bundle.name;
        tile.appendChild(label);
        tile.addEventListener("click", () => {
          const toast = CER.toast("Wearing " + bundle.name + "…");
          enqueue(async () => {
            const bundleRes = await fetch("https://catalog.roblox.com/v1/bundles/" + bundle.id + "/details", { credentials: "include" });
            if (!bundleRes.ok) { toast.textContent = "Couldn't load that bundle"; return; }
            const details = await bundleRes.json();
            const outfit = (details.items ?? []).find((i) => i.type === "UserOutfit");
            if (outfit) {
              const res = await CER.robloxWrite("https://avatar.roblox.com/v1/outfits/" + outfit.id + "/wear", "POST", {});
              await refreshWorn();
              scheduleRenderWearing();
              pollPreview();
              toast.textContent = res?.ok ? "Wore " + bundle.name : "Couldn't wear " + bundle.name;
              if (!res?.ok) toast.classList.add("cer-toast-error");
            } else {
              toast.textContent = "Couldn't wear " + bundle.name;
              toast.classList.add("cer-toast-error");
            }
          });
        });
        grid.appendChild(tile);
      }
    } catch {
      loading.textContent = "Couldn't load bundles.";
    }
  }

  // small yes/no confirmation popover anchored to a button
  function confirmMenu(anchor, message, onYes) {
    document.querySelector(".cer-confirm-pop")?.remove();
    const pop = CER.el("div", "cer-confirm-pop");
    pop.appendChild(CER.el("div", "cer-confirm-msg", message));
    const row = CER.el("div", "cer-confirm-row");
    const yes = CER.el("button", "cer-join-menu-action", "Yes");
    const no = CER.el("button", "cer-profile-btn", "Cancel");
    row.append(yes, no);
    pop.appendChild(row);
    no.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.remove();
    });
    yes.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.remove();
      onYes();
    });
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 240) + "px";
    pop.style.top = r.bottom + 6 + "px";
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener("click", () => pop.remove(), { once: true }), 0);
  }

  // ---- created characters (outfits) ----

  async function loadOutfits() {
    const seq = ++loadSeq;
    grid.textContent = "";

    // create a new character from whatever you're wearing right now
    const create = CER.el("button", "cer-join-menu-action cer-avatar-create", "＋ Save current look as a character");
    create.addEventListener("click", async () => {
      const name = prompt("Character name:", "My Character");
      if (!name) return;
      create.disabled = true;
      try {
        const av = await (await fetch("https://avatar.roblox.com/v1/avatar", { credentials: "include" })).json();
        const res = await CER.robloxWrite("https://avatar.roblox.com/v1/outfits/create", "POST", {
          name: name.slice(0, 25),
          bodyColors: av.bodyColors,
          assetIds: (av.assets ?? []).map((a) => a.id),
          scale: av.scales,
          playerAvatarType: av.playerAvatarType,
        });
        if (res?.ok) loadOutfits();
        else create.textContent = "Couldn't save. Try again";
      } finally {
        create.disabled = false;
      }
    });
    grid.appendChild(create);

    const loading = CER.el("p", "cer-hint", "Loading…");
    grid.appendChild(loading);
    try {
      const res = await fetch(`https://avatar.roblox.com/v1/users/${me.id}/outfits?page=1&itemsPerPage=50&isEditable=true`, {
        credentials: "include",
      });
      const outfits = (await res.json()).data ?? [];
      loading.remove();
      if (seq !== loadSeq) return;
      if (outfits.length === 0) {
        grid.appendChild(CER.el("p", "cer-hint", "No saved characters yet."));
        return;
      }
      let thumbs = {};
      try {
        const r = await fetch(
          "https://thumbnails.roblox.com/v1/users/outfits?userOutfitIds=" + outfits.map((o) => o.id).join(",") + "&size=150x150&format=Png",
          { credentials: "include" }
        );
        for (const d of (await r.json()).data ?? []) thumbs[d.targetId] = d.imageUrl;
      } catch {
        /* tiles render without images */
      }
      for (const outfit of outfits) {
        const tile = CER.el("button", "cer-avatar-item");
        const t = CER.el("img");
        t.src = thumbs[outfit.id] ?? "";
        tile.appendChild(t);
        const label = CER.el("span", "", outfit.name);
        label.title = outfit.name;
        tile.appendChild(label);
        tile.addEventListener("click", () => {
          const toast = CER.toast("Wearing " + outfit.name + "…");
          enqueue(async () => {
            const res = await CER.robloxWrite("https://avatar.roblox.com/v1/outfits/" + outfit.id + "/wear", "POST", {});
            await refreshWorn();
            scheduleRenderWearing();
            pollPreview();
            toast.textContent = res?.ok ? "Wore " + outfit.name : "Couldn't wear " + outfit.name;
            if (!res?.ok) toast.classList.add("cer-toast-error");
          });
        });

        // update (overwrite with current look) + delete controls
        const controls = CER.el("div", "cer-outfit-controls");
        const upd = CER.el("button", "cer-outfit-btn");
        upd.appendChild(CER.svg("refresh", 16));
        upd.title = "Update to current look";
        upd.addEventListener("click", (e) => {
          e.stopPropagation();
          confirmMenu(upd, "Update “" + outfit.name + "” to your current look?", () =>
            enqueue(async () => {
              const cur = await (await fetch("https://avatar.roblox.com/v1/avatar", { credentials: "include" })).json();
              const res = await CER.robloxWrite("https://avatar.roblox.com/v1/outfits/" + outfit.id, "POST", {
                name: outfit.name,
                bodyColors: cur.bodyColors,
                assetIds: (cur.assets ?? []).map((a) => a.id),
                scale: cur.scales,
                playerAvatarType: cur.playerAvatarType,
              });
              CER.toast(res?.ok ? "Updated " + outfit.name : "Couldn't update", res?.ok ? "success" : "error");
            })
          );
        });
        const del = CER.el("button", "cer-outfit-btn cer-outfit-del");
        del.appendChild(CER.svg("trash", 16));
        del.title = "Delete character";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          confirmMenu(del, "Delete “" + outfit.name + "”? This can't be undone.", () =>
            enqueue(async () => {
              const res = await CER.robloxWrite("https://avatar.roblox.com/v1/outfits/" + outfit.id + "/delete", "POST", {});
              if (res?.ok) tile.remove();
              CER.toast(res?.ok ? "Deleted " + outfit.name : "Couldn't delete", res?.ok ? "success" : "error");
            })
          );
        });
        controls.append(upd, del);
        tile.appendChild(controls);
        grid.appendChild(tile);
      }
    } catch {
      loading.textContent = "Couldn't load characters.";
    }
  }

  // ---- cached asset thumbnails (thumbCache declared at top) ----

  async function assetThumbs(ids) {
    const missing = ids.filter((id) => !thumbCache[id]);
    if (missing.length) {
      try {
        const r = await fetch(
          "https://thumbnails.roblox.com/v1/assets?assetIds=" + missing.join(",") + "&size=110x110&format=Png",
          { credentials: "include" }
        );
        for (const d of (await r.json()).data ?? []) thumbCache[d.targetId] = d.imageUrl;
      } catch {
        /* fall through with what we have */
      }
    }
    const map = {};
    for (const id of ids) map[id] = thumbCache[id];
    return map;
  }

  openTab(CATEGORIES[0]);
})();
