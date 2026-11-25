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
SPECS = {"5m": 59, "1h": 729, "1d": 3660}  # interval -> lookback days


def fetch(symbol, interval, days):
    now = int(time.time())
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(symbol)
        + f"?interval={interval}&period1={now - days * 86400}&period2={now}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(res["timestamp"]):
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
