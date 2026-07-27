"""Fetch BTS Marketing Carrier On-Time monthlies and collate the training CSV.

No manual downloads: BTS publishes prezipped monthlies (free, no auth) at
https://transtats.bts.gov/PREZIP/ named
On_Time_Marketing_Carrier_On_Time_Performance_Beginning_January_2018_{Y}_{M}.zip
(~37MB zip → ~340MB CSV → trimmed here to the 12 training columns ≈ 33MB).

For each requested month: download → unzip in-memory → keep only the
minimal columns → append to data/delay_data.csv (CamelCase schema — the
canonical training schema as of the 2026-07 refresh). Big intermediates are
never written to disk. A per-month coverage line (rows, covered-event rate)
catches a bad or partial download at a glance; months that fail leave a
LOUD warning and the run continues.

Usage (from agent/):
    python -m training.fetch_and_prepare --end 2026-05 --months 24
    python -m training.fetch_and_prepare --end 2026-05 --months 1 --out data/one_month.csv
"""

from __future__ import annotations

import argparse
import csv
import io
import ssl
import urllib.request
import zipfile
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = AGENT_ROOT / "data" / "delay_data.csv"

PREZIP = (
    "https://transtats.bts.gov/PREZIP/"
    "On_Time_Marketing_Carrier_On_Time_Performance_Beginning_January_2018_{y}_{m}.zip"
)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

# The minimal training schema (see spec/maintenance.md): 8 serving-contract
# features + 3 covered-event labels + Duplicate for hygiene filtering.
KEEP = [
    "Month", "DayofMonth", "DayOfWeek", "Operating_Airline", "Origin", "Dest",
    "CRSDepTime", "Distance", "ArrDelay", "Cancelled", "Diverted", "Duplicate",
]


def month_range(end: str, months: int) -> list[tuple[int, int]]:
    y, m = map(int, end.split("-"))
    out = []
    for _ in range(months):
        out.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return list(reversed(out))


def fetch_month(y: int, m: int) -> bytes | None:
    url = PREZIP.format(y=y, m=m)
    # transtats' TLS chain fails strict verification (same reason curl needs
    # -k); the data is public statistics, so unverified fetch is accepted.
    ctx = ssl._create_unverified_context()  # noqa: SLF001
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=300, context=ctx) as resp:
            return resp.read()
    except Exception as err:  # noqa: BLE001
        print(f"[fetch] {y}-{m:02d}: DOWNLOAD FAILED — {err}")
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--end", required=True, help="latest month, e.g. 2026-05")
    ap.add_argument("--months", type=int, default=24)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    months = month_range(args.end, args.months)
    print(f"[fetch] {len(months)} month(s): {months[0][0]}-{months[0][1]:02d} → {months[-1][0]}-{months[-1][1]:02d}")

    total = 0
    failures: list[str] = []
    with open(args.out, "w", newline="") as out_f:
        writer = csv.writer(out_f)
        writer.writerow(KEEP)
        for y, m in months:
            blob = fetch_month(y, m)
            if blob is None:
                failures.append(f"{y}-{m:02d}")
                continue
            try:
                zf = zipfile.ZipFile(io.BytesIO(blob))
                csv_name = next(n for n in zf.namelist() if n.endswith(".csv"))
                with zf.open(csv_name) as raw:
                    reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig"))
                    header = next(reader)
                    norm = {h.strip(): i for i, h in enumerate(header)}
                    missing = [k for k in KEEP if k not in norm]
                    if missing:
                        raise KeyError(f"missing columns {missing}")
                    idx = [norm[k] for k in KEEP]
                    i_arr, i_can, i_div = norm["ArrDelay"], norm["Cancelled"], norm["Diverted"]
                    n = pos = 0
                    for row in reader:
                        writer.writerow([row[i] for i in idx])
                        n += 1
                        try:
                            if (row[i_can] and float(row[i_can]) >= 1) or (
                                row[i_div] and float(row[i_div]) >= 1
                            ) or (row[i_arr] and float(row[i_arr]) >= 180):
                                pos += 1
                        except ValueError:
                            pass
                    total += n
                    print(f"[fetch] {y}-{m:02d}: {n:,} flights, covered-event {pos / n * 100:.2f}%")
            except Exception as err:  # noqa: BLE001
                print(f"[fetch] {y}-{m:02d}: PARSE FAILED — {err}")
                failures.append(f"{y}-{m:02d}")

    print(f"[fetch] DONE: {total:,} rows → {args.out}")
    if failures:
        print(f"[fetch] WARNING — {len(failures)} month(s) failed: {', '.join(failures)} (re-run for just those)")


if __name__ == "__main__":
    main()
