// Game-title cleanup across the site: strips [BRACKETS]/(parens) and emojis,
// per settings. IMPORTANT: only text nodes are edited — replacing whole
// elements (textContent =) nuked React-managed children and crashed entire
// sections (the Charts page bug).

(async function () {
  if (typeof CER === "undefined") return;

  const SELECTOR = ".game-card-name, .game-name-title, h1.game-name, .cer-card-name";
  const HEADING_SELECTOR = "h1, h2, h3, h4, span";

  async function sweep() {
    const settings = await CER.get();
    const anyOn = settings.features.cleanTitles || settings.features.stripEmojis;

    // sitewide renames (exact-match text nodes only)
    const RENAMES = [
      [/^\s*Experiences\s*$/, "Experiences", "Games"],
      [/^\s*Experience\s*$/, "Experience", "Game"],
    ];
    if (settings.features.renameGroups) {
      RENAMES.push(
        [/^\s*Communities\s*$/, "Communities", "Groups"],
        [/^\s*My Communities\s*$/, "My Communities", "My Groups"],
        [/^\s*Create Community\s*$/, "Create Community", "Create Group"]
      );
    }
    for (const el of document.querySelectorAll(HEADING_SELECTOR + ", button, a")) {
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        for (const [re, from, to] of RENAMES) {
          if (re.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.replace(from, to);
            break;
          }
        }
      }
    }
    for (const el of document.querySelectorAll(SELECTOR)) {
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const original = node.cerOriginal ?? node.nodeValue;
        if (node.cerOriginal === undefined) node.cerOriginal = original;
        const wanted = anyOn ? CER.cleanTitle(original, settings.features) : original;
        if (node.nodeValue !== wanted) {
          node.nodeValue = wanted;
          el.title = original.trim();
        }
      }
    }
  }

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(sweep, 300);
  }).observe(document.body, { childList: true, subtree: true });
  CER.ext.storage.onChanged.addListener((changes) => {
    if (changes.features) sweep();
  });
  await sweep();
})();
