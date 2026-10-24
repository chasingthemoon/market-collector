// airbnb-probe.js — can a GitHub runner read Airbnb the way the collector
// reads Booking? A test that sends nothing anywhere.
//
// Opens an Airbnb search (Uvita by default), takes a few listings, opens each
// for a stay two weeks ahead (2 nights, 2 guests) the way a visitor would,
// and prints what Airbnb's own page loaded:
//   - the availability calendar (Airbnb's PdpAvailabilityCalendar… call, or the
//     same data in the page): how many nights are free, the minimum stay;
//   - the price for the stay (the booking box: nightly price, fees, total).
// Pages it couldn't read are saved (HTML + screenshot) to MD_DEBUG_DIR.
//
// Env:
//   PROBE_SEARCH    an Airbnb search URL (default: homes in Uvita, 2 guests)
//   PROBE_LISTINGS  listing URLs instead of a search, comma separated
//   PROBE_COUNT     how many listings (default 4)
//   MD_DEBUG_DIR    where to save pages that couldn't be read
//
// Run: node airbnb-probe.js

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const SEARCH = env.PROBE_SEARCH || 'https://www.airbnb.com/s/Uvita--Puntarenas-Province--Costa-Rica/homes?adults=2&currency=USD';
const COUNT = Math.max(1, Number(env.PROBE_COUNT) || 4);
const DEBUG_DIR = env.MD_DEBUG_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (lo, hi) => lo + Math.random() * (hi - lo);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

async function saveDebug(page, name) {
  if (!DEBUG_DIR) return;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const base = join(DEBUG_DIR, name.replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 60));
    writeFileSync(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png`, fullPage: false });
  } catch { /* a debugging aid only */ }
}

async function lookAround(page) {
  for (let i = 0; i < 4 + Math.floor(Math.random() * 3); i++) {
    await page.mouse.wheel(0, between(300, 800)).catch(() => {});
    await sleep(between(800, 2000));
  }
}

const blockedText = /captcha|are you a robot|access denied|unusual traffic|verify you are human|confirm you are human|something went wrong.*security/i;

// Every key `name` anywhere in a JSON value.
function findKey(value, name, out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 40 || out.length > 20) return out;
  if (Array.isArray(value)) { for (const v of value) findKey(v, name, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(value)) {
    if (k === name) out.push(v);
    findKey(v, name, out, depth + 1);
  }
  return out;
}

function summarizeCalendar(months, checkin) {
  const days = months.flatMap((m) => m.days || []);
  if (!days.length) return null;
  const ahead = days.filter((d) => d.calendarDate >= iso(new Date()) && d.calendarDate < iso(addDays(new Date(), 90)));
  const free = ahead.filter((d) => d.available).length;
  const ci = days.find((d) => d.calendarDate === checkin) || {};
  return {
    nights: days.length,
    from: days[0].calendarDate,
    to: days[days.length - 1].calendarDate,
    next90: `${free} of ${ahead.length} nights free`,
    checkin: { available: ci.available, availableForCheckin: ci.availableForCheckin, minNights: ci.minNights, maxNights: ci.maxNights, price: ci.price && (ci.price.localPriceFormatted || ci.price.localPrice) },
    sample: days.slice(0, 14).map((d) => `${d.calendarDate.slice(5)}:${d.available ? 'free' : 'gone'}${d.minNights ? '/' + d.minNights + 'n' : ''}`).join(' '),
  };
}

function summarizePrice(json) {
  const sdp = findKey(json, 'structuredDisplayPrice')[0];
  if (!sdp) return null;
  const line = sdp.primaryLine || {};
  const items = findKey(sdp, 'items').flat().filter((x) => x && x.description).map((x) => `${x.description}: ${x.priceString || ''}`);
  return {
    primary: line.accessibilityLabel || [line.price, line.discountedPrice, line.qualifier].filter(Boolean).join(' '),
    secondary: sdp.secondaryLine ? (sdp.secondaryLine.accessibilityLabel || sdp.secondaryLine.price) : '',
    breakdown: items.slice(0, 8),
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Safari/537.36`;
  const ctx = await browser.newContext({ userAgent, viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/Costa_Rica' });
  console.log(`As: ${userAgent}`);
  let ok = 0;
  try {
    let urls = String(env.PROBE_LISTINGS || '').split(/[\s,]+/).filter(Boolean);
    if (!urls.length) {
      const page = await ctx.newPage();
      const resp = await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
      await lookAround(page);
      const text = await page.locator('body').innerText().catch(() => '');
      console.log(`Search: HTTP ${resp && resp.status()} · "${await page.title()}"`);
      if (blockedText.test(text)) { console.log('  blocked on the search page'); await saveDebug(page, 'search-blocked'); }
      const ids = [...new Set((await page.$$eval('a[href*="/rooms/"]', (as) => as.map((a) => a.getAttribute('href')))).map((h) => (String(h).match(/\/rooms\/(\d+)/) || [])[1]).filter(Boolean))];
      console.log(`  ${ids.length} listings on the page`);
      if (!ids.length) await saveDebug(page, 'search-empty');
      urls = ids.slice(0, COUNT).map((id) => `https://www.airbnb.com/rooms/${id}`);
      await page.close();
    }
    const checkin = iso(addDays(new Date(), 14));
    const checkout = iso(addDays(new Date(), 16));
    for (const [i, base] of urls.entries()) {
      await sleep(between(10_000, 25_000));
      const id = (base.match(/\/rooms\/(\d+)/) || [])[1] || base;
      const url = `https://www.airbnb.com/rooms/${id}?check_in=${checkin}&check_out=${checkout}&adults=2&currency=USD`;
      const page = await ctx.newPage();
      const calls = [];
      let calendar = null, price = null;
      page.on('response', async (r) => {
        const u = r.url();
        if (!u.includes('/api/v3/')) return;
        const op = new URL(u).searchParams.get('operationName') || u.split('/api/v3/')[1].split(/[/?]/)[0];
        calls.push(`${op}:${r.status()}`);
        if (/^PdpAvailabilityCalendar/.test(op) || op === 'StaysPdpSections' || op === 'StaysPdpBookItQuery') {
          try {
            const j = await r.json();
            if (/^PdpAvailabilityCalendar/.test(op)) calendar = calendar || findKey(j, 'calendarMonths')[0];
            else price = price || summarizePrice(j);
          } catch { /* not JSON */ }
        }
      });
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
        await lookAround(page);
        await sleep(3000);
        const title = await page.title();
        const text = await page.locator('body').innerText().catch(() => '');
        // The same data is often in the page itself (JSON in script tags).
        if (!calendar || !price) {
          const blobs = await page.$$eval('script[type="application/json"], script#data-deferred-state-0, script#data-injector-instances', (ss) => ss.map((s) => s.textContent || '')).catch(() => []);
          for (const b of blobs) {
            if (!b.includes('calendarMonths') && !b.includes('structuredDisplayPrice')) continue;
            try {
              const j = JSON.parse(b);
              if (!calendar) calendar = findKey(j, 'calendarMonths')[0] || null;
              if (!price) price = summarizePrice(j);
            } catch { /* not JSON */ }
          }
        }
        const box = await page.locator('[data-section-id="BOOK_IT_SIDEBAR"]').first().innerText({ timeout: 3000 }).catch(() => '');
        const cal = calendar ? summarizeCalendar(calendar, checkin) : null;
        console.log(`\n[${i + 1}] ${id} · HTTP ${resp && resp.status()} · "${title.slice(0, 80)}"`);
        if (blockedText.test(text)) console.log('  BLOCKED (captcha / security page)');
        console.log(`  Airbnb calls: ${[...new Set(calls)].join(', ') || 'none seen'}`);
        console.log(`  calendar: ${cal ? JSON.stringify(cal) : 'not found'}`);
        console.log(`  price: ${price ? JSON.stringify(price) : 'not found in data'}`);
        console.log(`  booking box: ${box ? JSON.stringify(box.replace(/\s+/g, ' ').slice(0, 300)) : 'not found'}`);
        if (cal && (price || box)) ok++;
        else await saveDebug(page, `listing-${id}`);
      } catch (e) {
        console.log(`\n[${i + 1}] ${id}: ${String(e && e.message || e).split('\n')[0]}`);
        await saveDebug(page, `listing-${id}-error`);
      } finally {
        await page.close().catch(() => {});
      }
    }
    console.log(`\n${ok} of ${urls.length} listings read with a calendar and a price.`);
  } finally {
    await browser.close().catch(() => {});
  }
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
