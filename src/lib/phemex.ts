/**
 * Phemex public API client.
 *
 * Endpoints used:
 *  - GET /public/products  -> all listed products (used to enumerate USDS-M perps and Spot pairs)
 *  - GET /public/ticker/24hr/all?currency=<perp|spot|all> -> 24h ticker stats (volume, last price) for every symbol
 *  - GET /public/kline/list?symbol=<SYMBOL>&resolution=<SECONDS>&from=<UNIX>&to=<UNIX> -> OHLCV candles
 *
 * Notes:
 *  - USDⓈ-M perpetual contracts on Phemex are listed in `perpProductsV2` with `quoteCurrency` ∈ {USDT, USDC}.
 *  - Spot markets on Phemex live in `products` with `type === 'Spot'`. We focus on USDT-quoted pairs.
 *  - Phemex prices are returned as scaled integers ("Ep" suffix). The scale is given per-product via `priceScale`.
 */

const PHEMEX_API_BASE = "https://api.phemex.com";

const MIN_VOLUME_USD = 300_000;

/** One minute in seconds. */
const MIN = 60;

/** Phemex ticker field returned by /public/ticker/24hr/all. */
export interface PhemexTickerRaw {
  /** Scaled last price (priceEp). */
  lastPriceEp?: number;
  /** Last price as a string (some endpoints use this instead). */
  lastPrice?: string;
  /** Scaled 24h high. */
  highPriceEp?: number;
  /** Scaled 24h low. */
  lowPriceEp?: number;
  /** Scaled 24h open. */
  openPriceEp?: number;
  /** 24h trade volume in contracts/base (valueEv). */
  volumeEv?: number;
  /** 24h turnover in quote currency (valueEv scaled). */
  turnoverEv?: number;
  /** 24h volume as a string. */
  volume24h?: string;
  /** 24h turnover as a string (USD value for USDⓈ-M). */
  value24h?: string;
  /** Mark price (scaled). */
  markPriceEp?: number;
  /** Index price (scaled). */
  indexPriceEp?: number;
  /** 24h percentage change as a ratio scaled by 10^8 (e.g. 0.05 = 5% would be 5000000). */
  price24hChangePctEv?: number;
  /** Open interest (scaled). */
  openInterestEv?: number;
  /** Funding rate (scaled, 8h). */
  fundingRateEv?: number;
}

/** One row in a kline response. Phemex returns arrays of: [timestamp, interval, open, high, low, close, volume, turnover]. */
export type KlineRow = [
  number, // timestamp (seconds)
  number, // interval (seconds)
  number, // open (scaled)
  number, // close (scaled)
  number, // high (scaled)
  number, // low (scaled)
  number, // volume (base)
  number  // turnover (quote)
];

/** A simplified kline candle after parsing. */
export interface KlineCandle {
  /** Open time in seconds (Unix). */
  time: number;
  /** Open price (float). */
  open: number;
  /** Close price (float). */
  close: number;
  /** High price (float). */
  high: number;
  /** Low price (float). */
  low: number;
  /** Volume in base currency. */
  volume: number;
  /** Turnover in quote currency. */
  turnover: number;
}

/** USDⓈ-M perpetual product info from perpProductsV2. */
export interface PhemexPerpProduct {
  symbol: string;
  displaySymbol: string;
  quoteCurrency: string;
  settleCurrency: string;
  baseCurrency: string | null;
  priceScale: number;
  status: string;
  type: string;
  perpProductSubType?: string;
}

/** Spot product info from products array. */
export interface PhemexSpotProduct {
  symbol: string;
  displaySymbol: string;
  quoteCurrency: string;
  baseCurrency: string;
  priceScale: number;
  pricePrecision: number;
  status: string;
  type: string;
}

/** Normalized product record used downstream. */
export interface NormalizedProduct {
  /** Internal symbol (e.g. BTCUSDT for perp, sBTCUSDT for spot). */
  symbol: string;
  /** Display symbol (e.g. BTC/USDT). */
  displaySymbol: string;
  /** Quote currency (USDT/USDC/USD). */
  quoteCurrency: string;
  /** Base currency (BTC, ETH, ...). For perps may be null in raw data, we derive it. */
  baseCurrency: string;
  /** Decimal scale used to convert Ep values to float (10^priceScale). */
  priceScale: number;
  /** 'perp' or 'spot'. */
  marketType: "perp" | "spot";
}

/** One row of computed market-change data shown in the UI. */
export interface MarketChangeRow {
  symbol: string;
  displaySymbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  /** Latest price (float). */
  lastPrice: number;
  /** 24h USD turnover (used for the >300K filter and ranking tie-breaker). */
  volume24hUsd: number;
  /** 5-minute price change in percent. */
  change5m: number | null;
  /** 10-minute price change in percent. */
  change10m: number | null;
  /** 15-minute price change in percent. */
  change15m: number | null;
  /** 30-minute price change in percent. */
  change30m: number | null;
  /** Reference price 5 minutes ago (for tooltip). */
  price5mAgo: number | null;
  /** Reference price 10 minutes ago. */
  price10mAgo: number | null;
  /** Reference price 15 minutes ago. */
  price15mAgo: number | null;
  /** Reference price 30 minutes ago. */
  price30mAgo: number | null;
}

/** Result of fetching the entire snapshot for a market type. */
export interface MarketSnapshot {
  fetchedAt: number;
  /** Server time from Phemex response headers (ms). */
  serverTime: number;
  /** Source of data: 'live' (real Phemex API), 'mock' (synthetic fallback). */
  source: "live" | "mock";
  /** Optional warning message (e.g. when Phemex is unreachable from this region). */
  warning?: string;
  rows: MarketChangeRow[];
}

/* -------------------------------------------------------------------------- */
/*                              Fetching helpers                              */
/* -------------------------------------------------------------------------- */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    ...(opts.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, {
    ...opts,
    headers,
    // We want fresh market data, so disable upstream caching.
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { code: number; msg: string; data: unknown };
  if (json.code !== 0) {
    throw new Error(`Phemex API error code=${json.code} msg=${json.msg} for ${url}`);
  }
  return json.data as T;
}

/* -------------------------------------------------------------------------- */
/*                                Products API                                */
/* -------------------------------------------------------------------------- */

interface RawProductsResponse {
  currencies: unknown[];
  products: Array<Record<string, unknown>>;
  perpProductsV2: Array<Record<string, unknown>>;
}

interface RawKlineResponse {
  type: string;
  /** Symbol the kline was queried for. */
  symbol: string;
  /** Resolution in seconds. */
  resolution: string;
  /** Period start timestamp (seconds). */
  from: number;
  /** Period end timestamp (seconds). */
  to: number;
  /** Array of rows. */
  rows: KlineRow[] | null;
}

/** Cache products for 10 minutes — they change very rarely. */
let productsCache: { data: NormalizedProduct[]; ts: number } | null = null;
const PRODUCTS_TTL_MS = 10 * 60 * 1000;

/** Fetch and normalize all listed Phemex products (USDS-M perps + USDT-quoted spots). */
export async function fetchProducts(): Promise<NormalizedProduct[]> {
  if (productsCache && Date.now() - productsCache.ts < PRODUCTS_TTL_MS) {
    return productsCache.data;
  }

  const data = await fetchJson<RawProductsResponse>(`${PHEMEX_API_BASE}/public/products`);

  const out: NormalizedProduct[] = [];

  // USDⓈ-M perpetuals live in perpProductsV2 with quoteCurrency ∈ {USDT, USDC}.
  for (const p of data.perpProductsV2 ?? []) {
    if (p.status !== "Listed") continue;
    const quote = String(p.quoteCurrency ?? "");
    if (!["USDT", "USDC"].includes(quote)) continue;
    const symbol = String(p.symbol ?? "");
    if (!symbol) continue;
    const base =
      (p.baseCurrency as string | undefined) ??
      String(p.contractUnderlyingAssets ?? symbol.replace(/USDT$|USDC$/, ""));
    out.push({
      symbol,
      displaySymbol: String(p.displaySymbol ?? symbol),
      quoteCurrency: quote,
      baseCurrency: base,
      // Note: V2 products sometimes have priceScale=0 (means use pricePrecision). Use a sane default.
      priceScale: typeof p.priceScale === "number" && p.priceScale > 0 ? p.priceScale : 8,
      marketType: "perp",
    });
  }

  // Spot markets: products with type==='Spot' and quoteCurrency==='USDT' (USDⓈ-quoted spot).
  for (const p of data.products ?? []) {
    if (p.type !== "Spot") continue;
    if (p.status !== "Listed") continue;
    const quote = String(p.quoteCurrency ?? "");
    if (quote !== "USDT") continue;
    const symbol = String(p.symbol ?? "");
    if (!symbol) continue;
    out.push({
      symbol,
      displaySymbol: String(p.displaySymbol ?? symbol),
      quoteCurrency: quote,
      baseCurrency: String(p.baseCurrency ?? ""),
      priceScale: typeof p.priceScale === "number" && p.priceScale > 0 ? p.priceScale : 8,
      marketType: "spot",
    });
  }

  productsCache = { data: out, ts: Date.now() };
  return out;
}

/** Return only perp or spot products. */
export async function fetchProductsByType(type: "perp" | "spot"): Promise<NormalizedProduct[]> {
  const all = await fetchProducts();
  return all.filter((p) => p.marketType === type);
}

/* -------------------------------------------------------------------------- */
/*                              24h Tickers API                               */
/* -------------------------------------------------------------------------- */

interface RawTickerAllResponse {
  [symbol: string]: PhemexTickerRaw;
}

/** Cache tickers for 15 seconds — they change every tick but we don't need every tick. */
let tickersCache: { perp: RawTickerAllResponse; spot: RawTickerAllResponse; ts: number } | null =
  null;
const TICKERS_TTL_MS = 15_000;

async function fetchAllTickers(): Promise<{
  perp: RawTickerAllResponse;
  spot: RawTickerAllResponse;
}> {
  if (tickersCache && Date.now() - tickersCache.ts < TICKERS_TTL_MS) {
    return { perp: tickersCache.perp, spot: tickersCache.spot };
  }

  // Phemex /public/ticker/24hr/all returns ALL tickers regardless of currency param,
  // but we can request a specific subset with ?currency=perp or ?currency=spot.
  // We do both in parallel for speed.
  const [perpData, spotData] = await Promise.all([
    fetchJson<RawTickerAllResponse>(`${PHEMEX_API_BASE}/public/ticker/24hr/all?currency=perp`),
    fetchJson<RawTickerAllResponse>(`${PHEMEX_API_BASE}/public/ticker/24hr/all?currency=spot`),
  ]);

  tickersCache = { perp: perpData, spot: spotData, ts: Date.now() };
  return { perp: perpData, spot: spotData };
}

/* -------------------------------------------------------------------------- */
/*                                  Kline API                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fetch 1-minute klines for the last `minutes` minutes for a single symbol.
 * Returns candles sorted ascending by time.
 */
export async function fetchKline(symbol: string, minutes: number): Promise<KlineCandle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - minutes * MIN;
  // resolution=60 means 1-minute candles.
  const url = `${PHEMEX_API_BASE}/public/kline/list?symbol=${encodeURIComponent(
    symbol,
  )}&resolution=60&from=${from}&to=${to}`;

  const data = await fetchJson<RawKlineResponse>(url);
  const rows = data.rows ?? [];

  return rows.map((r) => ({
    time: r[0],
    open: r[2], // We'll scale later when we know priceScale.
    close: r[3],
    high: r[4],
    low: r[5],
    volume: r[6],
    turnover: r[7],
  }));
}

/* -------------------------------------------------------------------------- */
/*                            Price-change logic                              */
/* -------------------------------------------------------------------------- */

/** Convert a scaled integer Ep value to a float using priceScale (10^scale). */
function unscale(ep: number | undefined, scale: number): number | null {
  if (ep === undefined || ep === null || Number.isNaN(ep)) return null;
  return ep / Math.pow(10, scale);
}

/** Find the candle whose open time is closest to (but not after) `targetTime`. */
function candleAtTime(candles: KlineCandle[], targetTime: number): KlineCandle | null {
  if (candles.length === 0) return null;
  // Candles are sorted ascending by time. Find the last candle with time <= targetTime.
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= targetTime) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return null;
  return candles[ans];
}

/** Compute percent change between two prices. Returns null if either is null/zero. */
function pctChange(current: number | null, past: number | null): number | null {
  if (current === null || past === null) return null;
  if (past === 0) return null;
  return ((current - past) / past) * 100;
}

/**
 * Compute one MarketChangeRow by combining ticker + 30-minute kline history.
 *
 * Strategy:
 *  - `lastPrice` = ticker.lastPriceEp (unscaled).
 *  - For each window (5m, 10m, 15m, 30m): find the candle that opened at `now - window`.
 *    Use that candle's CLOSE price as the historical reference. This is the most
 *    recent trade price observed at that point in time.
 *  - pct = (lastPrice - refPrice) / refPrice * 100.
 */
export function buildMarketChangeRow(
  product: NormalizedProduct,
  ticker: PhemexTickerRaw,
  kline: KlineCandle[],
): MarketChangeRow {
  const scale = product.priceScale;
  const lastPrice =
    unscale(ticker.lastPriceEp, scale) ??
    (ticker.lastPrice ? parseFloat(ticker.lastPrice) : null) ??
    null;

  // Volume: prefer value24h (turnover in USD), fall back to turnoverEv scaled.
  const volume24hUsd =
    ticker.value24h !== undefined
      ? parseFloat(ticker.value24h)
      : ticker.turnoverEv !== undefined
        ? ticker.turnoverEv / Math.pow(10, 8) // turnover is in quote currency scaled by 10^8
        : 0;

  const nowSec = Math.floor(Date.now() / 1000);

  const candle5m = candleAtTime(kline, nowSec - 5 * MIN);
  const candle10m = candleAtTime(kline, nowSec - 10 * MIN);
  const candle15m = candleAtTime(kline, nowSec - 15 * MIN);
  const candle30m = candleAtTime(kline, nowSec - 30 * MIN);

  const scaleKlinePrice = (p: number) => p / Math.pow(10, scale);
  const price5mAgo = candle5m ? scaleKlinePrice(candle5m.close) : null;
  const price10mAgo = candle10m ? scaleKlinePrice(candle10m.close) : null;
  const price15mAgo = candle15m ? scaleKlinePrice(candle15m.close) : null;
  const price30mAgo = candle30m ? scaleKlinePrice(candle30m.close) : null;

  return {
    symbol: product.symbol,
    displaySymbol: product.displaySymbol,
    baseCurrency: product.baseCurrency,
    quoteCurrency: product.quoteCurrency,
    lastPrice: lastPrice ?? 0,
    volume24hUsd,
    change5m: pctChange(lastPrice, price5mAgo),
    change10m: pctChange(lastPrice, price10mAgo),
    change15m: pctChange(lastPrice, price15mAgo),
    change30m: pctChange(lastPrice, price30mAgo),
    price5mAgo,
    price10mAgo,
    price15mAgo,
    price30mAgo,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Combined snapshot endpoint                         */
/* -------------------------------------------------------------------------- */

/** Run kline fetches with bounded concurrency to avoid hammering Phemex. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: Error }> = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      try {
        const v = await fn(items[cur]);
        results[cur] = { ok: true, value: v };
      } catch (e) {
        results[cur] = { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Build the full snapshot for a market type.
 *
 * Flow:
 *  1. Fetch products (filtered to perp/spot).
 *  2. Fetch 24h tickers for all symbols.
 *  3. Filter to symbols with 24h USD volume > $300,000.
 *  4. For each qualifying symbol, fetch 30-minute kline history (1-minute candles).
 *  5. Compute price changes for 5m/10m/15m/30m windows.
 *
 * On any error, we fall back to a synthetic mock snapshot so the UI remains usable
 * for demonstration. The `source` field tells the caller whether data is live.
 */
export async function fetchMarketSnapshot(type: "perp" | "spot"): Promise<MarketSnapshot> {
  try {
    const products = await fetchProductsByType(type);
    const tickers = await fetchAllTickers();
    const tickerMap = type === "perp" ? tickers.perp : tickers.spot;

    // Pair each product with its ticker, and filter by 24h USD volume > $300K.
    const eligible = products
      .map((p) => ({ product: p, ticker: tickerMap[p.symbol] }))
      .filter(
        (x): x is { product: NormalizedProduct; ticker: PhemexTickerRaw } =>
          !!x.ticker,
      )
      .filter((x) => {
        const v =
          x.ticker.value24h !== undefined
            ? parseFloat(x.ticker.value24h)
            : x.ticker.turnoverEv !== undefined
              ? x.ticker.turnoverEv / Math.pow(10, 8)
              : 0;
        return v > MIN_VOLUME_USD;
      });

    if (eligible.length === 0) {
      // Either no products qualify or the ticker endpoint returned nothing.
      // Fall back to mock so the UI is still demonstrable.
      throw new Error(
        `No eligible ${type} pairs returned from Phemex (rate-limited or blocked).`,
      );
    }

    // Fetch klines for all eligible pairs in parallel (bounded concurrency).
    const klineResults = await mapWithConcurrency(eligible, 8, async (x) => {
      const kline = await fetchKline(x.product.symbol, 30);
      return { product: x.product, ticker: x.ticker, kline };
    });

    const rows: MarketChangeRow[] = [];
    for (const r of klineResults) {
      if (!r.ok) continue;
      rows.push(buildMarketChangeRow(r.value.product, r.value.ticker, r.value.kline));
    }

    if (rows.length === 0) {
      throw new Error("All kline fetches failed.");
    }

    return {
      fetchedAt: Date.now(),
      serverTime: Date.now(),
      source: "live",
      rows,
    };
  } catch (err) {
    // Fallback: produce a mock snapshot so the UI is still demonstrable.
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Trim verbose HTTP error details — keep just enough to diagnose.
    const shortMsg = rawMsg.split(":").slice(0, 2).join(":").slice(0, 180);
    return {
      fetchedAt: Date.now(),
      serverTime: Date.now(),
      source: "mock",
      warning: `Live Phemex API unreachable from this server (${shortMsg}). Showing simulated market data so the UI stays usable. Deploy in an environment with direct Phemex API access for real data.`,
      rows: mockSnapshot(type),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Mock data (dev)                               */
/* -------------------------------------------------------------------------- */

/**
 * Generate a realistic-looking mock snapshot for development / when Phemex API
 * is unreachable. Prices drift over time so the change percentages vary visibly.
 */
function mockSnapshot(type: "perp" | "spot"): MarketChangeRow[] {
  const universe =
    type === "perp"
      ? [
          ["BTC", "Bitcoin"],
          ["ETH", "Ethereum"],
          ["SOL", "Solana"],
          ["XRP", "XRP"],
          ["BNB", "BNB"],
          ["DOGE", "Dogecoin"],
          ["ADA", "Cardano"],
          ["AVAX", "Avalanche"],
          ["LINK", "Chainlink"],
          ["DOT", "Polkadot"],
          ["MATIC", "Polygon"],
          ["LTC", "Litecoin"],
          ["ATOM", "Cosmos"],
          ["UNI", "Uniswap"],
          ["NEAR", "Near"],
          ["APT", "Aptos"],
          ["ARB", "Arbitrum"],
          ["OP", "Optimism"],
          ["INJ", "Injective"],
          ["SUI", "Sui"],
          ["TIA", "Celestia"],
          ["SEI", "Sei"],
          ["RUNE", "THORChain"],
          ["FIL", "Filecoin"],
          ["FTM", "Fantom"],
          ["AAVE", "Aave"],
          ["GRT", "The Graph"],
          ["ALGO", "Algorand"],
          ["SAND", "The Sandbox"],
          ["MANA", "Decentraland"],
        ]
      : [
          ["BTC", "Bitcoin"],
          ["ETH", "Ethereum"],
          ["SOL", "Solana"],
          ["XRP", "XRP"],
          ["DOGE", "Dogecoin"],
          ["ADA", "Cardano"],
          ["AVAX", "Avalanche"],
          ["LINK", "Chainlink"],
          ["DOT", "Polkadot"],
          ["MATIC", "Polygon"],
          ["LTC", "Litecoin"],
          ["BNB", "BNB"],
          ["ATOM", "Cosmos"],
          ["UNI", "Uniswap"],
          ["NEAR", "Near"],
          ["APT", "Aptos"],
          ["ARB", "Arbitrum"],
          ["OP", "Optimism"],
          ["INJ", "Injective"],
          ["SUI", "Sui"],
          ["TIA", "Celestia"],
          ["SEI", "Sei"],
          ["RUNE", "THORChain"],
          ["FIL", "Filecoin"],
          ["FTM", "Fantom"],
        ];

  // Deterministic per-symbol base price (so reloads look plausible but differ between symbols).
  const basePrices: Record<string, number> = {
    BTC: 64000,
    ETH: 3400,
    SOL: 145,
    XRP: 0.52,
    BNB: 580,
    DOGE: 0.13,
    ADA: 0.42,
    AVAX: 28,
    LINK: 14,
    DOT: 6.5,
    MATIC: 0.58,
    LTC: 72,
    ATOM: 8.2,
    UNI: 9.4,
    NEAR: 5.1,
    APT: 8.8,
    ARB: 0.92,
    OP: 1.6,
    INJ: 22,
    SUI: 1.05,
    TIA: 7.3,
    SEI: 0.42,
    RUNE: 4.5,
    FIL: 4.2,
    FTM: 0.65,
    AAVE: 95,
    GRT: 0.18,
    ALGO: 0.16,
    SAND: 0.41,
    MANA: 0.39,
  };

  // Use a per-minute seed so successive refreshes show plausible drift.
  const minuteSeed = Math.floor(Date.now() / 60_000);

  return universe.map(([sym], i) => {
    // Generate a pseudo-random percentage drift using symbol + minuteSeed.
    const seed = (minuteSeed + sym.charCodeAt(0) * 31 + i * 7) % 1000;
    const rnd = (offset: number) => {
      const x = Math.sin(seed * 9301 + offset * 49297) * 233280;
      return x - Math.floor(x); // 0..1
    };

    const base = basePrices[sym] ?? 1;
    const drift5m = (rnd(1) - 0.5) * 2.5; // ±1.25%
    const drift10m = drift5m + (rnd(2) - 0.5) * 3.5;
    const drift15m = drift10m + (rnd(3) - 0.5) * 4;
    const drift30m = drift15m + (rnd(4) - 0.5) * 6;

    const lastPrice = base * (1 + drift30m / 100);
    const price5mAgo = (lastPrice / (1 + drift5m / 100));
    const price10mAgo = (lastPrice / (1 + drift10m / 100));
    const price15mAgo = (lastPrice / (1 + drift15m / 100));
    const price30mAgo = (lastPrice / (1 + drift30m / 100));

    // Volume: random between $400K and $500M, scaled by symbol rank.
    const volume24hUsd = (400_000 + rnd(5) * 500_000_000) * (1 + i / 30);

    return {
      symbol: type === "perp" ? `${sym}USDT` : `s${sym}USDT`,
      displaySymbol: `${sym} / USDT`,
      baseCurrency: sym,
      quoteCurrency: "USDT",
      lastPrice,
      volume24hUsd,
      change5m: drift5m,
      change10m: drift10m,
      change15m: drift15m,
      change30m: drift30m,
      price5mAgo,
      price10mAgo,
      price15mAgo,
      price30mAgo,
    } satisfies MarketChangeRow;
  });
}
