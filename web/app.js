// GreenRev Business Suite: test console.
// A plain-JavaScript screen for trying every API feature. Served by the API at /app, or open it with
// any static server (VS Code Live Server) and point it at the API with ?api=http://localhost:4000.

// ------------------------------------------------------------------ setup

const params = new URLSearchParams(location.search);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
if (params.get("api")) store.set("gr.api", params.get("api"));
const API = (store.get("gr.api") || (location.pathname.startsWith("/app") ? location.origin : "http://localhost:4000")).replace(/\/$/, "");
let token = store.get("gr.token");
let me = null;
const cache = {};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const naira = (kobo) => {
  if (kobo == null) return "–";
  const n = Number(kobo) / 100;
  return `${n < 0 ? "−" : ""}₦${Math.abs(n).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
};
const nextMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); };
const toKobo = (v) => Math.round(Number(String(v).replace(/,/g, "")) * 100);
const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${today().slice(0, 4)}-01-01`;
const badge = (text, kind = "") => `<span class="badge ${kind}">${esc(text)}</span>`;
const statusBadge = (s) => badge(s, ["paid", "listed", "in_stock", "completed", "delivered", "returned", "active"].includes(s) ? "good" : ["overdue", "void", "error", "sold", "cancelled"].includes(s) ? "bad" : ["partially_paid", "pending", "reserved", "in_transit", "in_repair", "rented", "open", "issued", "in_progress", "booked"].includes(s) ? "warn" : "");

$("#api-base").textContent = API;

async function api(method, path, body) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: payload });
  } catch {
    throw Object.assign(new Error(`Cannot reach the API at ${API}. Is it running (npm run dev)?`), { status: 0 });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") logout();
    const msg = data?.message ?? `${res.status} error`;
    const extra = data?.details && data.error === "validation_error" ? `: ${JSON.stringify(data.details).slice(0, 300)}` : "";
    throw Object.assign(new Error(msg + extra), { status: res.status, data });
  }
  return data;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${err ? "err" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), err ? 7000 : 3500);
}

/** Run an action, show success or the API's error (402 = upgrade to Pro). */
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.status === 402 ? `🔒 ${e.message}` : e.message, true);
    throw e;
  }
}

// ------------------------------------------------------------------ forms and tables

/**
 * fields: { name, label, type: text|number|money|date|select|textarea|check, options: [[value,label]], value, full, req, hint }
 * Names with dots build nested objects (purchase.amount). Money is typed in naira and sent in kobo.
 */
function form(id, fields, submit = "Save", extra = "") {
  const f = fields.map((x) => {
    const cls = x.full ? "full" : "";
    if (x.type === "check") return `<label class="check ${cls}"><input type="checkbox" name="${x.name}" ${x.value ? "checked" : ""}> ${esc(x.label)}</label>`;
    if (x.type === "heading") return `<h3 class="full">${esc(x.label)}</h3>`;
    let input;
    if (x.type === "select") input = `<select name="${x.name}" ${x.req ? "required" : ""}>${(x.options ?? []).map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(x.value ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    else if (x.type === "textarea") input = `<textarea name="${x.name}" rows="2">${esc(x.value ?? "")}</textarea>`;
    else input = `<input name="${x.name}" type="${x.type === "money" || x.type === "number" ? "number" : x.type ?? "text"}" step="${x.step ?? (x.type === "money" ? "0.01" : "any")}" value="${esc(x.value ?? "")}" placeholder="${esc(x.hint ?? "")}" ${x.req ? "required" : ""}>`;
    return `<label class="fl ${cls}">${esc(x.label)}${x.type === "money" ? " (₦)" : ""}${input}</label>`;
  }).join("");
  return `<form class="f" id="${id}">${f}${extra}<div class="full row"><button class="btn primary" type="submit">${esc(submit)}</button></div></form>`;
}

function readForm(el, fields) {
  const out = {};
  for (const x of fields) {
    if (!x.name || x.type === "heading") continue;
    const input = el.elements[x.name];
    if (!input) continue;
    let v;
    if (x.type === "check") v = input.checked;
    else {
      v = input.value.trim();
      if (v === "") continue;
      if (x.type === "money") v = toKobo(v);
      else if (x.type === "number") v = Number(v);
    }
    const path = x.name.split(".");
    let o = out;
    for (const k of path.slice(0, -1)) o = o[k] ??= {};
    o[path.at(-1)] = v;
  }
  return out;
}

function bind(id, fields, onSubmit) {
  const el = document.getElementById(id);
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await onSubmit(readForm(el, fields), el);
    } catch {
      /* toast already shown */
    } finally {
      btn.disabled = false;
    }
  });
  return el;
}

/** cols: [{ k, label, num, f(row) }]. Rows with an id become clickable when onClick is given. */
function table(rows, cols, { onClick, empty = "Nothing here yet.", id = "" } = {}) {
  if (!rows?.length) return `<p class="muted">${esc(empty)}</p>`;
  const head = cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("");
  const body = rows.map((r, i) => `<tr class="${onClick ? "click" : ""} ${r._class ?? ""}" data-i="${i}">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join("")}</tr>`).join("");
  setTimeout(() => {
    if (!onClick) return;
    const t = id ? document.getElementById(id) : null;
    (t ?? document).querySelectorAll(`table[data-t="${id}"] tr.click`).forEach((tr) => tr.addEventListener("click", () => onClick(rows[tr.dataset.i])));
  });
  return `<div class="table-wrap"><table data-t="${id}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const kv = (pairs) => `<table>${pairs.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="num">${v}</td></tr>`).join("")}</table>`;
const opt = (rows, label, value = "id") => rows.map((r) => [r[value], typeof label === "function" ? label(r) : r[label]]);

async function contacts(kind) {
  const all = (cache.contacts ??= await api("GET", "/contacts?limit=200"));
  return all.filter((c) => !kind || c.kind === kind || c.kind === "both");
}
async function accounts() {
  return (cache.accounts ??= await api("GET", "/accounts"));
}
const cashAccounts = async () => (await accounts()).filter((a) => ["cash", "bank"].includes(a.subtype));
const invalidate = (...keys) => keys.forEach((k) => delete cache[k]);

function upgradeNote(e) {
  return e.status === 402 ? `<div class="callout">🔒 ${esc(e.message)} <a href="#/settings">See plans</a></div>` : `<div class="callout err">${esc(e.message)}</div>`;
}

// ------------------------------------------------------------------ auth screens

function showAuth(mode = "login") {
  $("#shell").classList.add("hidden");
  const el = $("#auth");
  el.classList.remove("hidden");
  const loginFields = [
    { name: "email", label: "Email", type: "email", req: true, full: true },
    { name: "password", label: "Password", type: "password", req: true, full: true },
  ];
  const regFields = [
    { name: "fullName", label: "Your name", req: true },
    { name: "phone", label: "Phone", hint: "+234…" },
    { name: "email", label: "Email", type: "email", req: true },
    { name: "password", label: "Password (8+ characters)", type: "password", req: true },
    { name: "business.name", label: "Business name", req: true, full: true },
    { name: "business.plan", label: "Package", type: "select", options: [["pro", "Pro (everything, for testing)"], ["starter", "Starter"]] },
    { name: "business.city", label: "City", value: "Lagos" },
    { type: "heading", label: "Business lines (Starter allows one)" },
    ...["dealer", "mechanic", "parts_vendor", "haulage", "rental"].map((v) => ({ name: `v_${v}`, label: v.replace("_", " "), type: "check", value: v === "dealer" })),
  ];
  el.innerHTML = `<div class="card">
    <div class="row"><span class="logo">GR</span><div><h1>GreenRev Business Suite</h1><span class="muted">Test console</span></div></div>
    <div class="tabs"><button data-m="login" class="${mode === "login" ? "on" : ""}">Sign in</button><button data-m="register" class="${mode === "register" ? "on" : ""}">Create a business</button></div>
    ${mode === "login" ? form("auth-form", loginFields, "Sign in") : form("auth-form", regFields, "Create account & business")}
    <p class="muted">API: <code>${esc(API)}</code> · change it with <code>?api=http://host:port</code> in the address bar.</p>
  </div>`;
  $$(".tabs button", el).forEach((b) => (b.onclick = () => showAuth(b.dataset.m)));
  bind("auth-form", mode === "login" ? loginFields : regFields, async (v) => {
    let r;
    if (mode === "login") r = await act(() => api("POST", "/auth/login", v));
    else {
      const verticals = ["dealer", "mechanic", "parts_vendor", "haulage", "rental"].filter((k) => v[`v_${k}`]);
      for (const k of Object.keys(v)) if (k.startsWith("v_")) delete v[k];
      v.business.verticals = verticals.length ? verticals : ["dealer"];
      r = await act(() => api("POST", "/auth/register", v));
    }
    token = r.token;
    store.set("gr.token", token);
    await boot();
  });
}

function logout() {
  token = null;
  store.set("gr.token", null);
  me = null;
  showAuth();
}

// ------------------------------------------------------------------ navigation

const PAGES = {
  dashboard: { title: "Dashboard", group: "Overview" },
  inventory: { title: "Inventory", group: "Stock" },
  contacts: { title: "Customers & suppliers", group: "Stock" },
  sales: { title: "Sales & invoices", group: "Money" },
  payments: { title: "Payments", group: "Money" },
  purchases: { title: "Bills & suppliers", group: "Money" },
  expenses: { title: "Expenses", group: "Money" },
  installments: { title: "Installments", group: "Money" },
  fx: { title: "FX rates", group: "Money" },
  reports: { title: "Reports", group: "Money" },
  workshop: { title: "Workshop (job cards)", group: "Operations", vertical: "mechanic" },
  haulage: { title: "Haulage", group: "Operations", vertical: "haulage" },
  rentals: { title: "Rentals", group: "Operations", vertical: "rental" },
  marketplace: { title: "Marketplace & leads", group: "Growth" },
  ai: { title: "AI tools", group: "Growth" },
  settings: { title: "Settings & plan", group: "Admin" },
  console: { title: "API console", group: "Admin" },
};

function renderNav(current) {
  let html = "", group = "";
  for (const [k, p] of Object.entries(PAGES)) {
    if (p.vertical && !me.organization.verticals.includes(p.vertical)) continue;
    if (p.group !== group) html += `<div class="group">${(group = p.group)}</div>`;
    html += `<a href="#/${k}" class="${k === current ? "on" : ""}">${esc(p.title)}</a>`;
  }
  $("#nav").innerHTML = html;
}

async function route() {
  if (!me) return;
  const [, name = "dashboard", arg] = location.hash.split("/");
  const page = PAGES[name] ? name : "dashboard";
  renderNav(page);
  $(".side").classList.remove("open");
  $("#title").textContent = PAGES[page].title;
  const el = $("#page");
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    await VIEWS[page](el, arg);
  } catch (e) {
    el.innerHTML = upgradeNote(e);
  }
}

async function boot() {
  if (!token) return showAuth();
  try {
    me = await api("GET", "/me");
  } catch {
    return showAuth();
  }
  for (const k of Object.keys(cache)) delete cache[k];
  $("#auth").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  $("#org-name").textContent = me.organization.name;
  $("#plan-pill").textContent = `${me.organization.planDetails.name} · ${me.organization.plan_status} · ${me.role}`;
  route();
}

$("#logout").onclick = logout;
$("#menu").onclick = () => $(".side").classList.toggle("open");
addEventListener("hashchange", route);

// ------------------------------------------------------------------ views

const VIEWS = {};

VIEWS.dashboard = async (el) => {
  const d = await api("GET", "/dashboard");
  const u = me.organization.usage, lim = me.organization.planDetails.limits;
  el.innerHTML = `
    <div class="tiles">
      <div class="tile"><small>Revenue this month</small><b>${naira(d.month.revenue)}</b></div>
      <div class="tile"><small>Gross profit</small><b>${naira(d.month.grossProfit)}</b></div>
      <div class="tile"><small>Net profit</small><b>${naira(d.month.netProfit)}</b></div>
      <div class="tile"><small>Customers owe you</small><b>${naira(d.receivable.total)}</b><small>${naira(d.receivable.overdue)} overdue</small></div>
      <div class="tile"><small>You owe suppliers</small><b>${naira(d.payable.total)}</b></div>
      <div class="tile"><small>Cars in stock</small><b>${d.stock.vehicles}</b><small>${d.stock.listed} listed on GreenRev</small></div>
      <div class="tile"><small>Parts to reorder</small><b>${d.stock.low_stock}</b></div>
      <div class="tile"><small>New marketplace leads</small><b>${d.leads.new}</b></div>
    </div>
    <div class="grid">
      <div class="card"><h2>Try a full deal in 5 steps</h2>
        <ol>
          <li><a href="#/contacts">Add a supplier and a customer</a></li>
          <li><a href="#/fx">Set today's USD rate</a> (for imported cars)</li>
          <li><a href="#/inventory">Add a car</a>, with its purchase in USD, duty and clearing</li>
          <li><a href="#/sales">Sell it</a>, with a discount and an installment plan</li>
          <li><a href="#/reports">Check the P&amp;L, balance sheet and profit per car</a></li>
        </ol>
      </div>
      <div class="card"><h2>Plan usage</h2>${kv([
        ["Package", `${esc(me.organization.planDetails.name)} (${esc(me.organization.plan_status)})`],
        ["Team members", `${u.users} / ${lim.users ?? "∞"}`],
        ["Active cars", `${u.vehicles} / ${lim.vehicles ?? "∞"}`],
        ["Parts", `${u.parts} / ${lim.parts ?? "∞"}`],
        ["AI credits this month", `${u.ai_credits} / ${lim.aiCreditsMonthly}`],
        ["Business lines", esc(me.organization.verticals.join(", "))],
      ])}</div>
    </div>`;
};

// ---- inventory

VIEWS.inventory = async (el, id) => {
  if (id) return inventoryDetail(el, id);
  const kind = params.get("kind") ?? store.get("gr.invkind") ?? "vehicle";
  const list = await api("GET", `/inventory?kind=${kind}&limit=200`);
  const suppliers = await contacts("supplier");
  const cash = await cashAccounts();
  const vehicleFields = [
    { name: "vin", label: "VIN", hint: "17 characters" },
    { name: "make", label: "Make", req: true },
    { name: "model", label: "Model", req: true },
    { name: "year", label: "Year", type: "number" },
    { name: "trim", label: "Trim" },
    { name: "color", label: "Colour" },
    { name: "mileageKm", label: "Mileage (km)", type: "number" },
    { name: "condition", label: "Condition", type: "select", options: [["", "–"], ["foreign_used", "Foreign used (Tokunbo)"], ["nigerian_used", "Nigerian used"], ["brand_new", "Brand new"]] },
    { name: "status", label: "Status", type: "select", options: [["in_stock", "In stock"], ["in_transit", "In transit"], ["in_repair", "In repair"], ["draft", "Draft"]] },
    { name: "askingPriceNgn", label: "Asking price", type: "money" },
    { name: "isRentable", label: "Rental fleet car (not for sale)", type: "check" },
    { name: "dailyRateNgn", label: "Daily rental rate", type: "money" },
    { type: "heading", label: "How you got it (optional)" },
    { name: "openingCostNgn", label: "Already owned: cost", type: "money", hint: "for cars you had before" },
    { name: "purchase.supplierId", label: "Or bought from supplier", type: "select", options: [["", "–"], ...opt(suppliers, "name")] },
    { name: "purchase.currency", label: "Purchase currency", type: "select", options: ["NGN", "USD", "GBP", "EUR", "CAD", "AED"].map((c) => [c, c]) },
    { name: "purchase.amount", label: "Purchase price (in that currency)", type: "money", hint: "e.g. 10000 for $10,000" },
    { name: "purchase.fxRate", label: "FX rate (₦ per unit)", type: "number", hint: "blank = saved rate" },
    { name: "purchase.importDutyNgn", label: "Import duty", type: "money" },
    { name: "purchase.clearingNgn", label: "Clearing & port", type: "money" },
    { name: "purchase.shippingNgn", label: "Shipping / transport", type: "money" },
    { name: "purchase.paidFromAccountId", label: "Paid now from", type: "select", options: [["", "Not yet (owe the supplier, Pro)"], ...opt(cash, (a) => `${a.code} ${a.name}`)] },
  ];
  const partFields = [
    { name: "title", label: "Part name", req: true, full: true },
    { name: "sku", label: "SKU" },
    { name: "partNumber", label: "Part number" },
    { name: "brand", label: "Brand" },
    { name: "compatibleWith", label: "Fits (comma separated)", hint: "Toyota Corolla 2014-2019" },
    { name: "unitPriceNgn", label: "Selling price", type: "money" },
    { name: "reorderLevel", label: "Reorder at", type: "number" },
    { name: "openingQuantity", label: "Opening quantity", type: "number" },
    { name: "openingUnitCostNgn", label: "Cost per unit", type: "money" },
  ];
  el.innerHTML = `
    <div class="row"><button class="btn ${kind === "vehicle" ? "primary" : ""}" data-k="vehicle">Vehicles</button><button class="btn ${kind === "part" ? "primary" : ""}" data-k="part">Parts</button><button class="btn ${kind === "accessory" ? "primary" : ""}" data-k="accessory">Accessories</button></div>
    <div class="card"><h2>${list.total} ${kind === "vehicle" ? "vehicles" : "items"}</h2>${table(list.items, kind === "vehicle" ? [
      { label: "Car", f: (r) => `<b>${esc(r.title)}</b><br><small class="muted">${esc(r.vin ?? "no VIN")}</small>` },
      { label: "Status", f: (r) => statusBadge(r.status) },
      { label: "Landed cost", num: true, f: (r) => naira(r.landed_cost_ngn) },
      { label: "Asking", num: true, f: (r) => naira(r.asking_price_ngn) },
      { label: "Marketplace", f: (r) => statusBadge(r.marketplace_status) },
    ] : [
      { label: "Part", f: (r) => `<b>${esc(r.title)}</b><br><small class="muted">${esc(r.sku ?? "")} ${esc(r.part_number ?? "")}</small>` },
      { label: "Qty", num: true, f: (r) => `${r.quantity}${r.quantity <= r.reorder_level ? " " + badge("reorder", "warn") : ""}` },
      { label: "Avg cost", num: true, f: (r) => naira(r.unit_cost_ngn) },
      { label: "Price", num: true, f: (r) => naira(r.unit_price_ngn) },
      { label: "Marketplace", f: (r) => statusBadge(r.marketplace_status) },
    ], { id: "inv", onClick: (r) => (location.hash = `#/inventory/${r.id}`) })}</div>
    <div class="card"><h2>${kind === "vehicle" ? "Add a vehicle" : "Add a part or accessory"}</h2>
      ${kind === "vehicle" ? `<div class="row" style="margin-bottom:10px"><input id="vin-q" placeholder="Type a VIN to fill make/model/year" style="flex:1;padding:7px;border:1px solid var(--line);border-radius:8px"><button class="btn" id="vin-go">Decode VIN</button></div>` : ""}
      ${form("add-item", kind === "vehicle" ? vehicleFields : partFields, "Add to inventory")}</div>`;
  $$("[data-k]", el).forEach((b) => (b.onclick = () => { store.set("gr.invkind", b.dataset.k); route(); }));
  if (kind === "vehicle") {
    $("#vin-go").onclick = async () => {
      const d = await act(() => api("GET", `/ai/vin/${encodeURIComponent($("#vin-q").value.trim())}`));
      const f = $("#add-item");
      f.elements.vin.value = d.vin;
      if (d.make) f.elements.make.value = d.make;
      if (d.model) f.elements.model.value = d.model;
      if (d.modelYear) f.elements.year.value = d.modelYear;
      if (d.trim) f.elements.trim.value = d.trim;
      toast(`VIN ${d.checkDigitValid ? "valid" : "format OK (no check digit)"} · ${d.make ?? "unknown make"} · ${d.modelYear ?? "?"} · source: ${d.source}`);
    };
  }
  bind("add-item", kind === "vehicle" ? vehicleFields : partFields, async (v) => {
    if (kind !== "vehicle") {
      if (v.compatibleWith) v.compatibleWith = v.compatibleWith.split(",").map((s) => s.trim()).filter(Boolean);
      if (kind === "accessory") v.kind = "accessory";
      await act(() => api("POST", "/inventory/parts", v), "Added");
    } else {
      if (!v.purchase?.supplierId) delete v.purchase;
      else if (!v.purchase.amount) throw toast("Enter the purchase price", true);
      await act(() => api("POST", "/inventory/vehicles", v), "Vehicle added");
    }
    invalidate("items");
    route();
  });
};

async function inventoryDetail(el, id) {
  const it = await api("GET", `/inventory/${id}`);
  const isCar = it.kind === "vehicle";
  const editFields = [
    { name: "status", label: "Status", type: "select", value: it.status, options: ["draft", "in_transit", "in_stock", "reserved", "in_repair", "archived"].map((s) => [s, s]) },
    isCar ? { name: "askingPriceNgn", label: "Asking price", type: "money", value: it.asking_price_ngn / 100 || "" } : { name: "unitPriceNgn", label: "Selling price", type: "money", value: (it.unit_price_ngn ?? 0) / 100 || "" },
    { name: "description", label: "Description", type: "textarea", value: it.description, full: true },
  ];
  el.innerHTML = `
    <div class="row"><a href="#/inventory">← Inventory</a></div>
    <div class="grid">
      <div class="card"><h2>${esc(it.title)} ${statusBadge(it.status)}</h2>${kv(isCar ? [
        ["VIN", esc(it.vin ?? "–")], ["Year / colour", esc(`${it.year ?? "–"} · ${it.color ?? "–"}`)], ["Mileage", it.mileage_km ? `${it.mileage_km.toLocaleString()} km` : "–"],
        ["Landed cost", naira(it.landed_cost_ngn)], ["Asking price", naira(it.asking_price_ngn)], ["Margin at asking", naira(it.margin_at_asking)],
        ["Marketplace", `${statusBadge(it.marketplace_status)} ${esc(it.marketplace_error ?? "")}`],
      ] : [
        ["SKU / part no.", esc(`${it.sku ?? "–"} · ${it.part_number ?? "–"}`)], ["In stock", it.quantity], ["Average cost", naira(it.unit_cost_ngn)], ["Stock value", naira(it.stock_value_ngn)], ["Price", naira(it.unit_price_ngn)],
        ["Marketplace", statusBadge(it.marketplace_status)],
      ])}
        <div class="row" style="margin-top:10px">
          <button class="btn" id="pub">${it.publish_to_marketplace ? "Unpublish from GreenRev" : "Publish to GreenRev"}</button>
          <button class="btn" id="ai-listing">✨ Write listing with AI</button>
          <a class="btn" href="#/sales">Sell it →</a>
        </div>
      </div>
      <div class="card"><h2>Edit</h2>${form("edit-item", editFields, "Save changes")}</div>
    </div>
    ${isCar ? `<div class="card"><h2>Costs added to this car</h2>${table(it.costs, [
      { label: "Date", k: "date" }, { label: "Source", f: (r) => `${esc(r.source)} ${esc(r.reference ?? "")}` }, { label: "What", k: "description" },
      { label: "Foreign", num: true, f: (r) => (r.currency !== "NGN" ? `${r.currency} ${(r.amount_foreign / 100).toLocaleString()}` : "") }, { label: "₦", num: true, f: (r) => naira(r.amount_ngn) },
    ], { empty: "No costs recorded yet. Add duty, repairs or transport under Expenses with this car selected." })}</div>` : `
    <div class="card"><h2>Stock count correction</h2>${form("adjust", [{ name: "quantity", label: "Quantity (+ found, − written off)", type: "number", req: true }, { name: "note", label: "Reason" }], "Adjust stock")}</div>`}
    <div class="card"><h2>Photos</h2><div class="row">${it.photos.map((p) => `<img src="${esc(p.url)}" alt="" style="height:90px;border-radius:8px">`).join("") || '<span class="muted">No photos.</span>'}</div>
      ${form("photo-url", [{ name: "url", label: "Add photo by URL", hint: "https://…", full: true }], "Add photo")}
      <form id="photo-up" class="row" style="margin-top:8px"><input type="file" name="photos" accept="image/*" multiple><button class="btn">Upload photos</button></form></div>
    <div id="ai-out"></div>`;
  $("#pub").onclick = async () => { await act(() => api("POST", `/inventory/${id}/${it.publish_to_marketplace ? "unpublish" : "publish"}`), "Updated"); route(); };
  $("#ai-listing").onclick = async () => {
    const r = await act(() => api("POST", `/ai/listing/${id}`, { save: true }), "Listing written and saved");
    $("#ai-out").innerHTML = `<div class="card"><h2>${esc(r.title)}</h2><p>${esc(r.description).replace(/\n/g, "<br>")}</p><ul>${r.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></div>`;
  };
  bind("edit-item", editFields, async (v) => { await act(() => api("PATCH", `/inventory/${id}`, v), "Saved"); route(); });
  bind("photo-url", [{ name: "url" }], async (v) => { await act(() => api("POST", `/inventory/${id}/photos/urls`, { urls: [v.url] }), "Photo added"); route(); });
  $("#photo-up").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await act(() => api("POST", `/inventory/${id}/photos`, fd), "Uploaded");
    route();
  };
  if (!isCar) bind("adjust", [{ name: "quantity", type: "number" }, { name: "note" }], async (v) => { await act(() => api("POST", `/inventory/${id}/adjust-stock`, v), "Stock adjusted"); route(); });
}

// ---- contacts

VIEWS.contacts = async (el, id) => {
  if (id) {
    const c = await api("GET", `/contacts/${id}`);
    const st = await api("GET", `/contacts/${id}/statement`);
    el.innerHTML = `<div class="row"><a href="#/contacts">← Contacts</a></div>
      <div class="card"><h2>${esc(c.name)} ${badge(c.kind)}</h2>${kv([["Phone", esc(c.phone ?? "–")], ["Email", esc(c.email ?? "–")], ["Money held on deposit", naira(c.deposit_balance)], ["Balance (+ they owe you)", naira(st.closingBalance)]])}</div>
      <div class="card"><h2>Statement</h2>${table(st.lines, [{ label: "Date", k: "entry_date" }, { label: "Detail", k: "memo" }, { label: "Debit", num: true, f: (r) => naira(r.debit) }, { label: "Credit", num: true, f: (r) => naira(r.credit) }, { label: "Balance", num: true, f: (r) => naira(r.balance) }])}</div>`;
    return;
  }
  invalidate("contacts");
  const list = await contacts();
  const fields = [
    { name: "kind", label: "Type", type: "select", options: [["customer", "Customer"], ["supplier", "Supplier"], ["both", "Both"]] },
    { name: "name", label: "Name", req: true },
    { name: "phone", label: "Phone" },
    { name: "email", label: "Email", type: "email" },
    { name: "country", label: "Country", hint: "e.g. US for foreign suppliers" },
    { name: "address", label: "Address" },
  ];
  el.innerHTML = `<div class="card"><h2>Add a customer or supplier</h2>${form("add-c", fields, "Add")}</div>
    <div class="card"><h2>${list.length} contacts</h2>${table(list, [
      { label: "Name", f: (r) => `<b>${esc(r.name)}</b>` }, { label: "Type", f: (r) => badge(r.kind) }, { label: "Phone", k: "phone" },
      { label: "Owes you", num: true, f: (r) => naira(r.receivable) }, { label: "You owe", num: true, f: (r) => naira(r.payable) },
    ], { id: "ct", onClick: (r) => (location.hash = `#/contacts/${r.id}`) })}</div>`;
  bind("add-c", fields, async (v) => { await act(() => api("POST", "/contacts", v), "Added"); invalidate("contacts"); route(); });
};

// ---- sales

VIEWS.sales = async (el, id) => {
  if (id) return invoiceDetail(el, id);
  const [invoices, customers, stock] = await Promise.all([
    api("GET", "/invoices?limit=100"),
    contacts("customer"),
    api("GET", "/inventory?status=in_stock,reserved,in_repair,in_transit&limit=200"),
  ]);
  const vat = me.organization.vat_registered ? me.organization.vat_rate_bp : 0;
  const itemOpts = [["", "– free text (service, fee…) –"], ...stock.items.map((i) => [i.id, `${i.kind === "vehicle" ? "🚗" : "🔩"} ${i.title}${i.kind !== "vehicle" ? ` (${i.quantity} in stock)` : ""}`])];
  const priceOf = (iid) => { const i = stock.items.find((x) => x.id === iid); return i ? ((i.kind === "vehicle" ? i.asking_price_ngn : i.unit_price_ngn) ?? 0) / 100 : ""; };
  const headFields = [
    { name: "customerId", label: "Customer", type: "select", req: true, options: [["", "– choose –"], ...opt(customers, "name")] },
    { name: "issueDate", label: "Date", type: "date", value: today() },
    { name: "dueDate", label: "Due date", type: "date" },
    { name: "discount", label: "Invoice discount", type: "money" },
    { name: "notes", label: "Notes", full: true },
    { type: "heading", label: "Money received now (optional)" },
    { name: "payment.amount", label: "Amount received", type: "money" },
    { name: "payment.method", label: "Method", type: "select", options: [["transfer", "Transfer"], ["cash", "Cash"], ["pos", "POS"], ["cheque", "Cheque"]] },
    { type: "heading", label: "Installment plan (optional, Pro)" },
    { name: "plan.downPayment", label: "Down payment", type: "money" },
    { name: "plan.numInstallments", label: "Number of installments", type: "number" },
    { name: "plan.frequency", label: "Every", type: "select", options: [["monthly", "Month"], ["weekly", "Week"]] },
    { name: "plan.interestPct", label: "Flat interest %", type: "number" },
    { name: "plan.startDate", label: "First installment due", type: "date", value: nextMonth() },
  ];
  const lineRow = () => `<div class="line"><select data-l="itemId">${itemOpts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select>
    <input data-l="description" placeholder="Description"><input data-l="quantity" type="number" value="1" min="0" step="any" title="Qty">
    <input data-l="unitPrice" type="number" step="0.01" placeholder="Price ₦"><input data-l="discount" type="number" step="0.01" placeholder="Discount ₦">
    <select data-l="vatRateBp" title="VAT"><option value="${vat}">VAT ${vat / 100}%</option><option value="0">No VAT</option></select><button type="button" class="btn small danger" data-rm>✕</button></div>`;
  el.innerHTML = `<div class="card"><h2>New invoice</h2>
      <h3>Lines</h3><div class="lines" id="lines">${lineRow()}</div><button type="button" class="btn small" id="add-line" style="margin:8px 0">+ Add line</button>
      ${form("inv", headFields, "Issue invoice")}</div>
    <div class="card"><h2>Invoices</h2>${table(invoices, [
      { label: "No.", k: "number" }, { label: "Date", k: "issue_date" }, { label: "Customer", k: "customer_name" }, { label: "Status", f: (r) => statusBadge(r.status) },
      { label: "Total", num: true, f: (r) => naira(r.total) }, { label: "Balance", num: true, f: (r) => naira(r.balance) },
    ], { id: "invs", onClick: (r) => (location.hash = `#/sales/${r.id}`) })}</div>`;
  const wire = () => $$("#lines .line").forEach((ln) => {
    ln.querySelector("[data-rm]").onclick = () => ln.remove();
    ln.querySelector('[data-l="itemId"]').onchange = (e) => { const p = priceOf(e.target.value); if (p !== "") ln.querySelector('[data-l="unitPrice"]').value = p; };
  });
  wire();
  $("#add-line").onclick = () => { $("#lines").insertAdjacentHTML("beforeend", lineRow()); wire(); };
  bind("inv", headFields, async (v) => {
    const lines = $$("#lines .line").map((ln) => {
      const g = (k) => ln.querySelector(`[data-l="${k}"]`).value.trim();
      const l = { unitPrice: toKobo(g("unitPrice") || 0), quantity: Number(g("quantity") || 1), vatRateBp: Number(g("vatRateBp")) };
      if (g("itemId")) l.itemId = g("itemId");
      if (g("description")) l.description = g("description");
      if (g("discount")) l.discount = toKobo(g("discount"));
      return l;
    }).filter((l) => l.itemId || l.description);
    if (!lines.length) return toast("Add at least one line with an item or description", true);
    const body = { ...v, lines };
    delete body.plan;
    if (!v.payment?.amount) delete body.payment;
    if (v.plan?.numInstallments) {
      body.installmentPlan = { downPayment: v.plan.downPayment ?? 0, numInstallments: v.plan.numInstallments, frequency: v.plan.frequency, interestRateBp: Math.round((v.plan.interestPct ?? 0) * 100), startDate: v.plan.startDate ?? nextMonth() };
    }
    const inv = await act(() => api("POST", "/invoices", body), "Invoice issued");
    location.hash = `#/sales/${inv.id}`;
  });
};

async function invoiceDetail(el, id) {
  const inv = await api("GET", `/invoices/${id}`);
  const plan = inv.installment_plan_id ? await api("GET", `/installment-plans/${inv.installment_plan_id}`) : null;
  const payFields = [
    { name: "amount", label: "Amount received", type: "money", req: true, value: inv.balance / 100 },
    { name: "discount", label: "Early-payment discount", type: "money" },
    { name: "method", label: "Method", type: "select", options: [["transfer", "Transfer"], ["cash", "Cash"], ["pos", "POS"], ["cheque", "Cheque"]] },
    { name: "reference", label: "Reference" },
  ];
  el.innerHTML = `<div class="row"><a href="#/sales">← Invoices</a></div>
    <div class="grid">
      <div class="card"><h2>Invoice ${esc(inv.number)} ${statusBadge(inv.status)}</h2>${kv([
        ["Customer", esc(inv.customer_name)], ["Date / due", `${inv.issue_date} · ${inv.due_date}`], ["Subtotal", naira(inv.subtotal)], ["Discounts", naira(-inv.discount_total)],
        ["VAT", naira(inv.vat_total)], ["Total", `<b>${naira(inv.total)}</b>`], ["Installment interest", naira(inv.finance_charges)], ["Paid", naira(inv.amount_paid)], ["Credited (discounts, deposits)", naira(inv.amount_credited)], ["Balance", `<b>${naira(inv.balance)}</b>`],
      ])}</div>
      <div class="card"><h2>Record a payment</h2>${inv.balance > 0 && inv.status !== "void" ? form("pay", payFields, "Record payment") : '<p class="muted">Nothing outstanding.</p>'}
        ${inv.status !== "void" && inv.amount_paid === 0 && inv.amount_credited === 0 ? '<button class="btn danger" id="void" style="margin-top:10px">Void invoice</button>' : ""}</div>
    </div>
    <div class="card"><h2>Lines</h2>${table(inv.lines, [
      { label: "Item", f: (r) => esc(r.description) }, { label: "Qty", num: true, k: "quantity" }, { label: "Price", num: true, f: (r) => naira(r.unit_price) }, { label: "Discount", num: true, f: (r) => naira(r.discount) },
      { label: "VAT", num: true, f: (r) => naira(r.vat) }, { label: "Total", num: true, f: (r) => naira(r.total) }, { label: "Cost of sale", num: true, f: (r) => naira(r.cost_ngn) },
    ])}</div>
    ${plan ? `<div class="card"><h2>Installment plan</h2><p class="muted">Financed ${naira(plan.financed_amount)} at ${plan.interest_rate_bp / 100}% flat (${naira(plan.interest_total)} interest) · outstanding ${naira(plan.outstanding)}</p>${table(plan.schedule, [
      { label: "#", f: (r) => (r.seq === 0 ? "Down" : r.seq) }, { label: "Due", k: "due_date" }, { label: "Amount", num: true, f: (r) => naira(r.amount_due) }, { label: "Paid", num: true, f: (r) => naira(r.amount_paid) }, { label: "Status", f: (r) => statusBadge(r.status) },
    ])}</div>` : ""}
    <div class="card"><h2>Payments</h2>${table(inv.payments, [{ label: "Receipt", k: "number" }, { label: "Date", k: "payment_date" }, { label: "Method", k: "method" }, { label: "Amount", num: true, f: (r) => naira(r.amount) }])}</div>`;
  if ($("#pay")) bind("pay", payFields, async (v) => {
    await act(() => api("POST", "/payments/receive", { customerId: inv.customer_id, amount: v.amount, method: v.method, reference: v.reference, allocations: [{ invoiceId: id, amount: Math.min(v.amount, inv.balance - (v.discount ?? 0)), discount: v.discount }] }), "Payment recorded");
    route();
  });
  if ($("#void")) $("#void").onclick = async () => { await act(() => api("POST", `/invoices/${id}/void`, {}), "Invoice voided, stock restored"); route(); };
}

// ---- payments

VIEWS.payments = async (el) => {
  const list = await api("GET", "/payments?limit=100");
  const customers = await contacts("customer");
  const fields = [
    { name: "customerId", label: "Customer", type: "select", req: true, options: [["", "– choose –"], ...opt(customers, "name")] },
    { name: "amount", label: "Amount", type: "money", req: true },
    { name: "method", label: "Method", type: "select", options: [["transfer", "Transfer"], ["cash", "Cash"], ["pos", "POS"]] },
    { name: "asDeposit", label: "Hold as a deposit (don't apply to invoices)", type: "check" },
  ];
  el.innerHTML = `<div class="card"><h2>Receive money from a customer</h2><p class="muted">Applied to their oldest unpaid invoices automatically, unless held as a deposit.</p>${form("rcv", fields, "Record receipt")}</div>
    <div class="card"><h2>Recent payments</h2>${table(list, [
      { label: "No.", k: "number" }, { label: "Date", k: "payment_date" }, { label: "In/out", f: (r) => badge(r.direction === "in" ? "received" : "paid out", r.direction === "in" ? "good" : "warn") },
      { label: "Who", k: "contact_name" }, { label: "Method", k: "method" }, { label: "Amount", num: true, f: (r) => (r.currency !== "NGN" ? `${r.currency} ${(r.amount / 100).toLocaleString()} · ` : "") + naira(r.amount_ngn) },
    ])}</div>`;
  bind("rcv", fields, async (v) => {
    const body = { customerId: v.customerId, amount: v.amount, method: v.method };
    if (v.asDeposit) body.allocations = [];
    await act(() => api("POST", "/payments/receive", body), "Receipt recorded");
    invalidate("contacts");
    route();
  });
};

// ---- purchases

VIEWS.purchases = async (el) => {
  const [bills, suppliers, cash, cats, stock] = await Promise.all([api("GET", "/bills?limit=100"), contacts("supplier"), cashAccounts(), api("GET", "/expense-categories"), api("GET", "/inventory?limit=200")]);
  const billFields = [
    { name: "supplierId", label: "Supplier", type: "select", req: true, options: [["", "– choose –"], ...opt(suppliers, "name")] },
    { name: "supplierRef", label: "Their invoice no." },
    { name: "billDate", label: "Date", type: "date", value: today() },
    { name: "currency", label: "Currency", type: "select", options: ["NGN", "USD", "GBP", "EUR"].map((c) => [c, c]) },
    { name: "fxRate", label: "FX rate", type: "number", hint: "blank = saved rate" },
    { name: "paidFromAccountId", label: "Paid now from", type: "select", options: [["", "Not yet (on credit, Pro)"], ...opt(cash, (a) => a.name)] },
    { type: "heading", label: "What was bought" },
    { name: "line.description", label: "Description", req: true, full: true },
    { name: "line.amount", label: "Amount (bill currency, excl. VAT)", type: "money", req: true },
    { name: "line.vatPct", label: "VAT %", type: "number", value: 0 },
    { name: "line.category", label: "Expense category", type: "select", options: [["", "– (or pick an item) –"], ...cats.map((c) => [c, c])] },
    { name: "line.itemId", label: "For inventory item", type: "select", options: [["", "–"], ...stock.items.map((i) => [i.id, i.title])] },
    { name: "line.quantity", label: "Quantity (parts received)", type: "number" },
  ];
  const open = bills.filter((b) => ["open", "partially_paid"].includes(b.status));
  const payFields = [
    { name: "billId", label: "Bill", type: "select", req: true, options: [["", "– choose –"], ...open.map((b) => [b.id, `${b.number} · ${b.supplier_name} · ${b.currency} ${(b.balance / 100).toLocaleString()}`])] },
    { name: "amount", label: "Amount (bill currency)", type: "money", req: true },
    { name: "fxRate", label: "Today's rate (foreign bills)", type: "number" },
    { name: "discount", label: "Discount received", type: "money" },
    { name: "accountId", label: "Pay from", type: "select", options: opt(cash, (a) => a.name) },
  ];
  el.innerHTML = `<div class="grid"><div class="card"><h2>Record a supplier bill</h2>${form("bill", billFields, "Save bill")}</div>
      <div class="card"><h2>Pay a supplier</h2><p class="muted">Foreign bills: paying at a different rate posts the FX gain or loss automatically.</p>${form("paybill", payFields, "Pay")}</div></div>
    <div class="card"><h2>Bills</h2>${table(bills, [
      { label: "No.", k: "number" }, { label: "Date", k: "bill_date" }, { label: "Supplier", k: "supplier_name" }, { label: "Status", f: (r) => statusBadge(r.status) },
      { label: "Total", num: true, f: (r) => `${r.currency} ${(r.total / 100).toLocaleString()}` }, { label: "₦ at bill rate", num: true, f: (r) => naira(r.total_ngn) }, { label: "Balance", num: true, f: (r) => `${r.currency} ${(r.balance / 100).toLocaleString()}` },
    ])}</div>`;
  bind("bill", billFields, async (v) => {
    const l = v.line;
    const line = { description: l.description, amount: l.amount, vatRateBp: Math.round((l.vatPct ?? 0) * 100) };
    if (l.category) line.category = l.category;
    if (l.itemId) line.itemId = l.itemId;
    if (l.quantity) line.quantity = l.quantity;
    delete v.line;
    await act(() => api("POST", "/bills", { ...v, lines: [line] }), "Bill saved");
    route();
  });
  bind("paybill", payFields, async (v) => {
    const b = open.find((x) => x.id === v.billId);
    await act(() => api("POST", "/payments/pay-bills", { supplierId: b.supplier_id, currency: b.currency, fxRate: v.fxRate, amount: v.amount, method: "transfer", accountId: v.accountId, allocations: [{ billId: b.id, amount: v.amount, discount: v.discount }] }), "Payment recorded");
    route();
  });
};

// ---- expenses

VIEWS.expenses = async (el) => {
  const [list, cats, stock, cash] = await Promise.all([api("GET", `/expenses?from=${yearStart()}&limit=100`), api("GET", "/expense-categories"), api("GET", "/inventory?kind=vehicle&limit=200"), cashAccounts()]);
  const trips = me.organization.verticals.includes("haulage") ? await api("GET", "/trips?limit=50") : [];
  const fields = [
    { name: "date", label: "Date", type: "date", value: today() },
    { name: "category", label: "Category", type: "select", options: cats.map((c) => [c, c]) },
    { name: "description", label: "Description", req: true },
    { name: "amount", label: "Amount (excl. VAT)", type: "money", req: true },
    { name: "vatPct", label: "VAT %", type: "number", value: 0 },
    { name: "paidFromAccountId", label: "Paid from", type: "select", options: opt(cash, (a) => a.name) },
    { name: "itemId", label: "For this car (adds to its cost)", type: "select", options: [["", "– general expense –"], ...stock.items.map((i) => [i.id, i.title])] },
    ...(trips.length ? [{ name: "tripId", label: "For this trip", type: "select", options: [["", "–"], ...trips.map((t) => [t.id, `${t.number} ${t.origin}→${t.destination}`])] }] : []),
  ];
  el.innerHTML = `<div class="card"><h2>Log an expense</h2>${form("exp", fields, "Save expense")}</div>
    <div class="card"><h2>This year's expenses</h2>${table(list, [
      { label: "Date", k: "expense_date" }, { label: "Category", k: "category" }, { label: "Description", k: "description" }, { label: "Car", f: (r) => esc(r.item_title ?? "") + (r.capitalize ? " " + badge("added to cost") : "") },
      { label: "Amount", num: true, f: (r) => naira(r.amount_ngn) }, { label: "VAT", num: true, f: (r) => naira(r.vat_ngn) },
    ])}</div>`;
  bind("exp", fields, async (v) => {
    v.vatRateBp = Math.round((v.vatPct ?? 0) * 100);
    delete v.vatPct;
    await act(() => api("POST", "/expenses", v), "Expense saved");
    route();
  });
};

// ---- installments & fx

VIEWS.installments = async (el) => {
  const overdue = store.get("gr.overdue") === "1";
  const rows = await api("GET", `/installments/due?overdueOnly=${overdue}`);
  el.innerHTML = `<div class="card"><h2>Collections</h2><label class="check"><input type="checkbox" id="od" ${overdue ? "checked" : ""}> Overdue only</label>
    ${table(rows, [{ label: "Due", k: "due_date" }, { label: "Customer", f: (r) => `${esc(r.customer_name)}<br><small class="muted">${esc(r.customer_phone ?? "")}</small>` }, { label: "Invoice", k: "invoice_number" }, { label: "#", k: "seq" }, { label: "Balance", num: true, f: (r) => naira(r.balance) }, { label: "Status", f: (r) => statusBadge(r.status) }],
      { id: "due", empty: "No installments due. Create a plan when issuing an invoice.", onClick: (r) => (location.hash = `#/sales/${r.invoice_id}`) })}</div>`;
  $("#od").onchange = (e) => { store.set("gr.overdue", e.target.checked ? "1" : "0"); route(); };
};

VIEWS.fx = async (el) => {
  const rates = await api("GET", "/fx-rates");
  const fields = [{ name: "currency", label: "Currency", type: "select", options: ["USD", "GBP", "EUR", "CAD", "AED", "CNY", "JPY"].map((c) => [c, c]) }, { name: "rate", label: "₦ per 1 unit", type: "number", req: true }, { name: "date", label: "Date", type: "date", value: today() }];
  el.innerHTML = `<div class="card"><h2>Set the day's rate</h2>${form("fx", fields, "Save rate")}</div>
    <div class="card"><h2>Latest rates</h2>${table(rates, [{ label: "Currency", k: "currency" }, { label: "Date", k: "rate_date" }, { label: "₦ per unit", num: true, f: (r) => Number(r.rate).toLocaleString() }])}</div>`;
  bind("fx", fields, async (v) => { await act(() => api("PUT", "/fx-rates", { rates: [v] }), "Rate saved"); route(); });
};

// ---- reports

const REPORTS = {
  "profit-and-loss": { label: "Profit & loss", range: true },
  "balance-sheet": { label: "Balance sheet", asOf: true },
  "cash-flow": { label: "Cash flow", range: true },
  "vehicle-profit": { label: "Profit per car", range: true },
  analytics: { label: "Sales analytics", range: true },
  vat: { label: "VAT return", range: true },
  "ar-aging": { label: "Customer aging (AR)", asOf: true },
  "ap-aging": { label: "Supplier aging (AP)", asOf: true },
  "trial-balance": { label: "Trial balance", asOf: true },
};

VIEWS.reports = async (el, which = store.get("gr.report") ?? "profit-and-loss") => {
  const R = REPORTS[which] ?? REPORTS["profit-and-loss"];
  const from = store.get("gr.from") ?? yearStart(), to = store.get("gr.to") ?? today();
  el.innerHTML = `<div class="card"><div class="row">${Object.entries(REPORTS).map(([k, r]) => `<a class="btn ${k === which ? "primary" : ""}" href="#/reports/${k}">${esc(r.label)}</a>`).join("")}</div>
    <div class="row" style="margin-top:10px">${R.range ? `From <input type="date" id="from" value="${from}"> to` : "As of"} <input type="date" id="to" value="${to}"> <button class="btn" id="run">Run</button></div></div><div id="rep"></div>`;
  store.set("gr.report", which);
  const run = async () => {
    store.set("gr.from", $("#from")?.value ?? from);
    store.set("gr.to", $("#to").value);
    const q = R.range ? `?from=${$("#from").value}&to=${$("#to").value}` : `?asOf=${$("#to").value}`;
    try {
      const d = await api("GET", `/reports/${which}${q}`);
      $("#rep").innerHTML = RENDER[which](d);
    } catch (e) {
      $("#rep").innerHTML = upgradeNote(e);
    }
  };
  $("#run").onclick = run;
  await run();
};

const lineRows = (rows) => rows.map((r) => ({ name: `${r.code ?? ""} ${r.name ?? r.label}`, amount: r.amount }));
const section = (title, rows, total) => `<h3>${esc(title)}</h3>${table([...lineRows(rows), { name: "Total", amount: total, _class: "total" }], [{ label: "", k: "name" }, { label: "₦", num: true, f: (r) => naira(r.amount) }], { empty: "–" })}`;
const ok = (b, yes, no) => (b ? badge(yes, "good") : badge(no, "bad"));

const RENDER = {
  "profit-and-loss": (d) => `<div class="card"><h2>Profit & loss · ${d.from} to ${d.to}</h2>
    ${section("Revenue", d.revenue, d.totalRevenue)}${kv([["Less discounts allowed", naira(-d.discountsAllowed)], ["Net revenue", `<b>${naira(d.netRevenue)}</b>`]])}
    ${section("Cost of sales", d.costOfSales, d.totalCostOfSales)}${kv([["Gross profit", `<b>${naira(d.grossProfit)}</b> (${d.grossMarginPct}%)`]])}
    ${section("Operating expenses", d.operatingExpenses, d.totalOperatingExpenses)}${section("Other income", d.otherIncome, d.totalOtherIncome)}
    ${kv([["Net profit", `<b>${naira(d.netProfit)}</b>`]])}</div>`,
  "balance-sheet": (d) => `<div class="card"><h2>Statement of financial position · ${d.asOf} ${ok(d.balanced, "balanced", "NOT balanced")}</h2>
    <div class="grid"><div>${section("Current assets", d.assets.current, d.assets.current.reduce((s, r) => s + r.amount, 0))}${section("Non-current assets", d.assets.nonCurrent, d.assets.nonCurrent.reduce((s, r) => s + r.amount, 0))}${kv([["Total assets", `<b>${naira(d.assets.total)}</b>`]])}</div>
    <div>${section("Current liabilities", d.liabilities.current, d.liabilities.current.reduce((s, r) => s + r.amount, 0))}${section("Long-term liabilities", d.liabilities.longTerm, d.liabilities.longTerm.reduce((s, r) => s + r.amount, 0))}${section("Equity", d.equity.lines, d.equity.total)}${kv([["Liabilities + equity", `<b>${naira(d.totalLiabilitiesAndEquity)}</b>`]])}</div></div></div>`,
  "cash-flow": (d) => `<div class="card"><h2>Cash flow · ${d.from} to ${d.to} ${ok(d.reconciles, "reconciles", "does not reconcile")}</h2>${kv([["Opening cash", naira(d.openingCash)]])}
    ${section("Operating", d.operating.lines, d.operating.total)}${section("Investing", d.investing.lines, d.investing.total)}${section("Financing", d.financing.lines, d.financing.total)}
    ${kv([["Net change", naira(d.netChange)], ["Closing cash", `<b>${naira(d.closingCash)}</b>`]])}</div>`,
  "vehicle-profit": (d) => `<div class="card"><h2>Profit per car · ${d.count} sold</h2>${kv([["Sales", naira(d.totalSales)], ["Landed cost", naira(d.totalCost)], ["Profit", `<b>${naira(d.totalProfit)}</b>`], ["Average profit", naira(d.averageProfit)], ["Average days in stock", d.averageDaysInStock]])}
    ${table(d.vehicles, [{ label: "Car", k: "title" }, { label: "Sold", k: "sold_on" }, { label: "Customer", k: "customer_name" }, { label: "Sale", num: true, f: (r) => naira(r.net_sale) }, { label: "Cost", num: true, f: (r) => naira(r.landed_cost) }, { label: "Profit", num: true, f: (r) => naira(r.profit) }, { label: "Margin", num: true, f: (r) => `${r.marginPct}%` }, { label: "Days", num: true, k: "daysInStock" }])}</div>`,
  analytics: (d) => `<div class="card"><h2>Monthly</h2>${table(d.monthly, [{ label: "Month", k: "month" }, { label: "Income", num: true, f: (r) => naira(r.income) }, { label: "Expenses", num: true, f: (r) => naira(r.expenses) }, { label: "Profit", num: true, f: (r) => naira(r.profit) }])}</div>
    <div class="grid"><div class="card"><h2>Top models</h2>${table(d.topModels, [{ label: "Model", f: (r) => esc(`${r.make} ${r.model}`) }, { label: "Units", num: true, k: "units" }, { label: "Revenue", num: true, f: (r) => naira(r.revenue) }, { label: "Profit", num: true, f: (r) => naira(r.profit) }])}</div>
    <div class="card"><h2>Stock</h2>${kv([["Cars in stock", d.stock.vehicles_in_stock], ["Stock value (cost)", naira(d.stock.vehicle_stock_value)], ["At asking prices", naira(d.stock.vehicle_asking_value)], ["Parts stock value", naira(d.stock.parts_stock_value)], ["Parts to reorder", d.stock.parts_to_reorder]])}
    <h3>Slow movers</h3>${table(d.slowMovers, [{ label: "Car", k: "title" }, { label: "Days", num: true, k: "days_in_stock" }, { label: "Cost", num: true, f: (r) => naira(r.landed_cost_ngn) }])}</div></div>`,
  vat: (d) => `<div class="card"><h2>VAT · ${d.from} to ${d.to}</h2>${kv([["Sales excl. VAT", naira(d.salesExclVat)], ["Zero-rated / exempt sales", naira(d.zeroRatedOrExemptSales)], ["Output VAT (charged)", naira(d.outputVat)], ["Input VAT (paid)", naira(d.inputVat)], [d.position === "payable" ? "Net VAT payable to FIRS" : "Net VAT refundable", `<b>${naira(Math.abs(d.netVatPayable))}</b>`]])}</div>`,
  "ar-aging": (d) => agingView(d, "Customers who owe you"),
  "ap-aging": (d) => agingView(d, "Suppliers you owe"),
  "trial-balance": (d) => `<div class="card"><h2>Trial balance · ${d.asOf} ${ok(d.balanced, "balanced", "NOT balanced")}</h2>${table([...d.rows, { code: "", name: "Total", debit: d.totalDebit, credit: d.totalCredit, _class: "total" }], [{ label: "Account", f: (r) => esc(`${r.code} ${r.name}`) }, { label: "Debit", num: true, f: (r) => (r.debit ? naira(r.debit) : "") }, { label: "Credit", num: true, f: (r) => (r.credit ? naira(r.credit) : "") }])}</div>`,
};

function agingView(d, title) {
  const cols = [["current", "Current"], ["1_30", "1–30"], ["31_60", "31–60"], ["61_90", "61–90"], ["over_90", "90+"], ["total", "Total"]];
  return `<div class="card"><h2>${title} · ${d.asOf}</h2>${table([...d.contacts, { name: "Total", ...d.totals, _class: "total" }], [{ label: "Name", k: "name" }, ...cols.map(([k, l]) => ({ label: l, num: true, f: (r) => (r[k] ? naira(r[k]) : "") }))])}</div>`;
}

// ---- operations

VIEWS.workshop = async (el, id) => {
  if (id) {
    const j = await api("GET", `/job-cards/${id}`);
    const parts = await api("GET", "/inventory?kind=part&limit=200");
    const lf = [{ name: "kind", label: "Type", type: "select", options: [["labour", "Labour"], ["part", "Part"]] }, { name: "itemId", label: "Part from stock", type: "select", options: [["", "–"], ...parts.items.map((p) => [p.id, `${p.title} (${p.quantity})`])] }, { name: "description", label: "Description" }, { name: "quantity", label: "Qty", type: "number", value: 1 }, { name: "unitPrice", label: "Price", type: "money" }];
    el.innerHTML = `<div class="row"><a href="#/workshop">← Job cards</a></div>
      <div class="card"><h2>${esc(j.number)} · ${esc(j.vehicle_desc ?? "")} ${statusBadge(j.status)}</h2>${kv([["Customer", esc(j.customer_name)], ["Plate", esc(j.plate_number ?? "–")], ["Complaint", esc(j.complaint ?? "–")], ["Diagnosis", esc(j.diagnosis ?? "–")], ["Estimate", naira(j.estimate)]])}
        <div class="row" style="margin-top:10px">${["in_progress", "completed", "cancelled"].map((s) => `<button class="btn" data-s="${s}">Mark ${s.replace("_", " ")}</button>`).join("")}<button class="btn primary" id="inv-job">Invoice the customer</button></div></div>
      <div class="card"><h2>Labour & parts</h2>${table(j.lines, [{ label: "Type", k: "kind" }, { label: "Description", k: "description" }, { label: "Qty", num: true, k: "quantity" }, { label: "Price", num: true, f: (r) => naira(r.unit_price) }])}<h3>Add line</h3>${form("jl", lf, "Add line")}</div>`;
    $$("[data-s]", el).forEach((b) => (b.onclick = async () => { await act(() => api("POST", `/job-cards/${id}/status`, { status: b.dataset.s }), "Updated"); route(); }));
    $("#inv-job").onclick = async () => { const inv = await act(() => api("POST", `/job-cards/${id}/invoice`, {}), "Invoiced"); location.hash = `#/sales/${inv.id}`; };
    bind("jl", lf, async (v) => { await act(() => api("POST", `/job-cards/${id}/lines`, v), "Added"); route(); });
    return;
  }
  const [jobs, customers] = await Promise.all([api("GET", "/job-cards"), contacts("customer")]);
  const f = [{ name: "customerId", label: "Customer", type: "select", req: true, options: [["", "– choose –"], ...opt(customers, "name")] }, { name: "vehicleDesc", label: "Vehicle", hint: "2016 Toyota Corolla" }, { name: "plateNumber", label: "Plate" }, { name: "odometerKm", label: "Odometer", type: "number" }, { name: "complaint", label: "Complaint", full: true }];
  el.innerHTML = `<div class="card"><h2>New job card</h2>${form("job", f, "Open job card")}</div><div class="card"><h2>Job cards</h2>${table(jobs, [{ label: "No.", k: "number" }, { label: "Customer", k: "customer_name" }, { label: "Vehicle", k: "vehicle_desc" }, { label: "Status", f: (r) => statusBadge(r.status) }], { id: "jobs", onClick: (r) => (location.hash = `#/workshop/${r.id}`) })}</div>`;
  bind("job", f, async (v) => { const j = await act(() => api("POST", "/job-cards", v), "Job card opened"); location.hash = `#/workshop/${j.id}`; });
};

VIEWS.haulage = async (el) => {
  const [fleet, trips, customers] = await Promise.all([api("GET", "/fleet"), api("GET", "/trips"), contacts("customer")]);
  const ff = [{ name: "kind", label: "Type", type: "select", options: [["car_carrier", "Car carrier"], ["truck", "Truck"], ["tow_truck", "Tow truck"], ["trailer", "Trailer"], ["van", "Van"]] }, { name: "plateNumber", label: "Plate", req: true }, { name: "capacity", label: "Capacity", hint: "8 cars" }];
  const tf = [{ name: "customerId", label: "Customer", type: "select", req: true, options: [["", "– choose –"], ...opt(customers, "name")] }, { name: "assetId", label: "Truck", type: "select", options: [["", "–"], ...opt(fleet, "plate_number")] }, { name: "origin", label: "From", req: true, value: "Apapa, Lagos" }, { name: "destination", label: "To", req: true, value: "Abuja" }, { name: "cargo", label: "Cargo" }, { name: "rateNgn", label: "Rate", type: "money", req: true }, { name: "driverName", label: "Driver" }];
  el.innerHTML = `<div class="grid"><div class="card"><h2>Add a truck</h2>${form("truck", ff, "Add truck")}</div><div class="card"><h2>Book a trip</h2>${form("trip", tf, "Book trip")}</div></div>
    <div class="card"><h2>Trips</h2>${table(trips, [{ label: "No.", k: "number" }, { label: "Route", f: (r) => esc(`${r.origin} → ${r.destination}`) }, { label: "Customer", k: "customer_name" }, { label: "Truck", k: "truck_plate" }, { label: "Rate", num: true, f: (r) => naira(r.rate_ngn) }, { label: "Status", f: (r) => statusBadge(r.status) },
      { label: "", f: (r) => ({ booked: `<button class="btn small" data-t="${r.id}" data-s="in_transit">Depart</button>`, in_transit: `<button class="btn small" data-t="${r.id}" data-s="delivered">Delivered</button>`, delivered: `<button class="btn small primary" data-inv="${r.id}">Invoice</button>` })[r.status] ?? "" }])}
      <p class="muted">Log fuel and tolls under Expenses with the trip selected to see profit per trip.</p></div>`;
  bind("truck", ff, async (v) => { await act(() => api("POST", "/fleet", v), "Truck added"); route(); });
  bind("trip", tf, async (v) => { await act(() => api("POST", "/trips", v), "Trip booked"); route(); });
  $$("[data-t]", el).forEach((b) => (b.onclick = async () => { await act(() => api("POST", `/trips/${b.dataset.t}/status`, { status: b.dataset.s }), "Updated"); route(); }));
  $$("[data-inv]", el).forEach((b) => (b.onclick = async () => { const inv = await act(() => api("POST", `/trips/${b.dataset.inv}/invoice`, {}), "Invoiced"); location.hash = `#/sales/${inv.id}`; }));
};

VIEWS.rentals = async (el) => {
  const [bookings, customers, cars] = await Promise.all([api("GET", "/rentals"), contacts("customer"), api("GET", "/inventory?kind=vehicle&rentable=true&limit=100")]);
  const f = [{ name: "customerId", label: "Customer", type: "select", req: true, options: [["", "– choose –"], ...opt(customers, "name")] }, { name: "itemId", label: "Car", type: "select", req: true, options: [["", "– rental cars –"], ...cars.items.map((c) => [c.id, `${c.title} · ${naira(c.daily_rate_ngn)}/day`])] }, { name: "startDate", label: "From", type: "date", value: today() }, { name: "endDate", label: "To", type: "date", req: true }, { name: "depositNgn", label: "Security deposit", type: "money" }, { name: "collect", label: "Collect deposit now (transfer)", type: "check" }];
  el.innerHTML = `${cars.items.length ? "" : '<div class="callout">Add a car under Inventory and tick “Rental fleet car” first.</div>'}
    <div class="card"><h2>New booking</h2>${form("book", f, "Book")}</div>
    <div class="card"><h2>Bookings</h2>${table(bookings, [{ label: "No.", k: "number" }, { label: "Car", k: "vehicle_title" }, { label: "Customer", k: "customer_name" }, { label: "Dates", f: (r) => `${r.start_date} → ${r.end_date}` }, { label: "Status", f: (r) => statusBadge(r.status) },
      { label: "", f: (r) => ({ reserved: `<button class="btn small" data-a="check-out" data-b="${r.id}">Check out</button>`, active: `<button class="btn small" data-a="check-in" data-b="${r.id}">Check in</button>`, returned: `<button class="btn small primary" data-a="invoice" data-b="${r.id}">Invoice</button>` })[r.status] ?? "" }])}</div>`;
  bind("book", f, async (v) => {
    const body = { ...v };
    delete body.collect;
    if (v.collect) body.collectDeposit = { method: "transfer" };
    await act(() => api("POST", "/rentals", body), "Booked");
    route();
  });
  $$("[data-a]", el).forEach((b) => (b.onclick = async () => {
    const r = await act(() => api("POST", `/rentals/${b.dataset.b}/${b.dataset.a}`, {}), "Done");
    if (b.dataset.a === "invoice") location.hash = `#/sales/${r.id}`;
    else route();
  }));
};

// ---- growth

VIEWS.marketplace = async (el) => {
  const [status, leads] = await Promise.all([api("GET", "/marketplace/status"), api("GET", "/leads")]);
  el.innerHTML = `<div class="card"><h2>Listing sync</h2>${kv(Object.entries(status.counts).map(([k, n]) => [k, n]))}
      ${status.errors.length ? table(status.errors, [{ label: "Item", k: "title" }, { label: "Error", k: "marketplace_error" }]) : ""}
      <p class="muted">Without GREENREV_MARKETPLACE_URL set, the API uses a local log-only marketplace, so items show as listed with a local id.</p><button class="btn" id="resync">Resync everything now</button></div>
    <div class="card"><h2>Buyer leads from greenrevs.com</h2>${table(leads, [{ label: "When", f: (r) => esc(r.created_at.slice(0, 16).replace("T", " ")) }, { label: "Buyer", f: (r) => esc(`${r.buyer_name ?? ""} ${r.buyer_phone ?? ""}`) }, { label: "About", k: "item_title" }, { label: "Message", k: "message" }, { label: "Status", f: (r) => statusBadge(r.status) }], { empty: "No leads yet. They arrive through the /webhooks/greenrev webhook." })}</div>`;
  $("#resync").onclick = async () => { const r = await act(() => api("POST", "/marketplace/resync")); toast(`Pushed ${r.processed} updates`); route(); };
};

VIEWS.ai = async (el) => {
  const credits = await api("GET", "/ai/credits");
  el.innerHTML = `<div class="callout">AI credits this month: <b>${credits.used} / ${credits.limit}</b>. Photo and document features need ANTHROPIC_API_KEY in the API's .env; VIN decoding is free.</div>
    <div class="grid">
      <div class="card"><h2>Decode a VIN</h2><div class="row"><input id="vin" placeholder="e.g. 1HGCM82633A004352" style="flex:1;padding:7px;border:1px solid var(--line);border-radius:8px"><button class="btn primary" id="vin-go">Decode</button></div><div id="vin-out"></div></div>
      <div class="card"><h2>Photos → vehicle record</h2><form id="intake"><input type="file" name="photos" accept="image/*" multiple required><label class="check"><input type="checkbox" name="create" value="true"> Save as a draft vehicle</label><button class="btn primary">Read photos</button></form></div>
      <div class="card"><h2>VIN plate photo</h2><form id="vinscan"><input type="file" name="photo" accept="image/*" required><button class="btn primary">Scan VIN</button></form></div>
      <div class="card"><h2>Receipt / supplier invoice → draft</h2><form id="doc"><input type="file" name="file" accept="image/*,application/pdf" required><button class="btn primary">Read document</button></form></div>
      <div class="card"><h2>Identify a spare part</h2><form id="part"><input type="file" name="photos" accept="image/*" multiple required><button class="btn primary">Identify</button></form></div>
    </div><div class="card"><h2>Result</h2><pre class="json" id="ai-out">–</pre></div>`;
  const show = (r) => ($("#ai-out").textContent = JSON.stringify(r, null, 2));
  $("#vin-go").onclick = async () => show(await act(() => api("GET", `/ai/vin/${encodeURIComponent($("#vin").value.trim())}`)));
  for (const [id, path] of [["intake", "/ai/vehicle-intake"], ["vinscan", "/ai/vin-scan"], ["doc", "/ai/document"], ["part", "/ai/part-identify"]]) {
    $(`#${id}`).onsubmit = async (e) => {
      e.preventDefault();
      $("#ai-out").textContent = "Working…";
      try { show(await act(() => api("POST", path, new FormData(e.target)), "Done")); } catch (err) { $("#ai-out").textContent = err.message; }
    };
  }
};

// ---- admin

VIEWS.settings = async (el) => {
  const [org, members, plans] = await Promise.all([api("GET", "/me"), api("GET", "/organization/members"), api("GET", "/plans")]);
  const o = org.organization;
  const sf = [
    { name: "name", label: "Business name", value: o.name }, { name: "phone", label: "Phone", value: o.phone }, { name: "whatsapp", label: "WhatsApp", value: o.whatsapp }, { name: "city", label: "City", value: o.city }, { name: "state", label: "State", value: o.state },
    { name: "vatRegistered", label: "VAT registered", type: "check", value: o.vat_registered }, { name: "autoPublish", label: "List new stock on greenrevs.com automatically", type: "check", value: o.auto_publish },
    { type: "heading", label: "Business lines" },
    ...["dealer", "mechanic", "parts_vendor", "haulage", "rental"].map((v) => ({ name: `v_${v}`, label: v.replace("_", " "), type: "check", value: o.verticals.includes(v) })),
  ];
  const mf = [{ name: "email", label: "Email", type: "email", req: true }, { name: "role", label: "Role", type: "select", options: ["admin", "accountant", "sales", "mechanic", "dispatcher", "viewer"].map((r) => [r, r]) }];
  el.innerHTML = `<div class="grid"><div class="card"><h2>Business settings</h2>${form("org", sf, "Save settings")}</div>
      <div class="card"><h2>Team</h2>${table(members, [{ label: "Name", k: "full_name" }, { label: "Email", k: "email" }, { label: "Role", f: (r) => badge(r.role) }])}<h3>Invite</h3>${form("inv-m", mf, "Invite")}<div id="invite-out"></div></div></div>
    <div class="card"><h2>Packages</h2>${table(plans, [{ label: "Package", f: (r) => `<b>${esc(r.name)}</b><br><small class="muted">${esc(r.tagline)}</small>` }, { label: "Monthly", num: true, f: (r) => naira(r.priceMonthlyKobo) }, { label: "Users", num: true, f: (r) => r.limits.users ?? "∞" }, { label: "Cars", num: true, f: (r) => r.limits.vehicles ?? "∞" }, { label: "AI/month", num: true, f: (r) => r.limits.aiCreditsMonthly }, { label: "Features", f: (r) => esc(r.features.join(", ")) }])}
      <p class="muted">You are on <b>${esc(o.planDetails.name)}</b> (${esc(o.plan_status)}). Checkout needs PAYSTACK_SECRET_KEY on the API.</p></div>`;
  bind("org", sf, async (v) => {
    v.verticals = ["dealer", "mechanic", "parts_vendor", "haulage", "rental"].filter((k) => v[`v_${k}`]);
    for (const k of Object.keys(v)) if (k.startsWith("v_")) delete v[k];
    await act(() => api("PATCH", "/organization", v), "Saved");
    await boot();
  });
  bind("inv-m", mf, async (v) => {
    const r = await act(() => api("POST", "/organization/members", v));
    $("#invite-out").innerHTML = r.added ? `<p>Added ${esc(r.email)}.</p>` : `<p>Invite token (send it to them; they accept at <code>POST /auth/accept-invite</code>):</p><code>${esc(r.inviteToken)}</code>`;
  });
};

VIEWS.console = async (el) => {
  el.innerHTML = `<div class="card"><h2>Call any endpoint</h2><p class="muted">Every endpoint is listed at <a href="${API}/docs" target="_blank" rel="noopener">${API}/docs</a>. Money is in kobo here (₦1 = 100).</p>
    <form id="raw" class="f"><label class="fl">Method<select name="m">${["GET", "POST", "PATCH", "PUT", "DELETE"].map((m) => `<option>${m}</option>`).join("")}</select></label><label class="fl full">Path<input name="p" value="/reports/trial-balance"></label><label class="fl full">JSON body<textarea name="b" rows="5"></textarea></label><div class="full"><button class="btn primary">Send</button></div></form></div>
    <div class="card"><h2>Response</h2><pre class="json" id="raw-out">–</pre></div>`;
  $("#raw").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(f.m.value, f.p.value, f.b.value.trim() ? JSON.parse(f.b.value) : undefined);
      $("#raw-out").textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      $("#raw-out").textContent = `${err.status ?? ""} ${err.message}\n${JSON.stringify(err.data ?? {}, null, 2)}`;
    }
  };
};

boot();
