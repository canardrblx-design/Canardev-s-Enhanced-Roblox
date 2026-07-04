// Redesigned Transactions page (/transactions) — a clean summary dashboard
// (income vs spend, pending, balance) plus a readable recent-transactions
// list. Replaces Roblox's dated table.

(async function () {
  if (typeof CER === "undefined") return;
  if (!location.pathname.startsWith("/transactions")) return;

  const host = await CER.waitFor(() => document.querySelector("#content, main"), 20000).catch(() => null);
  if (!host) return;

  let me = null;
  try {
    me = await (await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" })).json();
  } catch {
    return;
  }
  if (!me?.id) return;

  const root = CER.el("div", "cer-page");
  for (const child of host.children) child.style.display = "none";
  host.appendChild(root);
  new MutationObserver(() => {
    for (const child of host.children) if (child !== root && child.style.display !== "none") child.style.display = "none";
  }).observe(host, { childList: true });

  const head = CER.el("div", "cer-avatar-head");
  head.appendChild(CER.el("h1", "cer-avatar-title", "Transactions"));
  root.appendChild(head);

  const fmt = (n) => Number(n ?? 0).toLocaleString();
  const j = (url, method, body) =>
    method ? CER.bgFetch(url, method, body).then((r) => r.data) : fetch(url, { credentials: "include" }).then((r) => r.json()).catch(() => null);

  // ---- summary cards ----
  const cards = CER.el("div", "cer-tx-cards");
  root.appendChild(cards);
  const summaryCard = (label, valueEl) => {
    const c = CER.el("div", "cer-tx-card");
    c.appendChild(CER.el("div", "cer-tx-card-label", label));
    c.appendChild(valueEl);
    return c;
  };
  const balV = CER.el("div", "cer-tx-card-value", "…");
  const inV = CER.el("div", "cer-tx-card-value cer-tx-pos", "…");
  const outV = CER.el("div", "cer-tx-card-value cer-tx-neg", "…");
  const pendV = CER.el("div", "cer-tx-card-value", "…");
  cards.append(
    summaryCard("Current balance", balV),
    summaryCard("Income (30d)", inV),
    summaryCard("Spent (30d)", outV),
    summaryCard("Pending", pendV)
  );

  j("https://economy.roblox.com/v1/user/currency").then((d) => (balV.textContent = "R$ " + fmt(d?.robux)));
  j(`https://economy.roblox.com/v2/users/${me.id}/transaction-totals?timeFrame=Month&transactionType=summary`).then((d) => {
    if (!d) return;
    const income = (d.salesTotal ?? 0) + (d.affiliateSalesTotal ?? 0) + (d.groupPayoutsTotal ?? 0) + (d.currencyPurchasesTotal ?? 0);
    const spent = Math.abs(d.purchasesTotal ?? 0) + Math.abs(d.tradeRobuxTotal < 0 ? d.tradeRobuxTotal : 0);
    inV.textContent = "R$ " + fmt(income);
    outV.textContent = "R$ " + fmt(spent);
    pendV.textContent = "R$ " + fmt(d.pendingRobuxTotal ?? d.pendingRobux ?? 0);
  });

  // ---- recent transactions ----
  root.appendChild(CER.el("h3", "cer-h3", "Recent"));
  const list = CER.el("div", "cer-tx-list");
  root.appendChild(list);
  list.appendChild(CER.el("p", "cer-hint", "Loading…"));

  try {
    const data = await j(`https://economy.roblox.com/v2/users/${me.id}/transactions?transactionType=Purchase&limit=25&cursor=`);
    list.textContent = "";
    const items = data?.data ?? [];
    if (items.length === 0) {
      list.appendChild(CER.el("p", "cer-hint", "No recent transactions."));
    } else {
      for (const t of items) {
        const row = CER.el("div", "cer-tx-row");
        const img = CER.el("img", "cer-tx-icon");
        img.src = t.details?.imageUrl ?? "";
        row.appendChild(img);
        const mid = CER.el("div", "cer-tx-mid");
        mid.appendChild(CER.el("div", "cer-tx-name", t.details?.name ?? t.transactionType ?? "Transaction"));
        mid.appendChild(CER.el("div", "cer-tx-date", new Date(t.created).toLocaleDateString()));
        row.appendChild(mid);
        const amt = t.currency?.amount ?? 0;
        const amtEl = CER.el("div", "cer-tx-amt " + (amt >= 0 ? "cer-tx-pos" : "cer-tx-neg"), (amt >= 0 ? "+" : "") + "R$ " + fmt(amt));
        row.appendChild(amtEl);
        list.appendChild(row);
      }
    }
  } catch {
    list.textContent = "";
    list.appendChild(CER.el("p", "cer-hint", "Couldn't load transactions."));
  }
})();
