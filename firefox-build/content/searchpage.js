// Tag search + discover result pages so the CSS can give Roblox's native result
// cards the CER look (rounded corners, themed surfaces, centered titles) without
// restyling those same card classes everywhere else on the site.
(function () {
  if (typeof CER === "undefined") return;
  function mark() {
    const on = location.pathname.startsWith("/search") || location.pathname.startsWith("/discover");
    if (document.body) document.body.classList.toggle("cer-search-page", on);
  }
  mark();
  CER.onNavigate?.(mark);
})();
