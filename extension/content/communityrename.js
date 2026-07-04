// Roblox rebranded "Groups" to "Communities"; canardev wants the old name back
// everywhere in the UI. This swaps the word in visible text nodes only, leaving
// user content (bios, posts, chat, inputs) untouched so nothing real gets mangled.
(function () {
  if (typeof CER === "undefined") return;

  const SKIP_TAG = /^(SCRIPT|STYLE|TEXTAREA|INPUT|CODE|PRE|NOSCRIPT)$/;
  // areas that hold user-authored text — never rewrite these
  const SKIP_CLASS = /description|bio|post-body|comment|message-content|chat|linkify|markup|ugc|user-content|group-desc|para-overflow/i;

  function fix(s) {
    return s
      .replace(/\bCommunities\b/g, "Groups")
      .replace(/\bcommunities\b/g, "groups")
      .replace(/\bCommunity\b/g, "Group")
      .replace(/\bcommunity\b/g, "group");
  }

  function skip(node) {
    let p = node.parentElement;
    while (p) {
      if (SKIP_TAG.test(p.tagName) || p.isContentEditable) return true;
      const c = p.className && p.className.toString ? p.className.toString() : "";
      if (SKIP_CLASS.test(c)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function walk(root) {
    if (!root || root.nodeType === 3) {
      if (root && root.nodeType === 3 && /communit/i.test(root.nodeValue) && !skip(root)) {
        const nv = fix(root.nodeValue);
        if (nv !== root.nodeValue) root.nodeValue = nv;
      }
      return;
    }
    if (root.nodeType !== 1) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !/communit/i.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        return skip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let x;
    while ((x = tw.nextNode())) nodes.push(x);
    for (const n of nodes) {
      const nv = fix(n.nodeValue);
      if (nv !== n.nodeValue) n.nodeValue = nv;
    }
  }

  function run() {
    walk(document.body);
    // page <title> too ("Communities - Roblox")
    if (/communit/i.test(document.title)) document.title = fix(document.title);
  }

  run();
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) walk(n);
      if (m.type === "characterData" && m.target) walk(m.target);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  CER.onNavigate?.(run);
})();
