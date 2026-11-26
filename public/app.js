const API = "/api";
let token = localStorage.getItem("campusToken") || "";
let currentUser = null;
let authMode = "login";
let activeItem = null;
const $ = (selector) => document.querySelector(selector);
const toast = (message) => {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
};
async function request(path, options = {}) {
  const headers = options.headers || {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!(options.body instanceof FormData) && options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Something went wrong");
  return data;
}
function setSession(data) {
  token = data.token; currentUser = data.user;
  localStorage.setItem("campusToken", token);
  updateNavigation(); toast(`Welcome, ${currentUser.name}`);
  $("#authDialog").close(); loadItems();
}
function updateNavigation() {
  $("#loginOpen").classList.toggle("hidden", !!token);
  $("#logoutBtn").classList.toggle("hidden", !token);
  $("#reportOpen").textContent = token ? "My dashboard" : "+ Report item";
  $("#adminTab").classList.toggle("hidden", currentUser?.role !== "admin");
}
async function loadMe() {
  if (!token) return updateNavigation();
  try { const data = await request("/auth/me"); currentUser = data.user; updateNavigation(); }
  catch { token = ""; currentUser = null; localStorage.removeItem("campusToken"); updateNavigation(); }
}
async function loadItems() {
  const params = new URLSearchParams();
  const values = { search: $("#searchInput").value.trim(), type: $("#typeFilter").value, category: $("#categoryFilter").value, location: $("#locationFilter").value.trim(), sort: $("#sortFilter").value };
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  $("#itemGrid").innerHTML = '<div class="loading">Finding campus listings...</div>';
  try {
    const data = await request(`/items?${params}`);
    $("#resultCount").textContent = `${data.count} item${data.count === 1 ? "" : "s"} found`;
    $("#totalItems").textContent = data.count;
    $("#lostCount").textContent = data.items.filter(x => x.type === "lost").length;
    $("#foundCount").textContent = data.items.filter(x => x.type === "found").length;
    if (!data.items.length) { $("#itemGrid").innerHTML = '<div class="empty">No matching items yet. Try changing your filters.</div>'; return; }
    $("#itemGrid").innerHTML = data.items.map(itemCard).join("");
  } catch (error) { $("#itemGrid").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function itemCard(item) {
  const icon = ({ Electronics: "▣", Books: "▤", "ID Cards": "▧", Bags: "▱", Clothing: "◇", Accessories: "✧", Other: "◈" })[item.category] || "◈";
  const image = item.image ? `<img src="${item.image}" alt="${escapeHtml(item.title)}">` : icon;
  return `<article class="item-card"><div class="item-image">${image}</div><div class="item-body">
    <div class="item-top"><span class="pill ${item.type}">${item.type}</span><span class="pill">${escapeHtml(item.status)}</span></div>
    <h3>${escapeHtml(item.title)}</h3><p class="item-desc">${escapeHtml(item.description)}</p>
    <div class="item-meta"><span>⌖ ${escapeHtml(item.location)}</span><span>◷ ${new Date(item.date).toLocaleDateString()}</span></div>
    <div class="item-footer"><span>${escapeHtml(item.category)} · ${escapeHtml(item.owner?.name || "Campus member")}</span>
    ${token && item.status === "open" && item.type === "found" && item.owner?._id !== currentUser?.id ? `<button class="claim-btn" data-claim="${item._id}">Claim item →</button>` : `<span>Campus listing</span>`}</div>
  </div></article>`;
}
function openAuth(mode = "login") {
  authMode = mode; $("#authTitle").textContent = mode === "login" ? "Welcome back." : "Create your account.";
  $("#authSubmit").textContent = mode === "login" ? "Login" : "Create account";
  $("#nameField").classList.toggle("hidden", mode === "login");
  $("#authForm").elements.name.required = mode === "register";
  $("#authSwitch").innerHTML = mode === "login" ? 'New here? <button type="button" id="switchMode">Create an account</button>' : 'Already registered? <button type="button" id="switchMode">Login</button>';
  $("#authDialog").showModal();
}
$("#authSwitch").addEventListener("click", e => { if (e.target.id === "switchMode") openAuth(authMode === "login" ? "register" : "login"); });
$("#authForm").addEventListener("submit", async e => {
  e.preventDefault(); const form = new FormData(e.target); const body = Object.fromEntries(form.entries());
  try { setSession(await request(`/auth/${authMode}`, { method: "POST", body: JSON.stringify(body) })); e.target.reset(); }
  catch (error) { toast(error.message); }
});
function openReport() {
  if (!token) return openAuth();
  $("#reportDialog").showModal();
}
$("#reportForm").addEventListener("submit", async e => {
  e.preventDefault(); const form = new FormData(e.target);
  try { await request("/items", { method: "POST", body: form }); $("#reportDialog").close(); e.target.reset(); toast("Your report has been published"); loadItems(); }
  catch (error) { toast(error.message); }
});
$("#itemGrid").addEventListener("click", e => {
  const button = e.target.closest("[data-claim]");
  if (!button) return;
  activeItem = button.dataset.claim;
  const card = button.closest(".item-card");
  $("#claimItemName").textContent = card.querySelector("h3").textContent;
  $("#claimForm").elements.itemId.value = activeItem;
  $("#claimDialog").showModal();
});
$("#claimForm").addEventListener("submit", async e => {
  e.preventDefault(); const form = new FormData(e.target);
  try { await request("/claims", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); $("#claimDialog").close(); e.target.reset(); toast("Claim sent to the listing owner"); }
  catch (error) { toast(error.message); }
});
async function showDashboard(tab = "myItems") {
  if (!token) return openAuth();
  $("#dashboardDialog").showModal();
  document.querySelectorAll(".dashboard-tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  const content = $("#dashboardContent"); content.innerHTML = '<div class="loading">Loading your dashboard...</div>';
  try {
    if (tab === "admin") {
      const stats = await request("/admin/stats");
      content.innerHTML = `<div class="stats-strip">${Object.entries(stats).map(([k,v]) => `<div><strong>${v}</strong><span>${k.replace(/[A-Z]/g, x => " "+x.toLowerCase())}</span></div>`).join("")}</div>`;
      return;
    }
    const endpoint = { myItems: "/items/mine", myClaims: "/claims/mine", receivedClaims: "/claims/received" }[tab];
    const data = await request(endpoint);
    const records = data.items || data.claims || [];
    if (!records.length) { content.innerHTML = '<div class="empty">Nothing here yet.</div>'; return; }
    content.innerHTML = records.map(record => {
      const isClaim = !!record.claimant || !!record.item;
      const item = isClaim ? record.item : record;
      const title = item?.title || "Item";
      const status = isClaim ? record.status : record.status;
      const action = tab === "receivedClaims" && status === "pending" ? `<span><button data-review="${record._id}" data-status="approved">Approve</button> <button data-review="${record._id}" data-status="rejected">Reject</button></span>` : "";
      return `<div class="dash-row"><div><b>${escapeHtml(title)}</b><small>${isClaim ? `Claim by ${escapeHtml(record.claimant?.name || "you")}` : `${escapeHtml(record.type)} · ${escapeHtml(record.location)}`} · ${new Date(record.createdAt).toLocaleDateString()}</small></div><span>${escapeHtml(status)} ${action}</span></div>`;
    }).join("");
  } catch (error) { content.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
document.querySelector(".dashboard-tabs").addEventListener("click", e => {
  const tab = e.target.closest("[data-tab]"); if (tab) showDashboard(tab.dataset.tab);
});
$("#dashboardContent").addEventListener("click", async e => {
  const button = e.target.closest("[data-review]"); if (!button) return;
  try { await request(`/claims/${button.dataset.review}/status`, { method: "PATCH", body: JSON.stringify({ status: button.dataset.status }) }); toast(`Claim ${button.dataset.status}`); showDashboard("receivedClaims"); }
  catch (error) { toast(error.message); }
});
$("#loginOpen").addEventListener("click", () => openAuth("login"));
$("#reportOpen").addEventListener("click", () => token ? showDashboard() : openReport());
$("#heroReport").addEventListener("click", openReport);
$("#logoutBtn").addEventListener("click", () => { token = ""; currentUser = null; localStorage.removeItem("campusToken"); updateNavigation(); toast("Logged out"); });
$("#reportOpen").addEventListener("contextmenu", e => e.preventDefault());
$("#searchBtn").addEventListener("click", loadItems);
$("#refreshBtn").addEventListener("click", loadItems);
$("#searchInput").addEventListener("keydown", e => { if (e.key === "Enter") loadItems(); });
["typeFilter", "categoryFilter", "sortFilter"].forEach(id => $(`#${id}`).addEventListener("change", loadItems));
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); }));
(async function init() { await loadMe(); await loadItems(); })();
