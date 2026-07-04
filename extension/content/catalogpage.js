// Catalog cleanup: rename "Marketplace" back to "Catalog", strip the clutter
// (buy-robux, cart, search-suggestion pills, the extra category dropdown next
// to the search box), and let the stylesheet retheme the rest. Toggleable.

(async function () {
  if (typeof CER === "undefined") return;
  if (!location.pathname.startsWith("/catalog")) return;
  const settings = await CER.get();
  if (settings.features.catalogClean === false) return;

  document.body.classList.add("cer-catalog");

  // drop the skeleton once the catalog grid has actually populated
  CER.waitFor(() => document.querySelector("[class*='item-card'], .catalog-item-container, [class*='ItemCard']"), 12000)
    .then(() => setTimeout(() => CER.skelDone?.("catalog"), 300))
    .catch(() => CER.skelDone?.("catalog"));

  function tidy() {
    for (const h of document.querySelectorAll("h1, h2, .catalog-name, [class*='page-title']")) {
      if (h.textContent.trim() === "Marketplace") h.textContent = "Catalog";
    }
  }
  tidy();
  let t = null;
  new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(tidy, 200);
  }).observe(document.body, { childList: true, subtree: true });
})();
