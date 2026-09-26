"""Build data.json for H-1B Higher or Lower from DOL LCA disclosure files.

Input:  prep/raw/LCA_Disclosure_Data_FY*.xlsx  (download manually from
        https://www.dol.gov/agencies/eta/foreign-labor/performance — the site
        blocks scripted downloads). Files are cumulative within a fiscal year,
        so use the latest quarter of each FY (e.g. FY2025_Q4 + FY2026_Q3).
Output: data.json at repo root.

Run: python3 prep/build_data.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "prep" / "raw"
OUT = ROOT / "data.json"

TARGET_ROWS = 500
MIN_N = 3
MAX_PER_EMPLOYER = 15
HUB_STATES = ["CA", "WA", "NY", "TX", "MA"]  # CA first; others only if CA is short

COLS = [
    "CASE_NUMBER", "CASE_STATUS", "VISA_CLASS", "JOB_TITLE", "SOC_CODE",
    "FULL_TIME_POSITION", "EMPLOYER_NAME", "WORKSITE_CITY", "WORKSITE_STATE",
    "WAGE_RATE_OF_PAY_FROM", "WAGE_UNIT_OF_PAY", "PW_WAGE_LEVEL",
]

# Data Scientists, Statisticians, Computer & Info Research Scientists, Ops Research
DATA_SOC = ("15-2051", "15-2041", "15-1221", "15-2031")
TITLE_RE = (
    r"data scien|data analy|data engineer|machine learning|\bml\b|analytics"
    r"|\bai\b|artificial intelligence|applied scien|research scien|statistic"
    r"|quantitative|business intelligence|decision scien"
)
EXCLUDE_RE = r"professor|postdoc|post-doc|intern\b|teaching|lecturer|faculty|student"

UNIT_FACTOR = {"Year": 1, "Month": 12, "Bi-Weekly": 26, "Week": 52, "Hour": 2080}

# Normalized-employer regex -> (display name, logo domain). Also the "famous" list.
BRANDS = [
    (r"^META PLATFORMS|^FACEBOOK", "Meta", "meta.com"),
    (r"^GOOGLE", "Google", "google.com"),
    (r"^APPLE\b", "Apple", "apple.com"),
    (r"^AMAZON", "Amazon", "amazon.com"),
    (r"^MICROSOFT", "Microsoft", "microsoft.com"),
    (r"^NETFLIX", "Netflix", "netflix.com"),
    (r"^NVIDIA", "Nvidia", "nvidia.com"),
    (r"^DOORDASH", "DoorDash", "doordash.com"),
    (r"^SNOWFLAKE", "Snowflake", "snowflake.com"),
    (r"^DATABRICKS", "Databricks", "databricks.com"),
    (r"^AIRBNB", "Airbnb", "airbnb.com"),
    (r"^UBER\b", "Uber", "uber.com"),
    (r"^LYFT", "Lyft", "lyft.com"),
    (r"^STRIPE", "Stripe", "stripe.com"),
    (r"^SALESFORCE", "Salesforce", "salesforce.com"),
    (r"^LINKEDIN", "LinkedIn", "linkedin.com"),
    (r"^PINTEREST", "Pinterest", "pinterest.com"),
    (r"^MAPLEBEAR|^INSTACART", "Instacart", "instacart.com"),
    (r"^OPENAI", "OpenAI", "openai.com"),
    (r"^ANTHROPIC", "Anthropic", "anthropic.com"),
    (r"^TESLA", "Tesla", "tesla.com"),
    (r"^ADOBE", "Adobe", "adobe.com"),
    (r"^INTUIT", "Intuit", "intuit.com"),
    (r"^PAYPAL", "PayPal", "paypal.com"),
    (r"^BLOCK\b|^SQUARE\b", "Block", "block.xyz"),
    (r"^COINBASE", "Coinbase", "coinbase.com"),
    (r"^ROBINHOOD", "Robinhood", "robinhood.com"),
    (r"^SNAP\b", "Snap", "snap.com"),
    (r"^X CORP|^TWITTER", "X", "x.com"),
    (r"^REDDIT", "Reddit", "reddit.com"),
    (r"^ROBLOX", "Roblox", "roblox.com"),
    (r"^WAYMO", "Waymo", "waymo.com"),
    (r"^CRUISE\b", "Cruise", "getcruise.com"),
    (r"^ORACLE", "Oracle", "oracle.com"),
    (r"^CISCO", "Cisco", "cisco.com"),
    (r"^INTEL\b", "Intel", "intel.com"),
    (r"^WALMART|^WAL MART", "Walmart", "walmart.com"),
    (r"^VISA\b", "Visa", "visa.com"),
    (r"^WORKDAY", "Workday", "workday.com"),
    (r"^SERVICENOW", "ServiceNow", "servicenow.com"),
    (r"^PALO ALTO NETWORKS", "Palo Alto Networks", "paloaltonetworks.com"),
    (r"^SCALE AI", "Scale AI", "scale.com"),
    (r"^PLAID\b", "Plaid", "plaid.com"),
    (r"^CHIME\b", "Chime", "chime.com"),
    (r"^AFFIRM", "Affirm", "affirm.com"),
    (r"^NOTION LABS", "Notion", "notion.so"),
    (r"^FIGMA", "Figma", "figma.com"),
    (r"^DROPBOX", "Dropbox", "dropbox.com"),
    (r"^ZOOM\b", "Zoom", "zoom.us"),
    (r"^WELLS FARGO", "Wells Fargo", "wellsfargo.com"),
    (r"^GENENTECH", "Genentech", "gene.com"),
    (r"^TIKTOK|^BYTEDANCE|^TT COMMERCE", "TikTok", "tiktok.com"),
    (r"^SPOTIFY", "Spotify", "spotify.com"),
    (r"^YAHOO", "Yahoo", "yahoo.com"),
    (r"^EBAY", "eBay", "ebay.com"),
    (r"^GAP\b", "Gap", "gap.com"),
    (r"^CAPITAL ONE", "Capital One", "capitalone.com"),
    (r"^JPMORGAN|^JP MORGAN", "JPMorgan", "jpmorganchase.com"),
    (r"^GOLDMAN SACHS", "Goldman Sachs", "goldmansachs.com"),
    (r"^DELOITTE", "Deloitte", "deloitte.com"),
]

SUFFIX_RE = r"\b(INC|INCORPORATED|LLC|L L C|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY|LP|LLP|PLC|USA|US|THE)\b"
ACRONYMS = {"Ml": "ML", "Ai": "AI", "Ii": "II", "Iii": "III", "Iv": "IV", "Bi": "BI",
            "Nlp": "NLP", "Ds": "DS", "Llm": "LLM", "Sr": "Sr.", "Us": "US", "Etl": "ETL"}


def read_raw() -> pd.DataFrame:
    files = sorted(RAW.glob("LCA_Disclosure_Data_FY*.xlsx"))
    if not files:
        raise SystemExit(f"No LCA xlsx files in {RAW}. Download them from dol.gov first.")
    frames = []
    for f in files:
        cache = f.with_suffix(".pkl")
        if cache.exists():
            df = pd.read_pickle(cache)
        else:
            print(f"reading {f.name} (slow the first time)...")
            try:
                df = pd.read_excel(f, usecols=COLS, engine="calamine")
            except ImportError:
                df = pd.read_excel(f, usecols=COLS)
            df = df.astype(str)
            df.to_pickle(cache)
        df["SOURCE"] = f.stem.replace("LCA_Disclosure_Data_", "")
        frames.append(df)
        print(f"  {f.name}: {len(df):,} rows")
    return pd.concat(frames, ignore_index=True)


def clean_employer(name: str) -> tuple[str, str | None, bool]:
    n = re.sub(r"[^A-Z0-9& ]", " ", str(name).upper())
    n = re.sub(SUFFIX_RE, " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    for pat, display, domain in BRANDS:
        if re.search(pat, n):
            return display, domain, True
    return n.title(), None, False


def clean_title(t: str) -> str:
    t = re.sub(r"\(.*?\)|\[.*?\]", " ", str(t))       # drop "(Req 1234)" etc.
    t = re.sub(r"\s*[-–,/|]\s*$", "", t)
    t = re.sub(r"\s+", " ", t).strip().title()
    t = re.sub(r"[A-Za-z]+", lambda m: ACRONYMS.get(m.group(), m.group()), t)  # AI/ML too
    return re.sub(r"(?<=\s)(Of|And|For|In|The|To)\b", lambda m: m.group().lower(), t)


def main():
    df = read_raw()
    funnel = [("raw rows", len(df))]

    df = df.drop_duplicates("CASE_NUMBER")
    funnel.append(("unique cases", len(df)))

    df = df[df.CASE_STATUS.str.strip() == "Certified"]
    funnel.append(("certified", len(df)))

    df = df[df.VISA_CLASS.str.contains("H-1B", na=False) & (df.FULL_TIME_POSITION == "Y")]
    funnel.append(("H-1B*, full-time", len(df)))

    title_l = df.JOB_TITLE.str.lower()
    is_data = df.SOC_CODE.str[:7].isin(DATA_SOC) | title_l.str.contains(TITLE_RE, regex=True)
    df = df[is_data & ~title_l.str.contains(EXCLUDE_RE, regex=True)]
    funnel.append(("data/ML/analytics role", len(df)))

    wage = pd.to_numeric(df.WAGE_RATE_OF_PAY_FROM.str.replace(r"[$,]", "", regex=True), errors="coerce")
    df = df.assign(salary=wage * df.WAGE_UNIT_OF_PAY.map(UNIT_FACTOR))
    df = df[df.salary.between(50_000, 1_000_000)]
    funnel.append(("annual wage $50k–$1M", len(df)))

    df = df[df.WORKSITE_STATE.isin(HUB_STATES)].copy()
    funnel.append((f"worksite in {'/'.join(HUB_STATES)}", len(df)))

    emp = df.EMPLOYER_NAME.map(clean_employer)
    df["company"] = emp.str[0]
    df["domain"] = emp.str[1]
    df["famous"] = emp.str[2]
    df["title"] = df.JOB_TITLE.map(clean_title)
    df["city"] = df.WORKSITE_CITY.str.strip().str.title()
    df["state"] = df.WORKSITE_STATE
    df["level"] = df.PW_WAGE_LEVEL.where(df.PW_WAGE_LEVEL.str.startswith("I"), None)

    con = duckdb.connect()
    con.register("lca", df[["company", "domain", "famous", "title", "city", "state", "level", "salary"]])
    agg = con.sql(f"""
        WITH g AS (
            SELECT company, any_value(domain) AS domain, bool_or(famous) AS famous,
                   title, city, state,
                   round(median(salary), -3)::INT AS salary,
                   count(*) AS n,
                   mode(level) AS level
            FROM lca GROUP BY company, title, city, state
            HAVING count(*) >= {MIN_N}
        ), e AS (
            SELECT company, count(*) AS emp_filings FROM lca GROUP BY company
        )
        SELECT g.*, e.emp_filings,
               row_number() OVER (PARTITION BY g.company ORDER BY g.n DESC) AS emp_rank
        FROM g JOIN e USING (company)
    """).df()
    funnel.append((f"(employer, title, city) groups n≥{MIN_N}", len(agg)))

    agg = agg[agg.emp_rank <= MAX_PER_EMPLOYER]
    agg["state_rank"] = agg.state.map({s: i for i, s in enumerate(HUB_STATES)})
    # CA first; within a state, famous brands first, then most-filing employers, then biggest groups.
    agg = agg.sort_values(["state_rank", "famous", "emp_filings", "n"],
                          ascending=[True, False, False, False])
    ca = agg[agg.state == "CA"]
    out = ca.head(TARGET_ROWS) if len(ca) >= TARGET_ROWS else agg.head(TARGET_ROWS)
    out = out.reset_index(drop=True)
    funnel.append(("selected", len(out)))

    records = [
        {"id": i, "company": r.company, "domain": r.domain, "title": r.title,
         "city": r.city, "state": r.state, "salary": int(r.salary), "n": int(r.n),
         "level": r.level, "famous": bool(r.famous)}
        for i, r in enumerate(out.itertuples())
    ]
    OUT.write_text(json.dumps(records, separators=(",", ":")))

    # ---- summary ----
    print("\nFunnel")
    for label, n in funnel:
        print(f"  {label:<40} {n:>10,}")
    print(f"\nWrote {OUT.name}: {len(records)} rows, {OUT.stat().st_size / 1024:.0f} KB")
    print(f"Sources: {sorted(df.SOURCE.unique())}")
    print(f"Famous-brand rows: {out.famous.sum()}  | companies: {out.company.nunique()}")
    print("\nSalary quantiles:")
    print(out.salary.quantile([0, .1, .25, .5, .75, .9, 1]).map("${:,.0f}".format).to_string())
    print("\nTop companies (rows, median of medians):")
    print(out.groupby("company").salary.agg(["count", "median"]).sort_values("count", ascending=False)
          .head(20).to_string())
    print("\nRows by state / top cities:")
    print(out.state.value_counts().to_string())
    print(out.city.value_counts().head(10).to_string())
    print("\nSample:")
    print(out.sample(10, random_state=1)[["company", "title", "city", "salary", "n", "level"]].to_string())


if __name__ == "__main__":
    main()
