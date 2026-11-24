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
