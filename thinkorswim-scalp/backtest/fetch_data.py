"""Download intraday bars from Yahoo Finance's public chart endpoint into data/*.csv.

Yahoo only serves 5-minute bars for the last 60 days and hourly bars for the
last ~730 days, so the CSVs committed next to this script are a snapshot.
"""
import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).parent / "data"
SYMBOLS = ["SPY", "QQQ", "IWM", "^VIX", "^VXN"]
SPECS = {"1m": 29, "5m": 59, "1h": 729}  # interval -> lookback days
CHUNK_DAYS = {"1m": 7}  # Yahoo serves 1-minute bars at most 8 days per request


def fetch(symbol, interval, days):
    now = int(time.time())
    chunk = CHUNK_DAYS.get(interval)
    if chunk and days > chunk:
        rows, start = {}, now - days * 86400
        while start < now:
            for r in fetch_range(symbol, interval, start, min(start + chunk * 86400, now)):
                rows[r[0]] = r
            start += chunk * 86400
            time.sleep(0.5)
        return [rows[k] for k in sorted(rows)]
    return fetch_range(symbol, interval, now - days * 86400, now)


def fetch_range(symbol, interval, start, end):
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(symbol)
        + f"?interval={interval}&period1={start}&period2={end}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(res.get("timestamp", [])):
        o, h, l, c, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c):
            continue
        rows.append([datetime.fromtimestamp(ts, timezone.utc).isoformat(), o, h, l, c, v or 0])
    return rows


def main():
    DATA.mkdir(exist_ok=True)
    for sym in SYMBOLS:
        for interval, days in SPECS.items():
            rows = fetch(sym, interval, days)
            out = DATA / f"{sym.replace('^', '')}_{interval}.csv"
            with open(out, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["ts_utc", "open", "high", "low", "close", "volume"])
                w.writerows([[r[0]] + [round(x, 4) for x in r[1:5]] + [r[5]] for r in rows])
            print(f"{out.name}: {len(rows)} bars {rows[0][0][:10]} -> {rows[-1][0][:10]}", file=sys.stderr)
            time.sleep(0.5)


if __name__ == "__main__":
    main()
