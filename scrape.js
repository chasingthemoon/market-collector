// scrape.js — the browser half of the chasingthemoon Market module.
//
// Runs in an ordinary Chrome outside Cloudflare, on GitHub's runners
// (.github/workflows/collect.yml; the platform Worker starts it at fixed
// times) or any machine. Each run:
//   1. asks the platform Worker for the next few pages (POST /__market/lease);
//      the Worker plans them from every tenant's comparables and caps how many,
//   2. opens them one at a time, evenly paced,
//   3. reads each page: on Booking.com the room table (every room type with
//      its price for the stay and how many are left); on Airbnb the listing's
//      price for the stay and its availability calendar (a year of nights,
//      free or not, from the call Airbnb's own page makes),
//   4. sends that back (POST /__market/results); each tenant's comparables
//      pick out the room types they follow.
//
// Identity: a normal desktop Chrome user agent and a scroll through each page.
// MD_IDENTITY=robot tells Booking what it is instead, a robot with a contact
// address, as Booking asks robots to; tried on 2026-10-01: Booking lets the
// robot in but serves it the page without dates, so no rooms and no prices.
//
// Public, logged-out prices and availability only. On a CAPTCHA or a block it
// stops for the run and says so; it never tries to get past one.
//
// Env:
//   MD_API_KEY      the platform's MARKET_COLLECTOR_KEY (not needed for a dry run)
//   MD_URL          the platform Worker (default below)
//   MD_IDENTITY     browser (default) | robot
//   MD_CONTACT      the contact address in the robot's user agent
//   MD_MAX_PAGES    pages to ask for at a time (default 10; the Worker caps it too)
//   MD_PAUSE        seconds between pages, "min-max" (browser 10-30, robot 15-20)
//   MD_MAX_MINUTES  stop opening new pages after this long (default 25)
//   MD_PROXIES      optional, comma/space separated http://user:pass@host:port
//   MD_DEBUG_DIR    save the page (HTML + screenshot) when nothing could be read
//   MD_DRY_RUN=1    don't talk to the Worker: open pages from dry-run-pages.json,
//                   print the room tables, send nothing
//
// Run:
//   npm install
//   MD_API_KEY=… node scrape.js
//   MD_DRY_RUN=1 MD_MAX_PAGES=3 node scrape.js

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const int = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Math.max(0, Math.round(Number(v))) : d);
const range = (v, d) => {
  const m = String(v ?? '').match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return m ? [Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])] : d;
};

const SERVICE = (env.MD_URL || 'https://join.chasingthemoon.org').replace(/\/+$/, '');
const API_KEY = env.MD_API_KEY || '';
const DRY = /^(1|true|yes)$/i.test(env.MD_DRY_RUN ?? '');
const BROWSER_MODE = !/^robot$/i.test(env.MD_IDENTITY ?? '');
const CONTACT = (env.MD_CONTACT || 'info@chasingthemoon.org').trim();
const MAX_PAGES = Math.max(1, int(env.MD_MAX_PAGES, 10));
const [PAUSE_MIN, PAUSE_MAX] = range(env.MD_PAUSE, BROWSER_MODE ? [10, 30] : [15, 20]);
const MAX_MINUTES = Math.max(1, int(env.MD_MAX_MINUTES, 25));
const PROXIES = String(env.MD_PROXIES ?? '').split(/[\s,]+/).filter(Boolean);
const DEBUG_DIR = env.MD_DEBUG_DIR || '';
const MAX_DEBUG_PAGES = 3;
const IN_ACTIONS = env.GITHUB_ACTIONS === 'true';
const PAGE_BUDGET_MS = 100_000; // one page can't take longer than this, whatever happens

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (lo, hi) => lo + Math.random() * (hi - lo);

// In GitHub Actions, warnings and errors also show on the run's summary page.
function note(level, title, msg) {
  if (IN_ACTIONS) console.log(`::${level} title=${title}::${msg}`);
  else console[level === 'error' ? 'error' : 'warn'](`${level === 'error' ? '✖' : '⚠'} ${title}: ${msg}`);
}

// Round-robin proxy picker that can mark a proxy dead for one site (Booking
// or Airbnb) for this run: a block on one site doesn't stop the other. With
// no proxies it yields a single 'direct' slot (the machine's own IP).
const SITE_NAME = { booking: 'Booking', airbnb: 'Airbnb' };
const siteOf = (url) => (isAirbnb(url) ? 'airbnb' : 'booking');
function proxyPool(list) {
  const proxies = (list.length ? list : [null]).map((p) => ({ url: p, dead: new Set() }));
  let i = 0;
  return {
    direct: !list.length,
    next(site) {
      for (let k = 0; k < proxies.length; k++) {
        const p = proxies[(i + k) % proxies.length];
        if (!p.dead.has(site)) { i = (i + k + 1) % proxies.length; return p; }
      }
      return null; // all dead for this site
    },
    flag(p, site, reason) {
      p.dead.add(site);
      const who = p.url ? p.url.replace(/:[^:@/]+@/, ':****@') : 'this machine\'s own IP';
      note('warning', `${SITE_NAME[site]} blocked a connection`, `${who}: ${reason}`);
    },
    allDead(site) { return proxies.every((p) => p.dead.has(site)); },
  };
}

function parseProxy(url) {
  if (!url) return undefined; // direct, no proxy
  const u = new URL(url);
  const out = { server: `${u.protocol}//${u.host}` };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  return out;
}

// Booking answers a fresh visitor with an AWS WAF check page (HTTP 202, an
// empty title and a #challenge-container) that runs some JavaScript and then
// reloads into the real page. A normal browser gets through on its own in a
// few seconds; give it time, and treat one that never clears as a block.
async function waitOutCheck(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Only a fully parsed page counts: the check page reloads itself, and a
    // half-loaded reload has no container yet. evaluate() throws mid-navigation.
    const cleared = await page.evaluate(() => document.readyState !== 'loading' && !document.getElementById('challenge-container'))
      .catch(() => false);
    if (cleared) return true;
    await sleep(1000);
  }
  return false;
}

// Browser mode only: a person reads the page, scrolling down towards the rooms.
async function lookAround(page) {
  const steps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, between(250, 700)).catch(() => {});
    await sleep(between(800, 2500));
  }
}

function parsePrice(txt) {
  const m = String(txt).replace(/[, ]/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Read Booking's property page for the dates asked:
//   { state: 'blocked' | 'fault' | 'closed' | 'unavailable' | 'ok' | 'empty', rooms: [{name, price, left}] }
// rooms: every room type offered, one entry per rate (price = the stay's
// total), with how many of that room are left when Booking says.
async function readPage(page) {
  const title = (await page.title()).toLowerCase();
  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/captcha|are you a robot|access denied|access forbidden|unusual traffic|verify you are human|confirm you are human|detected as a robot/.test(title + ' ' + bodyText)) {
    return { state: 'blocked', rooms: [] };
  }
  // Booking's own error page ("Oops! … Error code: 502"): a passing fault on
  // their side, worth another try, not a sign the page changed.
  const fault = bodyText.match(/error code:?\s*(5\d\d)/);
  if (fault) return { state: 'fault', rooms: [], code: fault[1] };
  // "This property isn't taking reservations on our site right now": no
  // prices for anyone on any date, so nothing to read until it reopens.
  if (/isn['’]t taking reservations on our site/.test(bodyText)
    || await page.locator('[rel="this_hotel_is_not_bookable"]').first().isVisible().catch(() => false)) return { state: 'closed', rooms: [] };
  if (await page.locator('#no_availability_msg').count()) return { state: 'unavailable', rooms: [] };

  // The room table: one row per rate, the room type's name in the first row of
  // its group; data-hotel-rounded-price is the stay's total; the "select
  // rooms" dropdown's highest number is how many are left.
  const rooms = await page.$$eval('tr.js-rt-block-row', (rows) => {
    let current = '';
    return rows.map((tr) => {
      const nameEl = tr.querySelector('.hprt-roomtype-icon-link, a.hprt-roomtype-link, [data-room-name]');
      if (nameEl) current = (nameEl.getAttribute('data-room-name') || nameEl.textContent || '').replace(/\s+/g, ' ').trim();
      const sel = tr.querySelector('select.hprt-nos-select') || tr.querySelector('select');
      const counts = sel ? [...sel.options].map((o) => parseInt(o.value, 10)).filter((n) => Number.isFinite(n)) : [];
      return { name: current, price: parseFloat(tr.getAttribute('data-hotel-rounded-price')), left: counts.length ? Math.max(...counts) : null };
    }).filter((r) => r.name && r.price > 0);
  }).catch(() => []);
  if (rooms.length) return { state: 'ok', rooms };

  // A place that shows one price and no room table (some villas).
  const priceEl = page.locator('.bui-price-display__value .prco-valign-middle-helper').first();
  if (await priceEl.count()) {
    const total = parsePrice(await priceEl.innerText().catch(() => ''));
    if (total) return { state: 'ok', rooms: [{ name: 'Whole place', price: total, left: null }] };
  }
  return { state: 'empty', rooms: [] };
}

// Close without ever hanging the run (a wedged browser can hang close()).
function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(t)), timer]);
}
async function safeClose(thing) {
  try { await withTimeout(thing.close(), 10000, 'close'); } catch { /* abandon it */ }
}

// One browser context per connection (just one without proxies), kept for the
// whole run so the bot-check cookie carries over from page to page.
function session(browser, userAgent) {
  const contexts = new Map();
  return {
    async page(proxy) {
      let ctx = contexts.get(proxy);
      if (!ctx) {
        const opts = { userAgent, viewport: { width: 1366, height: 900 }, locale: 'en-US' };
        const px = parseProxy(proxy.url);
        if (px) opts.proxy = px;
        ctx = await browser.newContext(opts);
        contexts.set(proxy, ctx);
      }
      const page = await ctx.newPage();
      page.setDefaultTimeout(10_000); // no single lookup may stall the page budget
      return page;
    },
    async drop(proxy) {
      const ctx = contexts.get(proxy);
      contexts.delete(proxy);
      if (ctx) await safeClose(ctx);
    },
    async close() { for (const p of [...contexts.keys()]) await this.drop(p); },
  };
}

let debugSaved = 0;
async function saveDebug(page, label, why) {
  if (!DEBUG_DIR || debugSaved >= MAX_DEBUG_PAGES) return;
  debugSaved++;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const base = join(DEBUG_DIR, `${label.replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 60)}-${why}`);
    writeFileSync(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png`, fullPage: false });
  } catch { /* debugging aid only */ }
}

// ── Airbnb ──────────────────────────────────────────────────────────────
//
// An Airbnb listing is one place: its "room" is the whole listing. Opening it
// for the stay, Airbnb's own page asks Airbnb for two things we keep:
//   PdpAvailabilityCalendar…  a year of nights: free or not, minimum stay
//                             (PdpAvailabilityCalendarV2Query since
//                             October 2026, so matched by name prefix)
//   StaysPdpSections          the booking box: "$385 for 2 nights", and
//                             "2 nights x $192.30" (fees included)
// Both come back as the page's own network calls; the same data is sometimes
// in the page itself (JSON in script tags), read as a fallback.

const AIRBNB_ROOM = 'Whole listing'; // the room type an Airbnb comparable follows
let calendarWarned = false; // the missing-calendar warning, once a run
const isAirbnb = (url) => /^https:\/\/www\.airbnb\.[a-z.]+\/rooms\//i.test(url);

function findKey(value, name, out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 40 || out.length > 20) return out;
  if (Array.isArray(value)) { for (const v of value) findKey(v, name, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(value)) {
    if (k === name) out.push(v);
    findKey(v, name, out, depth + 1);
  }
  return out;
}

// The booking box's price for the stay, from a StaysPdpSections response:
// "2 nights x $192.30" (per night × nights), else "$385 for 2 nights", else
// "$190 night" × nights. null = no price (dates taken, or a longer minimum stay).
function airbnbStayPrice(json, nights) {
  const box = findKey(json, 'sections').flat().find((x) => x && /^BOOK_IT/.test(x.sectionId || '') && x.section && x.section.structuredDisplayPrice);
  const sdp = box ? box.section.structuredDisplayPrice : findKey(json, 'structuredDisplayPrice')[0];
  if (!sdp) return null;
  const money = (txt) => { const m = String(txt || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : null; };
  for (const item of findKey(sdp, 'items').flat()) {
    const m = String(item && item.description || '').replace(/,/g, '').match(/(\d+)\s*nights?\s*x\s*\D{0,3}(\d+(?:\.\d+)?)/i);
    if (m) return Math.round(parseFloat(m[2]) * Number(m[1]) * 100) / 100;
  }
  const line = sdp.primaryLine || {};
  const price = money(line.discountedPrice || line.price);
  if (!price) return null;
  const q = String(line.qualifier || line.accessibilityLabel || '');
  return /for\s+\d+\s+nights?/i.test(q) ? price : /night/i.test(q) ? Math.round(price * nights * 100) / 100 : price;
}

// The calendar as one string from its first night: F = free, G = not free.
function airbnbCalendar(months) {
  const days = (months || []).flatMap((m) => (m && m.days) || []).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.calendarDate || ''));
  if (!days.length) return null;
  days.sort((a, b) => a.calendarDate.localeCompare(b.calendarDate));
  const by = new Map(days.map((d) => [d.calendarDate, d]));
  let states = '';
  for (let d = new Date(days[0].calendarDate + 'T00:00:00Z'); states.length < 400; d = addDays(d, 1)) {
    const day = by.get(iso(d));
    if (!day) break;
    states += day.available ? 'F' : 'G';
  }
  return { start: days[0].calendarDate, states };
}

async function openAirbnb(page, task) {
  const u = new URL(task.url);
  const nights = Math.max(1, Math.round((Date.parse(u.searchParams.get('check_out')) - Date.parse(u.searchParams.get('check_in'))) / 86_400_000) || 1);
  let months = null, total = null, sawSections = false;
  const ops = new Set(); // every Airbnb call the page made, for the log when nothing was read
  page.on('response', async (r) => {
    const url = r.url();
    if (!url.includes('/api/v3/')) return;
    const op = new URL(url).searchParams.get('operationName') || url.split('/api/v3/')[1].split(/[/?]/)[0];
    ops.add(op);
    const calendarOp = /^PdpAvailabilityCalendar/.test(op);
    if (!calendarOp && op !== 'StaysPdpSections') return;
    try {
      const j = await r.json();
      if (calendarOp) months = months || findKey(j, 'calendarMonths')[0] || null;
      else { sawSections = true; if (total == null) total = airbnbStayPrice(j, nights); }
    } catch { /* not JSON */ }
  });
  const resp = await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (resp && (resp.status() === 403 || resp.status() === 429)) {
    await saveDebug(page, task.label, 'blocked');
    return { blocked: `HTTP ${resp.status()}` };
  }
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
  await lookAround(page); // the calendar loads as the page is scrolled
  for (let i = 0; i < 20 && !(months && sawSections); i++) await sleep(500);
  const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/captcha|are you a robot|access denied|unusual traffic|verify you are human|confirm you are human/.test(text)) {
    await saveDebug(page, task.label, 'blocked');
    return { blocked: 'Airbnb refused the page' };
  }
  if (!months || !sawSections) { // the same data, put in the page itself
    const blobs = await page.$$eval('script[type="application/json"], script#data-deferred-state-0', (ss) => ss.map((x) => x.textContent || '')).catch(() => []);
    for (const b of blobs) {
      if (!b.includes('calendarMonths') && !b.includes('structuredDisplayPrice')) continue;
      try {
        const j = JSON.parse(b);
        months = months || findKey(j, 'calendarMonths')[0] || null;
        if (total == null) total = airbnbStayPrice(j, nights);
      } catch { /* not JSON */ }
    }
  }
  const calendar = airbnbCalendar(months);
  // The page made its calls but no calendar came back: the call was renamed
  // (as in October 2026), reshaped, or slow. Said once a run, with the calls seen.
  if (!calendar && sawSections && !calendarWarned) {
    calendarWarned = true;
    const seen = [...ops].some((o) => /^PdpAvailabilityCalendar/.test(o));
    note('warning', 'Airbnb calendar not found', `${task.label}: ${seen ? 'the calendar call came back without a calendar (reshaped or slow?)' : 'no calendar call seen (renamed?)'}; the page's calls were ${[...ops].join(', ')}`);
  }
  if (!calendar && total == null) {
    await saveDebug(page, task.label, 'empty');
    return { outcome: 'empty', rooms: [] };
  }
  if (total != null) return { outcome: 'ok', rooms: [{ name: AIRBNB_ROOM, price: total, left: 1 }], calendar };
  // No price for the stay: its check-in night is taken, or the minimum stay is longer than the search.
  const ci = calendar ? Math.round((Date.parse(u.searchParams.get('check_in')) - Date.parse(calendar.start)) / 86_400_000) : -1;
  const taken = calendar && ci >= 0 && calendar.states[ci] === 'G';
  return { outcome: taken ? 'unavailable' : 'ok', rooms: [], calendar };
}

// Open one page: {outcome, rooms, calendar?} or {blocked: reason}.
async function open(page, task) {
  if (isAirbnb(task.url)) return openAirbnb(page, task);
  const resp = await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (resp && (resp.status() === 403 || resp.status() === 429)) {
    await saveDebug(page, task.label, 'blocked');
    return { blocked: `HTTP ${resp.status()}` };
  }
  if (!(await waitOutCheck(page, 30_000))) {
    await saveDebug(page, task.label, 'check');
    return { blocked: 'the bot check never cleared' };
  }
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
  if (BROWSER_MODE) await lookAround(page);
  const { state, rooms, code } = await readPage(page);
  if (state === 'fault') throw new Error(`Booking error ${code}`);
  if (state === 'blocked') {
    await saveDebug(page, task.label, 'blocked');
    return { blocked: 'Booking refused the page' };
  }
  if (state === 'empty') await saveDebug(page, task.label, 'empty');
  return { outcome: state, rooms };
}

async function visit(browserSession, pool, task) {
  const site = siteOf(task.url);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const proxy = pool.next(site);
    if (!proxy) break;
    let page;
    try {
      const seen = await withTimeout((async () => {
        page = await browserSession.page(proxy);
        return open(page, task);
      })(), PAGE_BUDGET_MS, task.label);
      if (seen.blocked) {
        pool.flag(proxy, site, seen.blocked);
        await browserSession.drop(proxy);
        continue;
      }
      return { page: task.page, ...seen };
    } catch (e) {
      const msg = String(e?.message ?? e).split('\n')[0].slice(0, 200);
      console.warn(`  ${task.label}: ${msg}`);
      if (attempt === 2) return { page: task.page, outcome: 'error', error: msg };
    } finally {
      if (page) await safeClose(page);
    }
  }
  return { page: task.page, outcome: 'blocked', error: 'blocked' };
}

// Dry runs: two weeks ahead, 2 nights, 2 guests, for each page in the list.
function dryRunPages() {
  const list = JSON.parse(readFileSync(new URL('./dry-run-pages.json', import.meta.url), 'utf-8')).pages || [];
  const checkin = iso(addDays(new Date(), 14));
  const checkout = iso(addDays(new Date(), 16));
  return list.map((p) => {
    const u = new URL(p.url);
    const params = isAirbnb(p.url)
      ? { check_in: checkin, check_out: checkout, adults: '2', currency: 'USD' }
      : { checkin, checkout, group_adults: '2', group_children: '0', no_rooms: '1', lang: 'en-us', selected_currency: 'USD' };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return { page: p.name, url: u.toString(), label: `${p.name} · ${checkin} · 2n · 2p` };
  }).sort(() => Math.random() - 0.5);
}

async function api(path, body) {
  const r = await fetch(SERVICE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status} ${JSON.stringify(out)}`);
  return out;
}

function describe(task, r) {
  const cal = r.calendar ? ` · calendar ${r.calendar.start} +${r.calendar.states.length} nights (${(r.calendar.states.slice(0, 90).match(/F/g) || []).length} of the next 90 free)` : '';
  return describeRooms(task, r) + cal;
}
function describeRooms(task, r) {
  const what = r.outcome === 'ok'
    ? (r.rooms.length ? r.rooms.map((x) => `${x.name} $${x.price}${x.left != null ? ` (${x.left} left)` : ''}`).join(' · ') : 'no price for these dates (minimum stay?)')
    : r.outcome === 'unavailable' ? 'nothing available'
      : r.outcome === 'closed' ? 'Booking isn\'t taking reservations for this place'
      : r.outcome === 'empty' ? 'page opened, no room table found'
        : r.outcome === 'skipped' ? 'not opened (out of time or blocked)'
          : `${r.outcome}${r.error ? ` (${r.error})` : ''}`;
  return `  ${task.label}: ${what}`;
}

async function main() {
  if (!DRY && !API_KEY) { note('error', 'No API key', 'MD_API_KEY is not set (the platform\'s MARKET_COLLECTOR_KEY)'); return 1; }
  // GitHub skips many scheduled runs, so a run that does start keeps asking
  // for pages until today's are done or its time is up, still one page at a
  // time; each batch is sent back as soon as it's done.
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  const pool = proxyPool(PROXIES);
  const results = [];
  let browser = null, browserSession = null, opened = 0;
  try {
    for (let round = 0; ; round++) {
      let tasks, remaining = 0;
      if (DRY) {
        if (round) break;
        tasks = dryRunPages().slice(0, MAX_PAGES);
        console.log(`DRY RUN: ${tasks.length} pages; nothing is sent to the platform.`);
      } else {
        if (round && Date.now() > deadline - 2 * 60_000) break; // don't take pages we can't open
        const lease = await api('/__market/lease', { max: MAX_PAGES });
        tasks = lease.pages || [];
        remaining = lease.remaining || 0;
        console.log(`${round ? 'Next: ' : ''}${tasks.length} pages; ${remaining} more waiting today.`);
      }
      if (!tasks.length) break;
      if (!browser) {
        browser = await chromium.launch({ headless: true, channel: 'chromium' });
        // Robot: says what it is and how to reach whoever runs it. Browser: the
        // browser's real version, minus the "Headless" marker.
        const userAgent = BROWSER_MODE
          ? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Safari/537.36`
          : `Mozilla/5.0 (compatible; ChasingTheMoon-market-robot/1.0; +https://chasingthemoon.org; ${CONTACT})`;
        console.log(`As: ${userAgent}${pool.direct ? '' : ` (through ${PROXIES.length} proxies)`}`);
        browserSession = session(browser, userAgent);
      }
      const batch = [];
      let openedNow = 0;
      for (const task of tasks) {
        const blocked = pool.allDead(siteOf(task.url));
        if (opened && !blocked) await sleep(between(PAUSE_MIN, PAUSE_MAX) * 1000);
        const r = Date.now() > deadline || blocked
          ? { page: task.page, outcome: 'skipped' }
          : (opened++, openedNow++, await visit(browserSession, pool, task));
        batch.push(r);
        console.log(describe(task, r));
      }
      if (!DRY) {
        const out = await api('/__market/results', { results: batch });
        console.log(`Sent: ${out.saved} nightly prices saved.`);
      }
      results.push(...batch);
      // Every page this round was for a site that blocked us: the rest of
      // today's pages are too, so stop asking.
      if (DRY || !remaining || !openedNow) break;
    }
  } finally {
    if (browserSession) await browserSession.close();
    if (browser) await safeClose(browser);
  }
  if (!results.length) { console.log('Nothing to open right now.'); return 0; }

  const count = (o) => results.filter((r) => r.outcome === o).length;
  const read = count('ok') + count('unavailable') + count('closed');
  console.log(`\n${read} of ${results.length - count('skipped')} pages read (${count('ok')} with rooms, ${count('unavailable')} fully booked, ${count('closed')} not taking reservations, ${count('empty')} without a room table, ${count('blocked')} blocked, ${count('error')} failed).`);
  if (read) {
    if (count('blocked')) note('warning', 'Partly blocked', `Booking blocked ${count('blocked')} pages this run.`);
    return 0;
  }
  if (count('blocked')) {
    note('error', 'Blocked', BROWSER_MODE
      ? 'Booking blocked every page this run. It retries on the next run; if it keeps happening, add proxies (MD_PROXIES).'
      : 'Booking refused the robot this run. It retries on the next run; MD_IDENTITY=browser is the usual identity.');
    return 2;
  }
  if (count('empty')) { note('error', 'No prices found', 'Pages opened but no room table was found. Booking may have changed its page; see the saved debug pages.'); return 3; }
  note('error', 'Collector failed', 'No page could be opened; see the log above.');
  return 1;
}

main().then((code) => process.exit(code), (err) => {
  note('error', 'Collector crashed', String(err?.stack ?? err));
  process.exit(1);
});
