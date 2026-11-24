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

## Tests

```bash
npm test
```
