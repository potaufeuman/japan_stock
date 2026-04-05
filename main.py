from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import yfinance as yf
import pandas as pd
import time
import asyncio
import concurrent.futures
from prime_stocks import PRIME_STOCKS

app = FastAPI(title="Japan Stock Analyzer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")

# 主要指数
INDICES = {
    "^N225": "日経225",
    "1306.T": "TOPIX ETF",
}

# 主要セクターETF（東証）
SECTOR_ETFS = {
    "1615.T": "銀行",
    "1617.T": "食品",
    "1618.T": "エネルギー資源",
    "1619.T": "建設・資材",
    "1620.T": "素材・化学",
    "1621.T": "医薬品",
    "1622.T": "自動車・輸送機",
    "1623.T": "鉄鋼・非鉄",
    "1624.T": "機械",
    "1625.T": "電機・精密",
    "1626.T": "情報通信・サービス",
    "1627.T": "電力・ガス",
    "1628.T": "運輸・物流",
    "1629.T": "商社・卸売",
    "1630.T": "小売",
    "1631.T": "不動産",
}

# プライム市場銘柄リスト（prime_stocks.py から読み込み）
WATCHLIST = PRIME_STOCKS
# 重複キーを除去
WATCHLIST = dict(WATCHLIST)

executor = concurrent.futures.ThreadPoolExecutor(max_workers=16)

# ---- Per-symbol TTL cache ----
# 成功: 10分 / 上場廃止: 60分 / レートリミット: 30秒（すぐ再試行できる）
_cache: dict = {}
CACHE_TTL_OK        = 600    # 10分
CACHE_TTL_DELISTED  = 3600   # 60分
CACHE_TTL_RATELIMIT = 30     # 30秒

_FAIL_DELISTED   = "__DELISTED__"    # 上場廃止・データなし
_FAIL_RATELIMIT  = "__RATELIMIT__"   # レートリミット（短期スキップ）

def _cache_get(sym: str):
    entry = _cache.get(sym)
    if not entry:
        return None
    data, ts = entry
    if data == _FAIL_DELISTED:
        ttl = CACHE_TTL_DELISTED
    elif data == _FAIL_RATELIMIT:
        ttl = CACHE_TTL_RATELIMIT
    else:
        ttl = CACHE_TTL_OK
    return data if time.time() - ts < ttl else None

def _cache_set(sym: str, data):
    _cache[sym] = (data, time.time())


def _calc_metrics(symbol: str, hist: pd.DataFrame, info: dict) -> dict | None:
    """価格履歴 DataFrame とファンダメンタル dict からメトリクスを計算して返す"""
    try:
        hist = hist.dropna(subset=["Close"])
        if len(hist) < 2:
            return None

        current_price = float(hist["Close"].iloc[-1])
        prev_price    = float(hist["Close"].iloc[-2])
        change_pct    = (current_price - prev_price) / prev_price * 100
        high_52w      = float(hist["High"].max())
        low_52w       = float(hist["Low"].min())

        vol_series = hist["Volume"].replace(0, float("nan"))
        vol_ma20   = vol_series.rolling(20).mean().iloc[-1]
        vol_current = vol_series.iloc[-1]
        vol_ratio  = float(vol_current / vol_ma20) if (pd.notna(vol_ma20) and vol_ma20 > 0) else 1.0

        price_1m_ago = float(hist["Close"].iloc[-22]) if len(hist) >= 22 else float(hist["Close"].iloc[0])
        momentum_1m  = (current_price - price_1m_ago) / price_1m_ago * 100

        delta = hist["Close"].diff()
        gain  = delta.clip(lower=0).rolling(14).mean()
        loss  = (-delta.clip(upper=0)).rolling(14).mean()
        rs    = gain / loss.replace(0, float("nan"))
        rsi_s = 100 - (100 / (1 + rs))
        rsi   = float(rsi_s.iloc[-1]) if pd.notna(rsi_s.iloc[-1]) else 50.0

        per   = info.get("trailingPE") or info.get("forwardPE")
        pbr   = info.get("priceToBook")
        raw_y = info.get("trailingAnnualDividendYield")
        div_yield = round(float(raw_y) * 100, 2) if raw_y else None
        market_cap = info.get("marketCap")
        name  = WATCHLIST.get(symbol, info.get("longName", symbol))

        score, reasons = 0, []
        if per and per > 0:
            if per < 12:   score += 25; reasons.append(f"PER {per:.1f}倍（割安）")
            elif per < 18: score += 15; reasons.append(f"PER {per:.1f}倍（適正）")
            else:          score += 5;  reasons.append(f"PER {per:.1f}倍（割高）")
        if pbr and pbr > 0:
            if pbr < 1.0:   score += 25; reasons.append(f"PBR {pbr:.2f}倍（資産割安）")
            elif pbr < 1.5: score += 15; reasons.append(f"PBR {pbr:.2f}倍（適正）")
            else:           score += 5;  reasons.append(f"PBR {pbr:.2f}倍（割高）")
        if vol_ratio > 1.5:   score += 20; reasons.append(f"出来高{vol_ratio:.1f}倍（資金流入）")
        elif vol_ratio > 1.2: score += 10; reasons.append(f"出来高{vol_ratio:.1f}倍（やや流入）")
        if 0 < momentum_1m < 15:  score += 15; reasons.append(f"1M騰落率 +{momentum_1m:.1f}%（上昇トレンド）")
        elif momentum_1m >= 15:   score += 5;  reasons.append(f"1M騰落率 +{momentum_1m:.1f}%（過熱注意）")
        elif momentum_1m < -10:   score += 10; reasons.append(f"1M騰落率 {momentum_1m:.1f}%（反発狙い）")
        if 30 <= rsi <= 50:  score += 15; reasons.append(f"RSI {rsi:.0f}（売られすぎから回復）")
        elif 50 < rsi <= 70: score += 10; reasons.append(f"RSI {rsi:.0f}（強気）")
        elif rsi < 30:       score += 5;  reasons.append(f"RSI {rsi:.0f}（売られすぎ警戒）")
        if current_price < high_52w * 0.8:
            score += 10; reasons.append(f"52週高値から{((high_52w-current_price)/high_52w*100):.0f}%下（割安感）")
        if div_yield and div_yield > 3.0:
            score += 10; reasons.append(f"配当利回り {div_yield:.1f}%（高配当）")

        eps = (current_price / float(per)) if (per and per > 0) else None
        price_history = []
        for d, r in hist.tail(126).iterrows():
            cv = float(r["Close"]); vv = int(r["Volume"]) if pd.notna(r["Volume"]) else 0
            price_history.append({
                "date": d.strftime("%Y-%m-%d"),
                "close": round(cv, 2),
                "volume": vv,
                "trading_value": round(cv * vv / 1e8, 2),
                "est_per": round(cv / eps, 1) if eps else None,
            })

        return {
            "symbol": symbol, "name": name,
            "price": round(current_price, 2), "change_pct": round(change_pct, 2),
            "per": round(float(per), 1) if per else None,
            "pbr": round(float(pbr), 2) if pbr else None,
            "div_yield": div_yield,
            "vol_ratio": round(vol_ratio, 2), "momentum_1m": round(momentum_1m, 2),
            "rsi": round(rsi, 1), "high_52w": round(high_52w, 2), "low_52w": round(low_52w, 2),
            "market_cap": market_cap, "score": min(score, 100),
            "reasons": reasons, "price_history": price_history,
        }
    except Exception as e:
        print(f"_calc_metrics {symbol}: {e}")
        return None


def _fetch_info_one(symbol: str) -> tuple[str, dict, str | None]:
    """
    ファンダメンタル取得。
    戻り値: (symbol, info_dict, error_type)
      error_type: None=成功 / "ratelimit" / "notfound"
    レートリミット時は1回だけ2秒待ってリトライする。
    """
    for attempt in range(2):
        try:
            info = yf.Ticker(symbol).info
            # info が空または currentPrice なしは実質データなし
            if not info or "currentPrice" not in info and "regularMarketPrice" not in info and "previousClose" not in info:
                return symbol, {}, "notfound"
            return symbol, info, None
        except Exception as e:
            ename = type(e).__name__
            if "RateLimit" in ename or "TooMany" in str(e) or "429" in str(e):
                if attempt == 0:
                    time.sleep(2)   # 1回だけ待ってリトライ
                    continue
                return symbol, {}, "ratelimit"
            return symbol, {}, "notfound"
    return symbol, {}, "ratelimit"


def _extract_hist(raw: pd.DataFrame, sym: str) -> pd.DataFrame:
    """bulk download の結果から1銘柄の OHLCV を取り出す"""
    if raw.empty:
        return pd.DataFrame()
    is_multi = isinstance(raw.columns, pd.MultiIndex)
    if not is_multi:
        return raw.copy()
    top = raw.columns.get_level_values(0).unique().tolist()
    if "Close" in top:                         # (field, ticker)
        frames = {f: raw[f][sym] for f in ["Open","High","Low","Close","Volume"]
                  if f in raw.columns.get_level_values(0) and sym in raw[f].columns}
        return pd.DataFrame(frames) if frames else pd.DataFrame()
    else:                                       # (ticker, field)
        return raw[sym].copy() if sym in raw.columns.get_level_values(0) else pd.DataFrame()


def bulk_fetch_stocks(symbols: list[str]) -> tuple[list[dict], list[str], list[str]]:
    """
    戻り値: (stocks, skipped_ratelimit, skipped_notfound)
    """
    results_map: dict[str, dict] = {}
    skipped_rl: list[str] = []
    skipped_nf: list[str] = []
    to_fetch: list[str] = []

    for sym in symbols:
        cached = _cache_get(sym)
        if cached is None:
            to_fetch.append(sym)
        elif cached in (_FAIL_DELISTED, _FAIL_RATELIMIT):
            if cached == _FAIL_RATELIMIT:
                skipped_rl.append(sym)
            else:
                skipped_nf.append(sym)
        else:
            results_map[sym] = cached

    if to_fetch:
        # ── OHLCV 一括取得 ──
        try:
            raw = yf.download(
                to_fetch, period="1y", auto_adjust=False,
                progress=False, threads=True,
            )
        except Exception as e:
            print(f"bulk download error: {e}")
            raw = pd.DataFrame()

        # ── ファンダメンタル: 並列3本に制限してレートリミットを回避 ──
        info_map:      dict[str, dict] = {}
        err_ratelimit: set[str]        = set()
        err_notfound:  set[str]        = set()

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futs = {pool.submit(_fetch_info_one, sym): sym for sym in to_fetch}
            for fut in concurrent.futures.as_completed(futs, timeout=60):
                try:
                    sym, info, etype = fut.result(timeout=10)
                    if etype == "ratelimit":
                        err_ratelimit.add(sym)
                    elif etype == "notfound":
                        err_notfound.add(sym)
                    else:
                        info_map[sym] = info
                except Exception as e:
                    sym = futs[fut]
                    print(f"info future {sym}: {e}")
                    err_ratelimit.add(sym)

        # ── 銘柄ごとにメトリクス計算 ──
        for sym in to_fetch:
            if sym in err_ratelimit:
                _cache_set(sym, _FAIL_RATELIMIT)
                skipped_rl.append(sym)
                continue
            try:
                hist = _extract_hist(raw, sym)
                result = _calc_metrics(sym, hist, info_map.get(sym, {}))
                if result:
                    _cache_set(sym, result)
                    results_map[sym] = result
                else:
                    _cache_set(sym, _FAIL_DELISTED)
                    skipped_nf.append(sym)
            except Exception as e:
                print(f"process {sym}: {e}")
                _cache_set(sym, _FAIL_DELISTED)
                skipped_nf.append(sym)

    stocks = [results_map[s] for s in symbols if s in results_map]
    return stocks, skipped_rl, skipped_nf


def fetch_ticker_info(symbol: str) -> dict | None:
    """単一銘柄の詳細取得（キャッシュ優先）"""
    cached = _cache_get(symbol)
    if cached and cached not in (_FAIL_DELISTED, _FAIL_RATELIMIT):
        return cached
    stocks, _, _ = bulk_fetch_stocks([symbol])
    return stocks[0] if stocks else None


def fetch_index_data(symbol: str) -> dict:
    try:
        t = yf.Ticker(symbol)
        hist = t.history(period="6mo", auto_adjust=False)
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            return None

        current = hist["Close"].iloc[-1]
        prev = hist["Close"].iloc[-2] if len(hist) > 1 else current
        change_pct = (current - prev) / prev * 100

        # 資金流入判定（出来高トレンド）
        vol_ma5 = hist["Volume"].rolling(5).mean().iloc[-1]
        vol_ma20 = hist["Volume"].rolling(20).mean().iloc[-1]
        money_flow = "流入" if vol_ma5 > vol_ma20 * 1.1 else ("流出" if vol_ma5 < vol_ma20 * 0.9 else "中立")

        # 移動平均
        ma25 = hist["Close"].rolling(25).mean().iloc[-1]
        ma75 = hist["Close"].rolling(75).mean().iloc[-1]

        price_history = []
        for date, row in hist.iterrows():
            price_history.append({
                "date": date.strftime("%Y-%m-%d"),
                "close": round(float(row["Close"]), 2),
                "volume": int(row["Volume"]),
            })

        return {
            "symbol": symbol,
            "name": INDICES.get(symbol, symbol),
            "price": round(float(current), 2),
            "change_pct": round(float(change_pct), 2),
            "ma25": round(float(ma25), 2) if not pd.isna(ma25) else None,
            "ma75": round(float(ma75), 2) if not pd.isna(ma75) else None,
            "money_flow": money_flow,
            "price_history": price_history,
        }
    except Exception as e:
        print(f"Error fetching index {symbol}: {e}")
        return None


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/api/market")
async def get_market():
    loop = asyncio.get_event_loop()
    results = await asyncio.gather(
        loop.run_in_executor(executor, fetch_index_data, "^N225"),
        loop.run_in_executor(executor, fetch_index_data, "1306.T"),
    )
    return {"indices": [r for r in results if r]}


@app.get("/api/sectors")
async def get_sectors():
    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(executor, fetch_sector_data, sym, name)
        for sym, name in SECTOR_ETFS.items()
    ]
    results = await asyncio.gather(*tasks)
    data = [r for r in results if r]
    data.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"sectors": data}


def fetch_sector_data(symbol: str, name: str) -> dict:
    try:
        t = yf.Ticker(symbol)
        hist = t.history(period="1mo", auto_adjust=False)
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            return None
        current = hist["Close"].iloc[-1]
        prev = hist["Close"].iloc[-2] if len(hist) > 1 else current
        change_pct = (current - prev) / prev * 100
        vol_ma5 = hist["Volume"].rolling(5).mean().iloc[-1] if len(hist) >= 5 else hist["Volume"].mean()
        vol_ma20 = hist["Volume"].rolling(20).mean().iloc[-1] if len(hist) >= 20 else hist["Volume"].mean()
        inflow = vol_ma5 / vol_ma20 if vol_ma20 > 0 else 1.0
        return {
            "symbol": symbol,
            "name": name,
            "price": round(float(current), 2),
            "change_pct": round(float(change_pct), 2),
            "inflow_ratio": round(float(inflow), 2),
        }
    except Exception as e:
        print(f"Error {symbol}: {e}")
        return None


@app.get("/api/stocks")
async def get_stocks(
    sort_by: str = "score",
    page: int = Query(0, ge=0),
    page_size: int = Query(50, ge=1, le=100),
    search: str = "",
):
    symbols = list(WATCHLIST.keys())
    if search:
        q = search.upper().replace(".T", "")
        symbols = [s for s in symbols if q in s.replace(".T", "") or q in WATCHLIST[s]]

    total = len(symbols)
    page_symbols = symbols[page * page_size: (page + 1) * page_size]

    loop = asyncio.get_event_loop()
    stocks, skipped_rl, skipped_nf = await loop.run_in_executor(
        executor, bulk_fetch_stocks, page_symbols
    )

    key = {"score": lambda x: -x["score"], "change_pct": lambda x: -x["change_pct"],
           "vol_ratio": lambda x: -x["vol_ratio"],
           "per": lambda x: (x["per"] is None, x["per"] or 999),
           "pbr": lambda x: (x["pbr"] is None, x["pbr"] or 999)}.get(sort_by)
    if key:
        stocks.sort(key=key)

    # スキップ銘柄に銘柄名を付けて返す
    def label(sym): return f"{sym.replace('.T','')} {WATCHLIST.get(sym, sym)}"

    return {
        "stocks": stocks, "total": total, "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size,
        "cached": sum(1 for s in page_symbols if _cache_get(s) not in (None, _FAIL_RATELIMIT, _FAIL_DELISTED)),
        "skipped_ratelimit": [label(s) for s in skipped_rl],
        "skipped_notfound":  [label(s) for s in skipped_nf],
    }


@app.get("/api/cache/clear")
async def clear_cache():
    _cache.clear()
    return {"message": "キャッシュをクリアしました"}


@app.get("/api/search")
async def search_stocks(q: str = ""):
    """証券コードまたは銘柄名の部分一致で候補を返す（詳細画面の検索用）"""
    if not q or len(q) < 1:
        return {"results": []}
    query = q.upper().replace(".T", "")
    results = []
    for sym, name in WATCHLIST.items():
        code = sym.replace(".T", "")
        if query in code or query in name:
            results.append({"symbol": sym, "code": code, "name": name})
        if len(results) >= 20:
            break
    return {"results": results}


@app.get("/api/stock/{symbol}")
async def get_stock(symbol: str):
    # 数字コードならそのまま .T を付加、それ以外は銘柄名検索も試みる
    clean = symbol.strip().upper()
    if not clean.endswith(".T") and not clean.startswith("^"):
        clean = clean + ".T"

    # WATCHLIST にない場合、銘柄名で検索して最初のヒットを使う
    if clean not in WATCHLIST:
        query = symbol.strip().upper().replace(".T", "")
        for sym, name in WATCHLIST.items():
            if query in sym.replace(".T", "") or query in name.upper():
                clean = sym
                break

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(executor, fetch_ticker_info, clean)
    if not result:
        raise HTTPException(status_code=404, detail="Stock not found")
    return result
