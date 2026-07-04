// Universal settings re-skinner. Rather than rebuild each setting (which
// breaks whenever Roblox rearranges them), this tags the settings page so the
// stylesheet can modernise it generically: card-ify sections, round inputs,
// theme everything, widen the layout. Works on whatever settings Roblox ships.

(async function () {
  if (typeof CER === "undefined") return;
  const p = location.pathname;
  const onSettings =
    p.startsWith("/my/account") ||
    p.startsWith("/my/settings") ||
    p.includes("/configure") || // group / community configure pages
    /^\/(communities|groups)\/\d+\/configure/.test(p);
  if (!onSettings) return;

  // the group/community "Configure" page has a different shell (big title,
  // author line, funds, side menu). Treat it specially so it ends up looking
  // exactly like the account settings: no title, one centred pill on top.
  const isGroupCfg = p.includes("/configure");

  function tag() {
    document.body.classList.add("cer-settings-reskin");
    if (isGroupCfg) document.body.classList.add("cer-group-cfg");
    // give each settings "section" a consistent hook regardless of its class
    for (const h of document.querySelectorAll("h2, h3, [class*='section-header'], [class*='SectionHeader']")) {
      const card = h.closest("[class*='section'], [class*='Section'], .panel, [class*='container']");
      if (card && card.offsetWidth > 300 && card.offsetHeight < 2000) card.classList.add("cer-set-card");
    }
    // hide the big "Settings" page title (redundant with the sidebar item)
    for (const h1 of document.querySelectorAll("h1")) {
      if (h1.textContent.trim() === "Settings") h1.classList.add("cer-hide-settings-title");
    }
    buildDropdown();
    if (isGroupCfg) cleanGroupShell();
  }

  // Strip the Configure-page chrome and relocate the pill so the page matches
  // account settings: hide title + author + funds + "back" link, then move the
  // dropdown to the top of the content column (was a side menu).
  function cleanGroupShell() {
    const hdr = document.querySelector(".section.configure-group > .container-header");
    if (hdr) hdr.classList.add("cer-hide-settings-title");
    for (const a of document.querySelectorAll("a, button")) {
      if (/^back to (community|group)/i.test(a.textContent.trim())) a.classList.add("cer-hide-settings-title");
    }
    // the "Community/Group Funds: N" line — hide the smallest wrapper that is
    // just that line, so we don't nuke a shared container
    for (const s of document.querySelectorAll("span.ng-binding, span")) {
      if (!/^(community|group)\s*funds/i.test(s.textContent.trim())) continue;
      let n = s;
      while (
        n.parentElement &&
        /funds/i.test(n.parentElement.textContent) &&
        n.parentElement.textContent.trim().length < 40
      )
        n = n.parentElement;
      n.classList.add("cer-hide-settings-title");
      break;
    }
    // move the pill to the top of the content column and drop the old side menu
    const dd = document.querySelector(".cer-set-dd");
    const tcg = document.querySelector(".tab-content-group");
    if (dd && tcg && tcg.firstElementChild !== dd) tcg.insertBefore(dd, tcg.firstChild);
  }

  // Replace the section list with a dropdown picker (pills got crowded with
  // 11 sections). The dropdown proxies clicks to Roblox's own (hidden) menu
  // links so Angular routing keeps working untouched.
  function buildDropdown() {
    const nav = document.querySelector(".settings-left-navigation .menu-vertical, .menu-vertical");
    if (!nav || document.querySelector(".cer-set-dd")) return;
    const opts = [...nav.querySelectorAll(".menu-option-content")];
    if (!opts.length) return;
    nav.style.display = "none"; // the dropdown replaces the section list

    const dd = CER.el("div", "cer-set-dd");
    const btn = CER.el("button", "cer-set-dd-btn");
    const menu = CER.el("div", "cer-set-dd-menu");
    const currentLabel = () =>
      (nav.querySelector(".menu-option-content.active") ?? opts[0]).textContent.trim();
    btn.textContent = currentLabel() + "  ▾";

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("cer-set-dd-open");
    });
    document.addEventListener("click", () => menu.classList.remove("cer-set-dd-open"));

    for (const opt of opts) {
      const it = CER.el("button", "cer-set-dd-opt", opt.textContent.trim());
      it.addEventListener("click", () => {
        opt.click();
        menu.classList.remove("cer-set-dd-open");
        setTimeout(() => (btn.textContent = currentLabel() + "  ▾"), 60);
      });
      menu.appendChild(it);
    }
    dd.appendChild(btn);
    dd.appendChild(menu);
    nav.parentElement.insertBefore(dd, nav);
  }

  // changing a native setting isn't instant — flash a brief loading shimmer on
  // the card so it doesn't feel frozen
  document.addEventListener(
    "change",
    (e) => {
      const card = e.target?.closest?.(".cer-set-card");
      if (!card) return;
      card.classList.add("cer-set-loading");
      setTimeout(() => card.classList.remove("cer-set-loading"), 900);
    },
    true
  );

  tag();
  const obs = new MutationObserver(() => tag());
  obs.observe(document.body, { childList: true, subtree: true });
  CER.onNavigate?.(tag);
})();
