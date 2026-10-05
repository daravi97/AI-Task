'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString();

const state = { user: null, balance: 0, products: [], cart: loadCart(), chatHistory: [] };

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') showLogin();
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function setBalance(n) {
  state.balance = n;
  $('#balance').textContent = n;
  $('#wallet-balance').textContent = n;
  renderCart();
}

// ---------- Auth ----------
function showLogin() {
  state.user = null;
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

async function boot() {
  try {
    const me = await api('/me');
    state.user = me.user;
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#user-name').textContent = me.user.name;
    $$('.admin-only').forEach((el) => el.classList.toggle('hidden', me.user.role !== 'admin'));
    $('#chat-mode').textContent = me.assistantMode === 'claude' ? 'AI assistant' : 'FAQ assistant';
    setBalance(me.balance);
    if (state.chatHistory.length === 0) {
      addChat('bot', `Hi ${me.user.name.split(' ')[0]}! 👋 I can answer questions about tokens, orders and our merchandise.`);
    }
    await loadProducts();
    route();
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    e.target.reset();
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  state.chatHistory = [];
  $('#chat-log').innerHTML = '';
  // Don't carry one person's cart or page over to the next login on a shared machine.
  state.cart = [];
  saveCart();
  history.replaceState(null, '', location.pathname);
  showLogin();
});

// ---------- Routing ----------
const VIEWS = { shop: renderShop, orders: renderOrders, wallet: renderWallet, admin: renderAdmin };

function route() {
  let view = location.hash.slice(1) || 'shop';
  if (!VIEWS[view] || (view === 'admin' && state.user?.role !== 'admin')) view = 'shop';
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  VIEWS[view]();
}
window.addEventListener('hashchange', () => state.user && route());

// ---------- Shop ----------
async function loadProducts() {
  state.products = await api('/products');
  const cats = [...new Set(state.products.map((p) => p.category))].sort();
  const sel = $('#category');
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  sel.value = current;
  // Drop cart lines for products that no longer exist.
  state.cart = state.cart.filter((l) => state.products.some((p) => p.id === l.productId));
  renderCart();
}

function renderShop() {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#category').value;
  const list = state.products.filter((p) =>
    (!cat || p.category === cat) && (!q || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q)));
  $('#products').innerHTML = list.length ? list.map((p) => `
    <div class="card product">
      <div class="icon">${esc(p.image)}</div>
      <div class="row between"><span class="name">${esc(p.name)}</span><span class="tag">${esc(p.category)}</span></div>
      <div class="desc">${esc(p.description)}</div>
      <div class="meta">
        <span class="price">🪙 ${p.price}</span>
        <span class="small ${p.stock ? 'muted' : 'negative'}">${p.stock ? `${p.stock} in stock` : 'Out of stock'}</span>
      </div>
      <button class="btn primary" data-add="${p.id}" ${p.stock ? '' : 'disabled'}>Add to cart</button>
    </div>`).join('') : '<p class="muted">No products match your search.</p>';
}
$('#search').addEventListener('input', renderShop);
$('#category').addEventListener('change', renderShop);
$('#products').addEventListener('click', (e) => {
  const id = Number(e.target.dataset.add);
  if (!id) return;
  const p = state.products.find((x) => x.id === id);
  const line = state.cart.find((l) => l.productId === id);
  if ((line?.quantity ?? 0) >= p.stock) return toast(`Only ${p.stock} in stock`);
  if (line) line.quantity++; else state.cart.push({ productId: id, quantity: 1 });
  saveCart();
  toast(`Added ${p.name} to cart`);
});

// ---------- Cart ----------
function loadCart() {
  try { return JSON.parse(localStorage.getItem('cart')) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem('cart', JSON.stringify(state.cart)); } catch { /* storage unavailable */ }
  renderCart();
}

function cartTotal() {
  return state.cart.reduce((sum, l) => sum + (state.products.find((p) => p.id === l.productId)?.price ?? 0) * l.quantity, 0);
}

function renderCart() {
  $('#cart-count').textContent = state.cart.reduce((n, l) => n + l.quantity, 0);
  const total = cartTotal();
  $('#cart-total').textContent = total;
  const after = state.balance - total;
  $('#cart-after').textContent = after;
  $('#cart-after').className = after < 0 ? 'negative' : '';
  $('#checkout-btn').disabled = state.cart.length === 0 || after < 0;
  $('#cart-error').textContent = after < 0 ? 'Not enough tokens for this cart.' : '';
  $('#cart-items').innerHTML = state.cart.length ? state.cart.map((l) => {
    const p = state.products.find((x) => x.id === l.productId);
    if (!p) return '';
    return `<div class="cart-line">
      <span style="font-size:1.6rem">${esc(p.image)}</span>
      <div class="grow"><div>${esc(p.name)}</div><div class="small muted">🪙 ${p.price} each</div></div>
      <div class="qty">
        <button class="btn sm" data-dec="${p.id}">−</button><span>${l.quantity}</span><button class="btn sm" data-inc="${p.id}">+</button>
      </div>
    </div>`;
  }).join('') : '<p class="muted">Your cart is empty.</p>';
}

$('#cart-btn').addEventListener('click', () => $('#cart').classList.toggle('hidden'));
$('#cart-close').addEventListener('click', () => $('#cart').classList.add('hidden'));
$('#cart-items').addEventListener('click', (e) => {
  const inc = Number(e.target.dataset.inc);
  const dec = Number(e.target.dataset.dec);
  const id = inc || dec;
  if (!id) return;
  const line = state.cart.find((l) => l.productId === id);
  const p = state.products.find((x) => x.id === id);
  if (inc && line.quantity >= p.stock) return toast(`Only ${p.stock} in stock`);
  line.quantity += inc ? 1 : -1;
  state.cart = state.cart.filter((l) => l.quantity > 0);
  saveCart();
});

$('#checkout-btn').addEventListener('click', async () => {
  const total = cartTotal();
  if (!confirm(`Spend ${total} tokens on this order?`)) return;
  $('#checkout-btn').disabled = true;
  try {
    const { order, balance } = await api('/orders', { method: 'POST', body: { items: state.cart } });
    state.cart = [];
    saveCart();
    setBalance(balance);
    $('#cart').classList.add('hidden');
    toast(`Order #${order.id} placed! 🎉`);
    await loadProducts();
    location.hash = '#orders';
    route();
  } catch (err) {
    renderCart();
    $('#cart-error').textContent = err.message;
  }
});

// ---------- Orders ----------
function orderCard(o, { admin = false } = {}) {
  const actions = admin
    ? `<select data-status="${o.id}" ${o.status === 'cancelled' ? 'disabled' : ''}>
         ${['pending', 'processing', 'ready', 'collected', 'cancelled'].map((s) => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
       </select>`
    : (o.status === 'pending' ? `<button class="btn danger sm" data-cancel="${o.id}">Cancel & refund</button>` : '');
  return `<div class="card order">
    <div class="order-head">
      <strong>Order #${o.id}${admin ? ` · ${esc(o.user_name)}` : ''}</strong>
      <span class="status ${o.status}">${o.status}</span>
    </div>
    <div class="small muted">${fmtDate(o.created_at)}</div>
    <ul>${o.items.map((i) => `<li>${i.quantity} × ${esc(i.product_name)} <span class="muted">(🪙 ${i.unit_price} each)</span></li>`).join('')}</ul>
    <div class="row between"><strong>🪙 ${o.total}</strong>${actions}</div>
  </div>`;
}

async function renderOrders() {
  const orders = await api('/orders');
  $('#orders-list').innerHTML = orders.length ? orders.map((o) => orderCard(o)).join('')
    : '<p class="muted">No orders yet — visit the <a href="#shop">Shop</a>.</p>';
}
$('#orders-list').addEventListener('click', async (e) => {
  const id = e.target.dataset.cancel;
  if (!id || !confirm(`Cancel order #${id}? Your tokens will be refunded.`)) return;
  try {
    const { balance } = await api(`/orders/${id}/cancel`, { method: 'POST' });
    setBalance(balance);
    toast('Order cancelled and tokens refunded');
    await loadProducts();
    renderOrders();
  } catch (err) { toast(err.message); }
});

// ---------- Wallet ----------
async function renderWallet() {
  const { balance, ledger } = await api('/wallet');
  setBalance(balance);
  $('#ledger').innerHTML = ledger.length ? ledger.map((l) => `<tr>
    <td>${fmtDate(l.created_at)}</td>
    <td style="text-transform:capitalize">${esc(l.type)}</td>
    <td>${esc(l.reason)}${l.awarded_by && l.type === 'award' ? ` <span class="muted small">— from ${esc(l.awarded_by)}</span>` : ''}</td>
    <td class="num ${l.amount > 0 ? 'positive' : 'negative'}">${l.amount > 0 ? '+' : ''}${l.amount}</td>
  </tr>`).join('') : '<tr><td colspan="4" class="muted">No transactions yet.</td></tr>';
}

// ---------- Admin ----------
let adminTab = 'award';
$$('.tab').forEach((t) => t.addEventListener('click', () => { adminTab = t.dataset.tab; renderAdmin(); }));

function renderAdmin() {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === adminTab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${adminTab}`));
  ({ award: renderAward, aorders: renderAdminOrders, aproducts: renderAdminProducts, afaqs: renderAdminFaqs })[adminTab]();
}

async function renderAward() {
  const users = await api('/admin/users');
  $('#award-users').innerHTML = users.map((u) =>
    `<label><input type="checkbox" value="${u.id}" /> ${esc(u.name)} <span class="muted small">${esc(u.department || '')}</span></label>`).join('');
  $('#staff-table').innerHTML = users.map((u) => `<tr>
    <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.department)}</td><td>${esc(u.role)}</td><td class="num">${u.balance}</td>
  </tr>`).join('');
}
$('#award-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const userIds = $$('#award-users input:checked').map((i) => Number(i.value));
  try {
    const r = await api('/admin/award', { method: 'POST', body: { userIds, amount: Number(f.get('amount')), reason: f.get('reason') } });
    toast(`Awarded ${r.amount} tokens to ${r.awarded} staff 🎉`);
    e.target.reset();
    if (userIds.includes(state.user.id)) setBalance((await api('/wallet')).balance);
    renderAward();
  } catch (err) { toast(err.message); }
});

async function renderAdminOrders() {
  const status = $('#order-filter').value;
  const orders = await api(`/admin/orders${status ? `?status=${status}` : ''}`);
  $('#admin-orders').innerHTML = orders.length ? orders.map((o) => orderCard(o, { admin: true })).join('') : '<p class="muted">No orders.</p>';
}
$('#order-filter').addEventListener('change', renderAdminOrders);
$('#admin-orders').addEventListener('change', async (e) => {
  const id = e.target.dataset.status;
  if (!id) return;
  const status = e.target.value;
  if (status === 'cancelled' && !confirm(`Cancel order #${id} and refund the tokens?`)) return renderAdminOrders();
  try {
    await api(`/admin/orders/${id}/status`, { method: 'PUT', body: { status } });
    toast(`Order #${id} → ${status}`);
    if (status === 'cancelled') await loadProducts();
  } catch (err) { toast(err.message); }
  renderAdminOrders();
});

let adminProducts = [];
async function renderAdminProducts() {
  adminProducts = await api('/admin/products');
  $('#admin-products').innerHTML = adminProducts.map((p) => `<tr>
    <td>${esc(p.image)}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td>
    <td class="num">${p.price}</td><td class="num">${p.stock}</td>
    <td>${p.active ? 'Active' : '<span class="muted">Hidden</span>'}</td>
    <td><button class="btn sm" data-edit="${p.id}">Edit</button></td>
  </tr>`).join('');
}
$('#admin-products').addEventListener('click', (e) => {
  const p = adminProducts.find((x) => x.id === Number(e.target.dataset.edit));
  if (!p) return;
  const form = $('#product-form');
  for (const k of ['id', 'image', 'name', 'category', 'description', 'price', 'stock']) form.elements[k].value = p[k];
  form.elements.active.checked = !!p.active;
  form.scrollIntoView({ behavior: 'smooth' });
});
$('#product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const body = {
    image: f.get('image'), name: f.get('name'), category: f.get('category'), description: f.get('description'),
    price: Number(f.get('price')), stock: Number(f.get('stock')), active: form.elements.active.checked,
  };
  const id = f.get('id');
  try {
    await api(id ? `/admin/products/${id}` : '/admin/products', { method: id ? 'PUT' : 'POST', body });
    toast('Product saved');
    form.reset();
    form.elements.id.value = '';
    await loadProducts();
    renderAdminProducts();
  } catch (err) { toast(err.message); }
});
$('#product-form').addEventListener('reset', (e) => { e.target.elements.id.value = ''; });

let adminFaqs = [];
async function renderAdminFaqs() {
  adminFaqs = await api('/faqs');
  $('#admin-faqs').innerHTML = adminFaqs.map((f) => `<div class="card faq-item">
    <strong>${esc(f.question)}</strong>
    <p>${esc(f.answer)}</p>
    <div class="row between"><span class="small muted">${esc(f.keywords)}</span>
      <span class="row"><button class="btn sm" data-fedit="${f.id}">Edit</button><button class="btn sm danger" data-fdel="${f.id}">Delete</button></span>
    </div>
  </div>`).join('');
}
$('#admin-faqs').addEventListener('click', async (e) => {
  const edit = adminFaqs.find((f) => f.id === Number(e.target.dataset.fedit));
  if (edit) {
    const form = $('#faq-form');
    for (const k of ['id', 'question', 'answer', 'keywords']) form.elements[k].value = edit[k];
    form.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const del = e.target.dataset.fdel;
  if (del && confirm('Delete this FAQ?')) {
    await api(`/admin/faqs/${del}`, { method: 'DELETE' }).catch((err) => toast(err.message));
    renderAdminFaqs();
  }
});
$('#faq-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const id = f.get('id');
  try {
    await api(id ? `/admin/faqs/${id}` : '/admin/faqs', {
      method: id ? 'PUT' : 'POST', body: { question: f.get('question'), answer: f.get('answer'), keywords: f.get('keywords') },
    });
    toast('FAQ saved');
    form.reset();
    form.elements.id.value = '';
    renderAdminFaqs();
  } catch (err) { toast(err.message); }
});
$('#faq-form').addEventListener('reset', (e) => { e.target.elements.id.value = ''; });

// ---------- Assistant bot ----------
function addChat(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  $('#chat-log').appendChild(div);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  return div;
}

async function sendChat(message) {
  message = message.trim();
  if (!message) return;
  addChat('user', message);
  $('#chat-suggestions').classList.add('hidden');
  const typing = addChat('bot typing', 'Thinking…');
  const input = $('#chat-input');
  input.disabled = true;
  try {
    const { reply } = await api('/chat', { method: 'POST', body: { message, history: state.chatHistory } });
    typing.remove();
    addChat('bot', reply);
    state.chatHistory.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    // The bot may have answered about balance/orders — keep the header in sync.
    api('/wallet').then((w) => setBalance(w.balance)).catch(() => {});
  } catch (err) {
    typing.remove();
    addChat('bot', `Sorry, something went wrong: ${err.message}`);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

$('#chat-toggle').addEventListener('click', () => {
  $('#chat').classList.toggle('hidden');
  if (!$('#chat').classList.contains('hidden')) $('#chat-input').focus();
});
$('#chat-close').addEventListener('click', () => $('#chat').classList.add('hidden'));
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const msg = input.value;
  input.value = '';
  sendChat(msg);
});
$('#chat-suggestions').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') sendChat(e.target.textContent); });

boot();
