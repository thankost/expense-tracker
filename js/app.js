import * as db from './db.js';
import * as P from './periods.js';
import { donut, bars } from './charts.js';
import * as lock from './lock.js';
import { toCSV, shareOrDownload } from './export.js';

const LOCK_AFTER_MS = 60_000;
const COLORS = ['#e5484d', '#f76b15', '#f5b300', '#30a46c', '#12a594', '#0d9fbf', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#ad7f58', '#8b8d98'];
const DEFAULT_CATEGORIES = {
  income: [
    ['Salary', '💼', '#30a46c', []],
    ['Bonus', '🎁', '#0d9fbf', []],
    ['Other income', '💰', '#12a594', []],
  ],
  expense: [
    ['Home', '🏠', '#3e63dd', [['Rent', '🔑'], ['Utilities', '💡']]],
    ['Food', '🍽️', '#f76b15', [['Groceries', '🛒'], ['Restaurants', '🍔']]],
    ['Transport', '🚗', '#0090ff', [['Fuel', '⛽'], ['Public transport', '🚌']]],
    ['Health', '🩺', '#d6409f', []],
    ['Entertainment', '🎬', '#8e4ec6', []],
    ['Shopping', '🛍️', '#f5b300', []],
    ['Other', '📦', '#8b8d98', []],
  ],
};

const state = {
  categories: [], transactions: [], periods: [], budgets: [], recurring: [], settings: {},
  ui: { tab: 'overview', periodIdx: null, txFilter: 'all', overviewType: 'expense', breakdownType: 'expense', open: new Set() },
};
let periods = [];
let locked = false;
let hiddenAt = 0;

// ---------- utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = c => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#8e8e93');
const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const money = cents => eur.format(cents / 100);
const signed = (cents, type) => (type === 'income' ? '+' : '−') + money(cents);
const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);
const firstGrapheme = s => {
  s = String(s || '').trim();
  if (!s) return '';
  if (window.Intl?.Segmenter) return new Intl.Segmenter().segment(s)[Symbol.iterator]().next().value.segment;
  return Array.from(s)[0];
};

function parseAmount(str) {
  const v = parseFloat(String(str).replace(/\s|€/g, '').replace(',', '.'));
  if (!(v > 0)) throw new Error('Enter an amount greater than 0');
  return Math.round(v * 100);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function save(store, obj) {
  await db.put(store, obj);
  const arr = state[store];
  const i = arr.findIndex(x => x.id === obj.id);
  if (i >= 0) arr[i] = obj; else arr.push(obj);
  return obj;
}

async function remove(store, id) {
  await db.del(store, id);
  state[store] = state[store].filter(x => x.id !== id);
}

async function setSetting(key, value) {
  if (value === undefined || value === null) {
    await db.del('settings', key);
    delete state.settings[key];
  } else {
    await db.put('settings', { id: key, value });
    state.settings[key] = value;
  }
}

// ---------- categories ----------
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);
const catById = id => state.categories.find(c => c.id === id);
const topCats = type => state.categories.filter(c => c.type === type && !c.parentId).sort(byOrder);
const subCats = parentId => state.categories.filter(c => c.parentId === parentId).sort(byOrder);
const rootOf = c => (c?.parentId ? catById(c.parentId) || c : c);
const UNCATEGORIZED = { id: '_none', name: 'Uncategorized', icon: '❔', color: '#8e8e93' };

function catLabel(categoryId) {
  const c = catById(categoryId);
  if (!c) return { root: UNCATEGORIZED, sub: null };
  const root = rootOf(c);
  return { root, sub: c.parentId ? c : null };
}

async function seedDefaults() {
  const cats = [];
  let order = 0;
  for (const type of ['income', 'expense']) {
    for (const [name, icon, color, subs] of DEFAULT_CATEGORIES[type]) {
      const id = db.uid();
      cats.push({ id, type, name, icon, color, parentId: null, order: order++ });
      for (const [sname, sicon] of subs) cats.push({ id: db.uid(), type, name: sname, icon: sicon, color, parentId: id, order: order++ });
    }
  }
  await db.putAll('categories', cats);
  state.categories = cats;
  await setSetting('seeded', true);
}

// ---------- periods & aggregates ----------
function computePeriods() {
  const dates = state.transactions.map(t => t.date).sort();
  periods = P.buildPeriods(state.periods.map(p => p.start), { earliest: dates[0], latest: dates.at(-1), today: P.todayISO() });
  return periods;
}

function currentIndex() {
  if (!periods.length) return -1;
  if (state.ui.periodIdx === null || state.ui.periodIdx >= periods.length) {
    const i = P.findPeriodIndex(periods, P.todayISO());
    return i >= 0 ? i : periods.length - 1;
  }
  return Math.max(0, state.ui.periodIdx);
}
const currentPeriod = () => periods[currentIndex()];
const txIn = p => (p ? state.transactions.filter(t => P.inPeriod(p, t.date)) : []);

function totals(list) {
  let income = 0, expense = 0;
  for (const t of list) t.type === 'income' ? (income += t.amount) : (expense += t.amount);
  return { income, expense, balance: income - expense };
}

/** Groups transactions of a type by main category, with per-subcategory totals. */
function groupByCategory(list, type) {
  const groups = new Map();
  for (const t of list) {
    if (t.type !== type) continue;
    const { root, sub } = catLabel(t.categoryId);
    if (!groups.has(root.id)) groups.set(root.id, { cat: root, total: 0, subs: new Map() });
    const g = groups.get(root.id);
    g.total += t.amount;
    const key = sub ? sub.id : '_direct';
    const s = g.subs.get(key) || { cat: sub, total: 0 };
    s.total += t.amount;
    g.subs.set(key, s);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

// ---------- rendering ----------
const icon = (c, cls = '') => `<span class="ico ${cls}" style="--c:${safeColor(c.color)}">${esc(c.icon || '🏷️')}</span>`;
const seg = (name, options, value) => `<div class="seg" data-seg="${name}">${options.map(([v, l]) =>
  `<button type="button" class="${v === value ? 'on' : ''}" data-value="${v}">${l}</button>`).join('')}</div>`;

function periodNav() {
  const i = currentIndex();
  const p = periods[i];
  if (!p) return '';
  return `<div class="period-nav">
    <button class="round" data-action="prev-period" ${i <= 0 ? 'disabled' : ''} aria-label="Previous period">‹</button>
    <button class="pn-mid" data-action="today-period">
      <span class="pn-title">${esc(p.title)}</span><span class="pn-range">${esc(p.range)}</span>
    </button>
    <button class="round" data-action="next-period" ${i >= periods.length - 1 ? 'disabled' : ''} aria-label="Next period">›</button>
  </div>`;
}

// Monochrome line icons (24×24, stroked via .i).
const ICONS = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  tag: '<path d="M3.5 12.2V5a1.5 1.5 0 0 1 1.5-1.5h7.2a1.5 1.5 0 0 1 1 .44l7.4 7.4a1.5 1.5 0 0 1 0 2.12l-7.2 7.2a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1-.38-1.06z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8"/>',
  repeat: '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10z"/><path d="M14 3.5v5h5M9 13h6M9 16.5h6"/>',
  download: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 15.5v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2"/>',
  upload: '<path d="M12 14.5v-11M7.5 8 12 3.5 16.5 8"/><path d="M4 15.5v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4l1-13"/><path d="M10 10.5v6M14 10.5v6"/>',
  receipt: '<path d="M6 3.5h12v17l-2.5-1.5-2 1.5-1.5-1.2-1.5 1.2-2-1.5L6 20.5z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  wallet: '<rect x="3.5" y="6" width="17" height="13" rx="3"/><path d="M3.5 10h17M16 14.5h1.5"/><path d="M6 6l9.5-2.5a1.5 1.5 0 0 1 1.9 1.2L17.5 6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
};
const svg = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const header = (title, extra = '') => `<header class="top"><h1>${title}</h1>${extra}</header>`;
const empty = (ico, text) => `<div class="empty"><div class="empty-ico">${svg(ico)}</div><p>${text}</p></div>`;
/** Currency with the cents de-emphasised, e.g. €1,509<small>.01</small>. */
const moneySplit = cents => {
  const s = money(cents), i = s.lastIndexOf('.');
  return i < 0 ? esc(s) : `${esc(s.slice(0, i))}<small>${esc(s.slice(i))}</small>`;
};

function viewOverview() {
  const p = currentPeriod();
  const list = txIn(p);
  const t = totals(list);
  const type = state.ui.overviewType;
  const groups = groupByCategory(list, type);
  const typeTotal = type === 'income' ? t.income : t.expense;

  const i = currentIndex();
  const hist = periods.slice(Math.max(0, i - 5), i + 1).map(pp => ({ label: pp.short, ...totals(txIn(pp)) }));

  const budgetRows = state.budgets
    .map(b => ({ b, cat: catById(b.categoryId) }))
    .filter(x => x.cat)
    .sort((a, b) => byOrder(a.cat, b.cat))
    .map(({ b, cat }) => {
      const spent = list.filter(x => x.type === 'expense' && catLabel(x.categoryId).root.id === cat.id).reduce((s, x) => s + x.amount, 0);
      const ratio = spent / b.amount;
      const cls = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
      const left = b.amount - spent;
      return `<div class="budget">
        <div class="budget-head">${icon(cat, 'sm')}<span class="grow">${esc(cat.name)}</span>
          <span class="muted">${money(spent)} / ${money(b.amount)}</span></div>
        <div class="progress ${cls}"><i style="width:${Math.min(100, ratio * 100)}%"></i></div>
        <div class="budget-foot ${cls}">${left >= 0 ? `${money(left)} left` : `${money(-left)} over budget`}</div>
      </div>`;
    }).join('');

  const legend = groups.map(g => `<li>${icon(g.cat, 'sm')}<span class="grow">${esc(g.cat.name)}</span>
      <span class="muted">${pct(g.total, typeTotal)}%</span><span class="amt">${money(g.total)}</span></li>`).join('');

  return header('Overview') + periodNav() + `
    <section class="card hero">
      <div class="hero-label">Balance</div>
      <div class="hero-value">${t.balance < 0 ? '−' : ''}${moneySplit(Math.abs(t.balance))}</div>
      <div class="hero-row">
        <div><span class="dot income"></span>Income<b>${money(t.income)}</b></div>
        <div><span class="dot expense"></span>Expenses<b>${money(t.expense)}</b></div>
      </div>
      ${t.income ? `<div class="hero-foot">${t.balance >= 0 ? `You saved ${pct(t.balance, t.income)}% of your income` : `You spent ${pct(-t.balance, t.income)}% more than you earned`}</div>` : ''}
    </section>

    <section class="card">
      <div class="card-head"><h2>By category</h2>${seg('overviewType', [['expense', 'Expenses'], ['income', 'Income']], type)}</div>
      ${groups.length
        ? donut(groups.map(g => ({ value: g.total, color: safeColor(g.cat.color) })), typeTotal, money(typeTotal), type === 'income' ? 'income' : 'spent')
          + `<ul class="legend">${legend}</ul>`
        : empty(type === 'income' ? 'wallet' : 'receipt', `No ${type === 'income' ? 'income' : 'expenses'} in this period yet.`)}
    </section>

    <section class="card">
      <div class="card-head"><h2>Income vs expenses</h2></div>
      ${bars(hist)}
      <div class="bars-legend"><span><i class="dot income"></i>Income</span><span><i class="dot expense"></i>Expenses</span></div>
    </section>

    ${budgetRows ? `<section class="card"><div class="card-head"><h2>Budgets</h2></div>${budgetRows}</section>` : ''}`;
}

function viewTransactions() {
  const p = currentPeriod();
  const f = state.ui.txFilter;
  const list = txIn(p).filter(t => f === 'all' || t.type === f)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  const today = P.todayISO(), yesterday = P.addDays(today, -1);
  const byDay = new Map();
  for (const t of list) (byDay.get(t.date) || byDay.set(t.date, []).get(t.date)).push(t);

  const days = [...byDay.entries()].map(([date, items]) => {
    const net = totals(items).balance;
    const label = date === today ? 'Today' : date === yesterday ? 'Yesterday' : P.fmtDayLong(date);
    return `<div class="day"><div class="day-head"><span>${label}</span><span>${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</span></div>
      <div class="list">${items.map(t => {
        const { root, sub } = catLabel(t.categoryId);
        const c = sub || root;
        const subtitle = [sub ? root.name : '', t.note, t.recurringId ? '↻ recurring' : ''].filter(Boolean).map(esc).join(' · ');
        return `<button class="row" data-action="edit-tx" data-id="${esc(t.id)}">${icon(c)}
          <span class="main"><span class="t1">${esc(c.name)}</span>${subtitle ? `<span class="t2">${subtitle}</span>` : ''}</span>
          <span class="amt ${t.type}">${signed(t.amount, t.type)}</span></button>`;
      }).join('')}</div></div>`;
  }).join('');

  return header('Transactions') + periodNav()
    + seg('txFilter', [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']], f)
    + (days || empty('receipt', 'No transactions in this period.<br>Tap <b>+</b> to add one.'));
}

function viewBreakdown() {
  const p = currentPeriod();
  const type = state.ui.breakdownType;
  const list = txIn(p);
  const groups = groupByCategory(list, type);
  const total = groups.reduce((s, g) => s + g.total, 0);

  const rows = groups.map(g => {
    const subs = [...g.subs.entries()].sort((a, b) => b[1].total - a[1].total);
    const hasSubs = subs.some(([k]) => k !== '_direct');
    const inner = hasSubs ? subs.map(([k, s]) => `<div class="sub-row">
        <span class="grow">${k === '_direct' ? `<i class="muted">No subcategory</i>` : `${esc(s.cat.icon || '')} ${esc(s.cat.name)}`}</span>
        <span class="muted">${pct(s.total, g.total)}%</span><span class="amt">${money(s.total)}</span></div>`).join('') : '';
    const open = state.ui.open.has(g.cat.id) ? 'open' : '';
    const headRow = `${icon(g.cat)}
      <span class="main"><span class="t1">${esc(g.cat.name)}</span>
        <span class="bar"><i style="width:${pct(g.total, total)}%;background:${safeColor(g.cat.color)}"></i></span></span>
      <span class="right"><span class="amt">${money(g.total)}</span><span class="t2">${pct(g.total, total)}%</span></span>`;
    return hasSubs
      ? `<details class="group-row" data-cat="${esc(g.cat.id)}" ${open}><summary class="row">${headRow}<span class="chev">›</span></summary><div class="subs">${inner}</div></details>`
      : `<div class="group-row"><div class="row">${headRow}<span class="chev hidden">›</span></div></div>`;
  }).join('');

  return header('Breakdown') + periodNav()
    + seg('breakdownType', [['expense', 'Expenses'], ['income', 'Income']], type)
    + `<div class="total-line"><span>Total ${type === 'income' ? 'income' : 'expenses'}</span><b class="${type}">${money(total)}</b></div>`
    + (rows ? `<div class="list">${rows}</div>` : empty('chart', 'Nothing to break down yet.'));
}

function settingsRow(action, ico, title, subtitle = '', cls = '') {
  return `<button class="row ${cls}" data-action="${action}"><span class="ico line">${svg(ico)}</span>
    <span class="main"><span class="t1">${title}</span>${subtitle ? `<span class="t2">${subtitle}</span>` : ''}</span><span class="chev">›</span></button>`;
}

function viewSettings() {
  const p = currentPeriod();
  const lockOn = !!state.settings.pinHash;
  const nCats = state.categories.length;
  return header('Settings') + `
    <div class="group-title">Organize</div>
    <div class="list">
      ${settingsRow('periods', 'calendar', 'Pay periods', state.periods.length ? `Current: ${esc(p?.range || '')}` : 'Using calendar months')}
      ${settingsRow('categories', 'tag', 'Categories', `${nCats} categories & subcategories`)}
      ${settingsRow('budgets', 'target', 'Budgets', state.budgets.length ? `${state.budgets.length} set` : 'None set')}
      ${settingsRow('recurring', 'repeat', 'Recurring', state.recurring.length ? `${state.recurring.length} active` : 'None')}
    </div>
    <div class="group-title">Security</div>
    <div class="list">${settingsRow('security', 'lock', 'App lock', lockOn ? (state.settings.credId ? 'Face ID + PIN' : 'PIN') : 'Off')}</div>
    <div class="group-title">Data</div>
    <div class="list">
      ${settingsRow('export-csv', 'file', 'Export CSV', 'Open in Excel / Numbers')}
      ${settingsRow('backup', 'download', 'Back up', 'Save a JSON backup file')}
      ${settingsRow('restore', 'upload', 'Restore', 'Load a JSON backup file')}
      ${settingsRow('reset', 'trash', 'Erase all data', '', 'danger')}
    </div>
    <p class="hint center">Everything is stored only on this device.<br>Back up regularly — removing the app erases its data.</p>`;
}

const VIEWS = { overview: viewOverview, transactions: viewTransactions, breakdown: viewBreakdown, settings: viewSettings };

function render() {
  computePeriods();
  $('#view').innerHTML = VIEWS[state.ui.tab]();
  document.querySelectorAll('.tabbar [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === state.ui.tab));
}

// ---------- sheets ----------
function sheet(title, html, { saveLabel = 'Save', onSave, onMount } = {}) {
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
    <div class="sheet-grip"></div>
    <div class="sheet-head">
      <button type="button" class="link" data-close>${onSave ? 'Cancel' : 'Done'}</button>
      <h3>${esc(title)}</h3>
      ${onSave ? `<button type="button" class="link bold" data-save>${esc(saveLabel)}</button>` : '<span></span>'}
    </div>
    <div class="sheet-body">${html}</div>
  </div>`;
  document.body.appendChild(back);
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => requestAnimationFrame(() => back.classList.add('open')));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.remove('open');
    setTimeout(() => {
      back.remove();
      if (!document.querySelector('.sheet-backdrop')) document.body.classList.remove('sheet-open');
      back.dispatchEvent(new Event('closed'));
    }, 280);
  };
  back.addEventListener('click', e => {
    if (e.target === back || e.target.closest('[data-close]')) close();
  });
  if (onSave) {
    back.querySelector('[data-save]').addEventListener('click', async () => {
      try {
        if ((await onSave(back)) !== false) close();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  onMount?.(back, close);
  return { el: back, close };
}

function onSeg(root, name, fn) {
  const el = root.querySelector(`[data-seg="${name}"]`);
  el.addEventListener('click', e => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    fn(b.dataset.value);
  });
}

// Transaction / recurring editor
function txSheet(item = null, { recurring = false, onSaved, type: initialType } = {}) {
  const it = item || {};
  let type = it.type || initialType || 'expense';
  const c0 = catById(it.categoryId);
  let catId = c0 ? rootOf(c0).id : null;
  let subId = c0?.parentId ? c0.id : null;
  const today = P.todayISO();
  const title = recurring ? (item ? 'Edit recurring' : 'New recurring') : (item ? 'Edit transaction' : 'New transaction');

  const html = `
    ${seg('type', [['expense', 'Expense'], ['income', 'Income']], type)}
    <label class="amount-field ${type}"><span>€</span>
      <input id="f-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${item ? (it.amount / 100).toFixed(2) : ''}"></label>
    <div class="field-label">Category</div>
    <div class="chips" id="f-cats"></div>
    <div id="f-subwrap"><div class="field-label">Subcategory <span class="muted">(optional)</span></div><div class="chips" id="f-subs"></div></div>
    <div class="form">
      ${recurring ? `
        <label class="field"><span>Repeats</span><select id="f-freq">
          <option value="monthly" ${it.frequency !== 'weekly' ? 'selected' : ''}>Monthly</option>
          <option value="weekly" ${it.frequency === 'weekly' ? 'selected' : ''}>Weekly</option></select></label>
        <label class="field"><span>Next date</span><input type="date" id="f-date" value="${esc(it.nextDate || today)}"></label>`
      : `<label class="field"><span>Date</span><input type="date" id="f-date" value="${esc(it.date || today)}"></label>`}
      <label class="field"><span>Note</span><input id="f-note" placeholder="Optional" maxlength="200" value="${esc(it.note)}"></label>
    </div>
    ${recurring ? '<p class="hint">Transactions are added automatically on each date when you open the app. Past dates are filled in too.</p>' : ''}
    ${item ? `<button type="button" class="btn danger" id="f-delete">Delete${recurring ? ' recurring' : ''}</button>` : ''}`;

  sheet(title, html, {
    onMount(el, close) {
      const catsEl = $('#f-cats', el), subsEl = $('#f-subs', el), subWrap = $('#f-subwrap', el);
      const chip = (c, on, kind) => `<button type="button" class="chip ${on ? 'on' : ''}" data-${kind}="${esc(c.id)}" style="--c:${safeColor(c.color)}">
        <span>${esc(c.icon || '🏷️')}</span>${esc(c.name)}</button>`;
      const drawChips = () => {
        catsEl.innerHTML = topCats(type).map(c => chip(c, c.id === catId, 'cat')).join('')
          + '<button type="button" class="chip add" data-new="cat">＋ New</button>';
        subWrap.hidden = !catId;
        subsEl.innerHTML = catId ? subCats(catId).map(c => chip(c, c.id === subId, 'sub')).join('')
          + '<button type="button" class="chip add" data-new="sub">＋ New</button>' : '';
      };
      drawChips();

      onSeg(el, 'type', v => {
        type = v;
        catId = subId = null;
        $('.amount-field', el).className = `amount-field ${type}`;
        drawChips();
      });
      el.addEventListener('click', e => {
        const b = e.target.closest('.chip');
        if (!b) return;
        if (b.dataset.cat) { catId = b.dataset.cat; subId = null; }
        else if (b.dataset.sub) subId = subId === b.dataset.sub ? null : b.dataset.sub;
        else if (b.dataset.new) {
          const isSub = b.dataset.new === 'sub';
          categorySheet(null, {
            type, parentId: isSub ? catId : null,
            onSaved: c => { if (isSub) subId = c.id; else { catId = c.id; subId = null; } drawChips(); },
          });
          return;
        }
        drawChips();
      });

      $('#f-delete', el)?.addEventListener('click', async () => {
        if (!confirm(recurring ? 'Delete this recurring item? Transactions already added stay.' : 'Delete this transaction?')) return;
        await remove(recurring ? 'recurring' : 'transactions', it.id);
        close();
        render();
        onSaved?.();
        toast('Deleted');
      });
    },
    async onSave(el) {
      const amount = parseAmount($('#f-amount', el).value);
      if (!catId) throw new Error('Pick a category');
      const date = $('#f-date', el).value;
      if (!P.isISODate(date)) throw new Error('Pick a date');
      const base = { ...it, id: it.id || db.uid(), type, amount, categoryId: subId || catId, note: $('#f-note', el).value.trim() };
      if (recurring) {
        const day = it.nextDate === date && it.day ? it.day : Number(date.slice(8));
        await save('recurring', { ...base, frequency: $('#f-freq', el).value, nextDate: date, day });
        await runRecurring();
      } else {
        await save('transactions', { ...base, date, createdAt: it.createdAt || Date.now() });
      }
      render();
      onSaved?.();
      toast('Saved');
    },
  });
}

function categorySheet(cat, { type, parentId = null, onSaved } = {}) {
  const parent = parentId ? catById(parentId) : null;
  const c = cat || { type, parentId, name: '', icon: parent?.icon || '🏷️', color: parent?.color || COLORS[state.categories.length % COLORS.length] };
  const hasChildren = cat && subCats(cat.id).length > 0;
  let color = c.color;
  const parents = topCats(c.type).filter(p => p.id !== c.id);

  const html = `
    <div class="form">
      <label class="field"><span>Name</span><input id="c-name" maxlength="40" placeholder="e.g. Groceries" value="${esc(c.name)}"></label>
      <label class="field"><span>Icon</span><input id="c-icon" class="emoji-input" placeholder="🏷️" value="${esc(c.icon)}"></label>
      ${hasChildren ? '' : `<label class="field"><span>Inside</span><select id="c-parent">
        <option value="">— Main category —</option>
        ${parents.map(p => `<option value="${esc(p.id)}" ${p.id === c.parentId ? 'selected' : ''}>${esc(p.icon)} ${esc(p.name)}</option>`).join('')}
      </select></label>`}
    </div>
    <div class="field-label">Color</div>
    <div class="swatches">${(COLORS.includes(color) ? COLORS : [color, ...COLORS]).map(col => `<button type="button" class="swatch ${col === color ? 'on' : ''}" data-color="${col}" style="--c:${col}" aria-label="${col}"></button>`).join('')}</div>
    <p class="hint">Tip: tap the icon field and switch to the emoji keyboard 🌐.</p>
    ${cat ? '<button type="button" class="btn danger" id="c-delete">Delete category</button>' : ''}`;

  sheet(cat ? 'Edit category' : (parentId ? 'New subcategory' : 'New category'), html, {
    onMount(el, close) {
      el.querySelector('.swatches').addEventListener('click', e => {
        const b = e.target.closest('.swatch');
        if (!b) return;
        color = b.dataset.color;
        el.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s === b));
      });
      $('#c-delete', el)?.addEventListener('click', async () => {
        if (await deleteCategory(cat)) {
          close();
          render();
          onSaved?.(null);
        }
      });
    },
    async onSave(el) {
      const name = $('#c-name', el).value.trim();
      if (!name) throw new Error('Enter a name');
      const pid = hasChildren ? null : ($('#c-parent', el).value || null);
      const dup = state.categories.some(x => x.id !== c.id && x.type === c.type && (x.parentId || null) === pid && x.name.toLowerCase() === name.toLowerCase());
      if (dup) throw new Error('A category with this name already exists here');
      const obj = { ...c, id: c.id || db.uid(), name, icon: firstGrapheme($('#c-icon', el).value) || '🏷️', color, parentId: pid, order: c.order ?? Date.now() };
      await save('categories', obj);
      if (pid) {
        const b = state.budgets.find(x => x.categoryId === obj.id);
        if (b) await remove('budgets', b.id);
      }
      render();
      onSaved?.(obj);
    },
  });
}

async function deleteCategory(cat) {
  const subs = subCats(cat.id);
  const ids = new Set([cat.id, ...subs.map(s => s.id)]);
  const usedTx = state.transactions.filter(t => ids.has(t.categoryId));
  const usedRec = state.recurring.filter(r => ids.has(r.categoryId));
  const used = usedTx.length + usedRec.length;

  if (cat.parentId) {
    const parent = catById(cat.parentId);
    const msg = used ? `${used} item(s) use "${cat.name}". Move them to "${parent.name}" and delete the subcategory?` : `Delete "${cat.name}"?`;
    if (!confirm(msg)) return false;
    for (const t of usedTx) await save('transactions', { ...t, categoryId: parent.id });
    for (const r of usedRec) await save('recurring', { ...r, categoryId: parent.id });
    await remove('categories', cat.id);
    return true;
  }
  if (used) {
    alert(`"${cat.name}" is used by ${used} transaction(s) or recurring item(s). Change or delete them first.`);
    return false;
  }
  if (!confirm(`Delete "${cat.name}"${subs.length ? ` and its ${subs.length} subcategories` : ''}?`)) return false;
  for (const id of ids) await remove('categories', id);
  for (const b of state.budgets.filter(b => ids.has(b.categoryId))) await remove('budgets', b.id);
  return true;
}

function categoriesSheet() {
  let type = 'expense';
  sheet('Categories', `${seg('cmType', [['expense', 'Expenses'], ['income', 'Income']], type)}<div id="cm-list"></div>`, {
    onMount(el) {
      const list = $('#cm-list', el);
      const draw = () => {
        list.innerHTML = `<div class="list">${topCats(type).map(c => {
          const subs = subCats(c.id);
          return `<button type="button" class="row" data-edit="${esc(c.id)}">${icon(c)}
              <span class="main"><span class="t1">${esc(c.name)}</span><span class="t2">${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}</span></span><span class="chev">›</span></button>
            ${subs.map(s => `<button type="button" class="row sub" data-edit="${esc(s.id)}">${icon(s, 'sm')}<span class="main"><span class="t1">${esc(s.name)}</span></span><span class="chev">›</span></button>`).join('')}
            <button type="button" class="row sub add" data-addsub="${esc(c.id)}">＋ Add subcategory</button>`;
        }).join('')}</div>
        <button type="button" class="btn primary" data-addcat>＋ Add ${type === 'income' ? 'income' : 'expense'} category</button>`;
      };
      draw();
      onSeg(el, 'cmType', v => { type = v; draw(); });
      list.addEventListener('click', e => {
        const edit = e.target.closest('[data-edit]'), addSub = e.target.closest('[data-addsub]'), addCat = e.target.closest('[data-addcat]');
        if (edit) categorySheet(catById(edit.dataset.edit), { onSaved: draw });
        else if (addSub) categorySheet(null, { type, parentId: addSub.dataset.addsub, onSaved: draw });
        else if (addCat) categorySheet(null, { type, onSaved: draw });
      });
    },
  });
}

function periodsSheet() {
  sheet('Pay periods', `
    <p class="hint">Add the date each pay period starts (e.g. your payday). A period runs until the day before the next one starts, so the latest period stays open until you add a new start date. Dates before your first period use calendar months.</p>
    <div id="pm-list"></div>
    <button type="button" class="btn primary" id="pm-add">＋ New period starting…</button>`, {
    onMount(el) {
      const list = $('#pm-list', el);
      const draw = () => {
        computePeriods();
        const manual = periods.filter(p => p.manual).reverse();
        list.innerHTML = manual.length ? `<div class="list">${manual.map(p => {
          const rec = state.periods.find(x => x.start === p.start);
          return `<button type="button" class="row" data-id="${esc(rec.id)}"><span class="ico line"${p.end ? '' : ' style="color:var(--accent)"'}>${svg('calendar')}</span>
            <span class="main"><span class="t1">${esc(p.title)}</span><span class="t2">${esc(p.range)}</span></span><span class="chev">›</span></button>`;
        }).join('')}</div>` : empty('calendar', 'No pay periods yet — using calendar months.');
      };
      draw();
      list.addEventListener('click', e => {
        const b = e.target.closest('[data-id]');
        if (b) periodEditSheet(state.periods.find(p => p.id === b.dataset.id), draw);
      });
      $('#pm-add', el).addEventListener('click', () => periodEditSheet(null, draw));
    },
  });
}

function periodEditSheet(rec, onDone) {
  sheet(rec ? 'Edit period' : 'New period', `
    <div class="form"><label class="field"><span>Starts on</span><input type="date" id="p-start" value="${esc(rec?.start || P.todayISO())}"></label></div>
    <p class="hint">Tip: use the date your salary arrived.</p>
    ${rec ? '<button type="button" class="btn danger" id="p-delete">Delete period</button>' : ''}`, {
    onMount(el, close) {
      $('#p-delete', el)?.addEventListener('click', async () => {
        if (!confirm('Delete this period? Its transactions will join the previous period.')) return;
        await remove('periods', rec.id);
        state.ui.periodIdx = null;
        close();
        render();
        onDone();
      });
    },
    async onSave(el) {
      const start = $('#p-start', el).value;
      if (!P.isISODate(start)) throw new Error('Pick a date');
      if (state.periods.some(p => p.start === start && p.id !== rec?.id)) throw new Error('A period already starts on that date');
      await save('periods', { id: rec?.id || db.uid(), start });
      state.ui.periodIdx = null;
      render();
      onDone();
    },
  });
}

function budgetsSheet() {
  const cats = topCats('expense');
  sheet('Budgets', `
    <p class="hint">Set a spending limit per pay period for each category. Leave empty for no budget.</p>
    <div class="form">${cats.map(c => {
      const b = state.budgets.find(x => x.categoryId === c.id);
      return `<label class="field"><span>${esc(c.icon)} ${esc(c.name)}</span>
        <input inputmode="decimal" data-bud="${esc(c.id)}" placeholder="—" value="${b ? (b.amount / 100).toFixed(2) : ''}"></label>`;
    }).join('')}</div>`, {
    async onSave(el) {
      for (const input of el.querySelectorAll('[data-bud]')) {
        const catId = input.dataset.bud;
        const existing = state.budgets.find(x => x.categoryId === catId);
        if (!input.value.trim()) {
          if (existing) await remove('budgets', existing.id);
          continue;
        }
        let amount;
        try { amount = parseAmount(input.value); } catch { throw new Error(`Invalid amount for ${catById(catId).name}`); }
        await save('budgets', { id: existing?.id || db.uid(), categoryId: catId, amount });
      }
      render();
      toast('Budgets saved');
    },
  });
}

function recurringSheet() {
  sheet('Recurring', '<div id="rc-list"></div><button type="button" class="btn primary" id="rc-add">＋ Add recurring</button>', {
    onMount(el) {
      const list = $('#rc-list', el);
      const draw = () => {
        const items = [...state.recurring].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
        list.innerHTML = items.length ? `<div class="list">${items.map(r => {
          const { root, sub } = catLabel(r.categoryId);
          const c = sub || root;
          const freq = r.frequency === 'weekly' ? 'Weekly' : `Monthly on day ${r.day}`;
          return `<button type="button" class="row" data-id="${esc(r.id)}">${icon(c)}
            <span class="main"><span class="t1">${esc(r.note || c.name)}</span><span class="t2">${freq} · next ${esc(P.fmtDay(r.nextDate))}</span></span>
            <span class="amt ${r.type}">${signed(r.amount, r.type)}</span></button>`;
        }).join('')}</div>` : empty('repeat', 'Add rent, subscriptions or salary to have them entered automatically.');
      };
      draw();
      list.addEventListener('click', e => {
        const b = e.target.closest('[data-id]');
        if (b) txSheet(state.recurring.find(r => r.id === b.dataset.id), { recurring: true, onSaved: draw });
      });
      $('#rc-add', el).addEventListener('click', () => txSheet(null, { recurring: true, onSaved: draw }));
    },
  });
}

async function runRecurring() {
  const today = P.todayISO();
  let added = 0;
  for (const r of [...state.recurring]) {
    let changed = false, guard = 0;
    const rec = { ...r };
    while (rec.nextDate <= today && guard++ < 500) {
      await save('transactions', {
        id: db.uid(), type: rec.type, amount: rec.amount, categoryId: rec.categoryId, note: rec.note,
        date: rec.nextDate, recurringId: rec.id, createdAt: Date.now(),
      });
      rec.nextDate = P.nextOccurrence(rec);
      changed = true;
      added++;
    }
    if (changed) await save('recurring', rec);
  }
  if (added) toast(`Added ${added} recurring transaction${added > 1 ? 's' : ''}`);
  return added;
}

// ---------- security ----------
function pinPad(container, onComplete) {
  let value = '';
  container.innerHTML = `<div class="dots">${'<i></i>'.repeat(4)}</div>
    <div class="keys">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(k =>
      k ? `<button type="button" data-k="${k}" ${k === '⌫' ? 'class="del" aria-label="Delete"' : ''}>${k}</button>` : '<span></span>').join('')}</div>`;
  const dots = [...container.querySelectorAll('.dots i')];
  const update = () => dots.forEach((d, i) => d.classList.toggle('on', i < value.length));
  const ctl = {
    reset() { value = ''; update(); },
    shake() {
      container.classList.remove('shake');
      void container.offsetWidth;
      container.classList.add('shake');
      navigator.vibrate?.(80);
    },
  };
  container.addEventListener('click', e => {
    const b = e.target.closest('[data-k]');
    if (!b || value.length >= 4 && b.dataset.k !== '⌫') return;
    value = b.dataset.k === '⌫' ? value.slice(0, -1) : value + b.dataset.k;
    update();
    if (value.length === 4) setTimeout(() => onComplete(value, ctl), 150);
  });
  return ctl;
}

function pinSetupSheet(onDone) {
  let first = null, done = false;
  const s = sheet('Set PIN', '<p class="pin-msg" id="ps-msg">Choose a 4-digit PIN</p><div class="pin" id="ps-pad"></div>', {
    onMount(el, close) {
      pinPad($('#ps-pad', el), async (v, ctl) => {
        if (!first) {
          first = v;
          $('#ps-msg', el).textContent = 'Enter it again to confirm';
          ctl.reset();
        } else if (v === first) {
          await setSetting('pinHash', await lock.hashPin(v));
          done = true;
          close();
          toast('PIN set');
        } else {
          first = null;
          $('#ps-msg', el).textContent = "PINs didn't match — try again";
          ctl.shake();
          ctl.reset();
        }
      });
    },
  });
  s.el.addEventListener('closed', () => onDone(done));
}

async function securitySheet() {
  const supported = await lock.passkeySupported();
  sheet('App lock', '<div id="sec"></div>', {
    onMount(el) {
      const box = $('#sec', el);
      const draw = () => {
        const on = !!state.settings.pinHash;
        box.innerHTML = `<div class="list">
          <label class="row"><span class="main"><span class="t1">Require PIN</span></span><input type="checkbox" class="switch" id="sec-pin" ${on ? 'checked' : ''}></label>
          ${on ? `<label class="row"><span class="main"><span class="t1">Unlock with Face ID</span>
              ${supported ? '' : '<span class="t2">Not available here</span>'}</span>
              <input type="checkbox" class="switch" id="sec-face" ${state.settings.credId ? 'checked' : ''} ${supported ? '' : 'disabled'}></label>
            <button type="button" class="row" id="sec-change"><span class="main"><span class="t1">Change PIN</span></span><span class="chev">›</span></button>` : ''}
        </div>
        <p class="hint">The app locks when opened and after being in the background for a minute. Face ID uses a passkey saved on this device; the PIN is always available as a fallback.</p>`;
        $('#sec-pin', box).addEventListener('change', async e => {
          if (e.target.checked) pinSetupSheet(() => { draw(); render(); });
          else if (confirm('Turn off the app lock?')) {
            await setSetting('pinHash', null);
            await setSetting('credId', null);
            draw(); render();
          } else e.target.checked = true;
        });
        $('#sec-face', box)?.addEventListener('change', async e => {
          if (e.target.checked) {
            try {
              await setSetting('credId', await lock.createPasskey());
              toast('Face ID enabled');
            } catch (err) {
              toast(err.name === 'NotAllowedError' ? 'Face ID setup was cancelled' : `Face ID error: ${err.message}`);
            }
          } else await setSetting('credId', null);
          draw(); render();
        });
        $('#sec-change', box)?.addEventListener('click', () => pinSetupSheet(() => draw()));
      };
      draw();
    },
  });
}

let faceBusy = false;
async function tryFaceId() {
  if (faceBusy || !state.settings.credId) return;
  faceBusy = true;
  try {
    if (await lock.verifyPasskey(state.settings.credId)) unlock();
  } catch { /* user cancelled or no gesture; PIN still works */ }
  faceBusy = false;
}

function showLock() {
  if (!state.settings.pinHash || locked) return;
  locked = true;
  const L = $('#lock');
  L.innerHTML = `<div class="lock-inner">
    <img src="icons/icon-180.png" alt="" class="lock-icon">
    <h2>Expenses</h2><p class="pin-msg">Enter your PIN</p>
    <div class="pin" id="lock-pad"></div>
    ${state.settings.credId ? '<button type="button" class="btn link" id="lock-face">Use Face ID</button>' : ''}
  </div>`;
  L.hidden = false;
  document.activeElement?.blur?.();
  pinPad($('#lock-pad', L), async (v, ctl) => {
    if ((await lock.hashPin(v)) === state.settings.pinHash) unlock();
    else { ctl.shake(); ctl.reset(); }
  });
  $('#lock-face', L)?.addEventListener('click', tryFaceId);
  tryFaceId();
}

function unlock() {
  locked = false;
  const L = $('#lock');
  L.hidden = true;
  L.innerHTML = '';
}

// ---------- data ----------
function exportSheet() {
  const p = currentPeriod();
  sheet('Export CSV', `
    <p class="hint">Creates a CSV file you can save to Files or open in Numbers / Excel.</p>
    <button type="button" class="btn primary" id="ex-period">This period (${esc(p?.range || '')})</button>
    <button type="button" class="btn" id="ex-all">All transactions</button>`, {
    onMount(el, close) {
      const go = async list => {
        if (!list.length) return toast('No transactions to export');
        computePeriods();
        const rows = [['Date', 'Type', 'Category', 'Subcategory', 'Amount', 'Note', 'Period']];
        for (const t of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
          const { root, sub } = catLabel(t.categoryId);
          const period = periods[P.findPeriodIndex(periods, t.date)];
          rows.push([t.date, t.type === 'income' ? 'Income' : 'Expense', root.name, sub?.name || '', +(t.amount / 100).toFixed(2), t.note || '', period ? `${period.title} (${period.range})` : '']);
        }
        await shareOrDownload(`expenses-${P.todayISO()}.csv`, toCSV(rows), 'text/csv');
        close();
      };
      $('#ex-period', el).addEventListener('click', () => go(txIn(p)));
      $('#ex-all', el).addEventListener('click', () => go(state.transactions));
    },
  });
}

async function backup() {
  const { pinHash, credId, ...settings } = state.settings;
  const data = {
    app: 'expense-tracker', version: 1, exportedAt: new Date().toISOString(),
    categories: state.categories, transactions: state.transactions, periods: state.periods,
    budgets: state.budgets, recurring: state.recurring, settings,
  };
  await shareOrDownload(`expenses-backup-${P.todayISO()}.json`, JSON.stringify(data, null, 1), 'application/json');
  await setSetting('lastBackup', new Date().toISOString());
}

function restore() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'expense-tracker') throw new Error('This is not an Expenses backup file');
      const arr = k => (Array.isArray(data[k]) ? data[k].filter(x => x && typeof x.id === 'string') : []);
      if (!confirm(`Replace all current data with this backup (${arr('transactions').length} transactions)?`)) return;
      const stores = ['categories', 'transactions', 'periods', 'budgets', 'recurring'];
      await db.clearStores(stores);
      for (const s of stores) {
        state[s] = arr(s);
        await db.putAll(s, state[s]);
      }
      state.ui.periodIdx = null;
      render();
      toast('Backup restored');
    } catch (e) {
      alert(`Could not restore: ${e.message}`);
    }
  });
  input.click();
}

async function eraseAll() {
  if (!confirm('Erase ALL transactions, categories, periods and settings? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Consider making a backup first.')) return;
  await db.clearStores();
  for (const s of ['categories', 'transactions', 'periods', 'budgets', 'recurring']) state[s] = [];
  state.settings = {};
  await seedDefaults();
  state.ui.periodIdx = null;
  render();
  toast('All data erased');
}

// ---------- events ----------
const ACTIONS = {
  tab: b => { state.ui.tab = b.dataset.tab; render(); window.scrollTo(0, 0); },
  add: () => txSheet(null, { type: state.ui.tab === 'breakdown' ? state.ui.breakdownType : undefined }),
  'prev-period': () => { state.ui.periodIdx = currentIndex() - 1; render(); },
  'next-period': () => { state.ui.periodIdx = currentIndex() + 1; render(); },
  'today-period': () => { state.ui.periodIdx = null; render(); },
  'edit-tx': b => txSheet(state.transactions.find(t => t.id === b.dataset.id)),
  periods: periodsSheet,
  categories: categoriesSheet,
  budgets: budgetsSheet,
  recurring: recurringSheet,
  security: securitySheet,
  'export-csv': exportSheet,
  backup,
  restore,
  reset: eraseAll,
};

document.addEventListener('click', e => {
  if (e.target.closest('.sheet-backdrop, #lock')) return;
  const b = e.target.closest('[data-action]');
  if (b && !b.disabled) {
    ACTIONS[b.dataset.action]?.(b);
    return;
  }
  const segBtn = e.target.closest('#view [data-seg] button[data-value]');
  if (segBtn) {
    state.ui[segBtn.closest('[data-seg]').dataset.seg] = segBtn.dataset.value;
    render();
  }
});

document.addEventListener('toggle', e => {
  const d = e.target;
  if (d.matches?.('details[data-cat]')) d.open ? state.ui.open.add(d.dataset.cat) : state.ui.open.delete(d.dataset.cat);
}, true);

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  if (Date.now() - hiddenAt > LOCK_AFTER_MS) showLock();
  if (await runRecurring()) render();
});

// Horizontal swipe on the period header changes period.
let touchX = null;
document.addEventListener('touchstart', e => {
  touchX = e.target.closest('.period-nav') ? e.touches[0].clientX : null;
}, { passive: true });
document.addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) < 50) return;
  const i = currentIndex() + (dx < 0 ? 1 : -1);
  if (i >= 0 && i < periods.length) { state.ui.periodIdx = i; render(); }
}, { passive: true });

// ---------- start ----------
async function init() {
  for (const s of ['categories', 'transactions', 'periods', 'budgets', 'recurring']) state[s] = await db.getAll(s);
  for (const { id, value } of await db.getAll('settings')) state.settings[id] = value;
  if (!state.settings.seeded && !state.categories.length) await seedDefaults();
  showLock();
  await runRecurring();
  render();
  navigator.storage?.persist?.();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading || document.querySelector('.sheet-backdrop')) return;
      reloading = true;
      location.reload();
    });
  }
}

init().catch(err => {
  console.error(err);
  $('#view').innerHTML = `<div class="empty"><div class="empty-ico">⚠️</div><p>Could not start: ${esc(err.message)}</p></div>`;
});
