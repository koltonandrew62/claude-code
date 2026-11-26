# Catalyst

An event radar and stock screener. It watches for the things that move a stock in a big way — mergers,
FDA decisions, earnings, sudden unusual activity — and scores each company 0–100 on how strongly those
signals are firing right now. Every score shows the evidence behind it.

Black UI, zero dependencies, no API keys.

## Run it

```bash
cd catalyst
```

```bash
node server.js
```

Then open http://localhost:4173. Requires Node 20 or newer.

For a desktop shortcut that starts the app and opens it in your browser, run this once:

```bash
node shortcut.js
```

The SEC asks automated clients to identify themselves. Before heavy use, set your own contact string:

```bash
SEC_USER_AGENT="Your Name you@example.com" node server.js
```

## What it does

| View | What you get |
|---|---|
| **Screener** | Score a list of tickers and filter by catalyst score, M&A / FDA / earnings / event scores, news sentiment, days to earnings, market cap, volume, revenue growth, price. One-click preset screens, save your own, watchlist stars, CSV export. |
| **Company detail** | Click any row (or type a ticker, press `/`). Price chart with earnings and M&A-filing markers plus a likely 30-day range, the evidence behind each score, trial pipeline with approval odds, earnings reaction history, an EPS model estimate, scored headlines, recent filings. |
| **Options** | Pick any stock or ETF (QQQ, NVDA…). You get an up / down price forecast for the next 5 trading days, and — with a free options key — every strike of the chosen expiration, calls and puts, marked green (expected to gain value) or red. |
| **Calendar** | Upcoming estimated earnings dates and FDA / trial catalysts across everything you screened. |
| **Signal tape** | Every dated signal across your screen, newest first. |
| **Jet tracker** | Live map of large business jets, your companies' headquarters, and jets parked near them. |

## How the scores work

These are transparent rule-based signals, not a trained model and not investment advice. Nothing can
reliably predict a merger or an FDA decision; this tells you where the public evidence is piling up.

- **M&A** — SEC filings about the company: tender offers, merger proxies, 13D activist stakes and
  amendments, change-in-control 8-Ks, merger communications. "Strategic alternatives" language in its
  8-Ks. Takeover language in headlines. Tagged-jet visits. Plus how attractive it is as a target (size,
  EV/sales, net cash, distance from its high, unusual volume). Filings a company makes *about another
  company* are separated from filings about itself, so a bidder is not mistaken for a target.
- **FDA** — Phase 2/3 trials the company sponsors with data due in the next 12 months
  (ClinicalTrials.gov), decision dates found in headlines, and the sponsor's approval track record
  (openFDA). Approval odds are published historical base rates by phase and disease area, adjusted for
  track record. The score weighs how close the catalyst is and how much one drug matters to a company
  that size.
- **Earnings** — The next report date is projected from the company's own reporting pattern. Typical
  move is the average of its past earnings reactions. The lean combines EPS trend, revenue
  acceleration, past reactions, price trend and news tone. The EPS estimate is a seasonal model
  (year-ago quarter plus recent year-over-year change), not analyst consensus.
- **Event radar** — Is something brewing, whatever it is: abnormal volume, expanding or tightly
  coiled volatility, price gaps, a burst of 8-Ks, high-impact 8-K items, a spike in news flow.
- **News sentiment** — Recent headlines scored with a finance word list, weighted toward the last few
  days, with fund-holdings spam and law-firm ads removed.

## Outlook and price ranges

- **Outlook (−100 to +100)** — one bullish / bearish read built from three separate scores: *technical*
  (trend, momentum, RSI, MACD), *fundamental* (EPS growth, how often it beats estimates, revenue growth,
  analyst ratings and price targets) and *news* (headline tone), weighted 45 / 35 / 20. A missing score
  is left out and the weights rebalanced. The hosted edition ranks screens by it: most bullish, most
  bearish, best earnings growth, biggest beats, most bullish earnings setup, analyst favorites.
- **Price ranges** — 68% and 90% confidence bands for one week, one month and three months. The width
  is taken from the stock's own record: a 90% band is as wide as it had to be to contain nine out of
  ten moves of that length over the past two years. The expected price is shifted by the outlook
  score, and only slightly, because how far a stock can move is far easier to estimate than which way.

## Price forecast and options

- **Price forecast** — Five technical factors (price vs its 50-day average, 50- vs 200-day trend, 20-day
  momentum, RSI, MACD), each scaled by the stock's own volatility, plus news sentiment. They tilt the
  odds away from the stock's baseline drift. How far they may tilt is set by a walk-back test: how often
  the same signal called the next 5 days correctly on this stock over the past year. If the signal has
  no track record on a stock, the forecast stays near 50/50.
- **Options** — Each contract is valued with Black-Scholes at today's price and again after the
  holding period, averaged across the range of prices the forecast allows (expected volatility is half
  the market's implied volatility, half the stock's recent realized volatility). Green means the expected
  value is higher than today's; red means lower. Time decay counts against every contract, so with no
  directional edge most long options are red — which is how options actually behave.

Short-term direction is close to a coin flip. Treat a forecast as a lean, not a promise.

## API keys

Everything runs without keys except option chains. Click **API keys** in the app to enter them; they are
saved only on your computer in `data/settings.json`, and each one has a **Test** button.

| Key | What it unlocks | Free signup |
|---|---|---|
| SEC contact (name + email) | Identifies you to SEC EDGAR, as the SEC asks. No key. | https://www.sec.gov/search-filings/edgar-application-programming-interfaces |
| Tradier token | Option chains with implied volatility and greeks (sandbox is 15 minutes delayed) | https://developer.tradier.com/ |
| Alpha Vantage key | Option chains (prior session) if you have no Tradier token; second news-sentiment source. 25 requests a day. | https://www.alphavantage.co/support/#api-key |
| Finnhub key | Confirmed earnings dates and analyst EPS estimates | https://finnhub.io/register |

Other free market-data APIs worth knowing (not wired in): Polygon.io, Twelve Data, Financial Modeling
Prep, Tiingo, MarketData.app, Alpaca Market Data, FRED, openFDA, OpenSky Network. Links are on the
API keys page.

## Appearance

The **Appearance** button (top right) switches between dark, light and match-system themes, six accent
colours and comfortable or compact tables. The choice is saved in your browser.

The same panel sets **auto-refresh** (off, every 5 or every 15 minutes): the current screen reloads in
place while the tab is visible. In the hosted edition this refreshes the live Robinhood data; its news,
FDA and jet snapshot only changes when `web/feed.js` is run and published again.

## Index and ETF screens (hosted edition)

Under **Universe → Live scans** pick an index (all US stocks, S&P 500/100/400/600, Nasdaq 100, Dow 30,
Russell 1000/2000/3000/Midcap/Microcap, semiconductors, housing, oil services, utilities, gold miners)
and a ranking (largest, unusual volume, breakouts, beaten down, earnings or revenue growth, low P/E,
dividend yield, oversold, overbought, reporting within 7 days). The top 100 matches are analyzed.
Seven ETF lists (broad market, sectors, themes, international, bonds, commodities and crypto, leveraged)
sit under **Universe → ETFs**; they use live data only.

## Markets covered

US-listed stocks and ETFs get everything. Asian and European companies are covered through their US
listings (the `Asia (US-listed)` and `Europe (US-listed)` lists): SEC filings, US option chains and
Robinhood only exist for those. In the PC version's Options tab you can also type a foreign-exchange
symbol in Yahoo's format (`7203.T` Tokyo, `0700.HK` Hong Kong, `SAP.DE` Frankfurt, `MC.PA` Paris,
`SHEL.L` London) for a price forecast; filings, FDA and option chains are not available for those.

## Jet tracker

Corporate jets turning up next to another company's headquarters is a classic deal-talk tell. Aircraft
registrations are public, but no free feed maps tail numbers to listed companies, so the workflow is:

1. Run a screen. Each company is placed on the map at its headquarters.
2. Jets on the ground within 40 km of a headquarters are highlighted.
3. Click a jet, use **Look up owner** (FAA registry), and **tag** it to a ticker.
4. From then on, when a tagged jet lands near a *different* tracked company's headquarters, the visit
   is logged and added to both companies' M&A scores. Tags and the visit log live in `data/`.

Visits are only detected while the app is running and the Jet tracker tab is open.

## Data sources

All free and keyless: SEC EDGAR (filings, financials, full-text search), Yahoo Finance (daily prices),
Google News (headlines), ClinicalTrials.gov, openFDA, US Census and OpenStreetMap geocoders (headquarters
locations), adsb.lol (aircraft positions). Responses are cached in `.cache/`. Dots in the top-right
corner show which sources are responding.

## Hosted edition (`web/`)

A single page that runs as a Claude artifact — open a link, nothing to install. A hosted page cannot
fetch outside data, so it gets its data two ways:

- **Live, in the browser** — prices, fundamentals, earnings history and dates, SEC filing lists and full
  option chains come from the viewer's Robinhood connector.
- **Back-end snapshot** — `web/feed.js` runs the full engine in this repo for every ticker in
  `web/universes.json` (news sentiment, SEC-based M&A signals, FDA trial catalysts) and sweeps the
  aircraft feed, writing `web/dist/data/feed.json` and `jets.json`. Those are published beside the page.

```bash
node web/build.js
```

```bash
node web/feed.js
```

The universe menu also offers **live scans of every US-listed stock** (unusual volume, breakouts, earnings this week,
S&P 500, Nasdaq 100, Russell 2000…) through Robinhood's scanner; the top 100 matches are analyzed.
Company logos are downloaded by the feed and shipped as data: URIs in `data/logos.json`.

Then publish `web/dist`. News, FDA and jets are only as fresh as the last feed run; tickers outside
`web/universes.json` get live data and forecasts but no news or FDA sections. `node web/feed.js
--jets-only` re-sweeps aircraft only; set `CATALYST_ADSB_GAP=6000` if the aircraft feed rate-limits.

## Tests

```bash
npm test
```
