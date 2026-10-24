# market-collector

The browser half of the **Market** module of the chasingthemoon platform.
Hosts on the platform follow comparable places (Booking.com properties and
Airbnb listings); the platform plans which pages are needed each day, and this
script is the browser that opens them, slowly, and sends back what they show.

```
GitHub runner (scrape.js)                         chasingthemoon platform
  POST /__market/lease    "a few pages"     ←     today's plan: one page per place × date,
                                                  shared between hosts, at most 10 at a time
  open each page in Chrome, evenly paced
  Booking: the room table (room types,
  price for the stay, rooms left)
  Airbnb: the price for the stay and the
  listing's calendar (a year of nights)
  POST /__market/results  what was read     →     each host's comparables keep what they follow
```

It runs here, in a public repository, because GitHub runs public repositories
for free, and outside Cloudflare because Cloudflare's own browser signs every
request as an automated agent.

## When it runs

The platform starts it every hour from 06:00 to 18:00 Costa Rica time
(`workflow_dispatch` with `task: collect`, from the platform's 15-minute cron),
because GitHub's own schedule starts only some runs, often late. The schedule
in `.github/workflows/collect.yml` stays as a fallback. A run reads for at
most 15 minutes, so the day's pages are spread over the day.

**Actions → collect → Run workflow** runs it by hand:
- `dry-run` (the default) opens the pages in `dry-run-pages.json` and prints
  what it read, sending nothing;
- `collect` is a real run;
- `airbnb-probe` opens an Airbnb search for Uvita and a few listings, and prints
  what Airbnb's pages loaded (calendar, price), sending nothing.

## How it introduces itself

As an ordinary desktop Chrome: a normal user agent, a scroll through each
page, 10–30 s between pages. It only reads public, logged-out prices and
availability, never logs in, and on a CAPTCHA or a block it stops for that site
for the run instead of trying to get past it. A block on one site doesn't stop
the pages for the other.

`MD_IDENTITY=robot` makes it say what it is instead (a robot with a contact
address, as Booking asks robots to). Tried on 2026-10-01: Booking let the robot
in but served it pages without the dates, so it is kept only as a setting.

## Reading Booking.com

`readPage()` reads the room table (`tr.js-rt-block-row`: the room type's name
in the first row of its group, `data-hotel-rounded-price` the stay's total, the
highest number in the "select rooms" dropdown how many are left), and falls
back to the single displayed price on places without a room table. A property
Booking "isn't taking reservations" for is reported as such. Pages it couldn't
read are kept (HTML + screenshot) as the `collector-debug` artifact for 3 days.

## Reading Airbnb

A listing opened for a stay (`/rooms/<id>?check_in=…&check_out=…&adults=…`)
makes the page ask Airbnb for two things, which `openAirbnb()` keeps from the
page's own network calls (the same data in the page's script tags is the
fallback):

- `PdpAvailabilityCalendar` (since October 2026 `PdpAvailabilityCalendarV2Query`;
  matched by prefix): a year of nights, free or not, with the minimum
  stay. Sent back as `{start, states}`, one letter per night (F free, G not).
- `StaysPdpSections`: the booking box, e.g. "$385 for 2 nights" and
  "2 nights x $192.30" (fees included). No price for the stay means its dates
  are taken or the minimum stay is longer than the search.

Tried on 2026-10-03 from a data-centre machine: the search, the listing pages
and both calls answered normally.

## Setup

1. Secret **`MD_API_KEY`** (Settings → Secrets and variables → Actions): the
   platform's `MARKET_COLLECTOR_KEY`.
2. On the platform Worker, secret **`MARKET_GH_TOKEN`**: a fine-grained GitHub
   token for this repository only, with *Actions: Read and write*. That is what
   lets the platform start the runs.

Optional: secret `MD_PROXIES`; variables `MD_URL` (the platform, default
`https://join.chasingthemoon.org`), `MD_IDENTITY`, `MD_CONTACT`.

## Running it on your own machine

```bash
npm install                                   # also downloads Chromium
MD_DRY_RUN=1 MD_MAX_PAGES=3 node scrape.js    # try it: prints, sends nothing
node airbnb-probe.js                          # test reading Airbnb
MD_API_KEY=… node scrape.js                   # a real run
```

## Legal footing (not legal advice)

Public, logged-out prices and availability only, a few pages at a time, no
login or account, and it stops rather than getting past a CAPTCHA or a block.
Booking's and Airbnb's terms still don't allow automated reading (a contract
matter), so the footprint is kept small.
