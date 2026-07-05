import { NextRequest, NextResponse } from "next/server";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProductInfo {
  symbol: string;
  displayCurrency: string;
  baseCurrency: string;
  quoteCurrency: string;
  priceScale: number;
  ratioScale: number;
  type: string;
  status: string;
}

interface TickerRow {
  symbol: string;
  displaySymbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  lastPrice: number;
  volume24hUsd: number;
  change5m: number;
  change10m: number;
  change15m: number;
  change30m: number;
  price5mAgo: number;
  price10mAgo: number;
  price15mAgo: number;
  price30mAgo: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PHEMEX_BASE = "https://api.phemex.com";
const MIN_VOLUME_USD = 300_000;
const TOP_N_PERP = 30;
const TOP_N_SPOT = 25;
const REQUEST_TIMEOUT_MS = 10_000;
const KLINE_BATCH_SIZE = 6; // conservative to avoid rate limits

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function phemexFetch(url: string, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    return res;
  } catch (err) {
    throw new Error(
      `${label} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

function scaleValue(raw: number | string | undefined, scale: number): number {
  if (raw == null) return 0;
  const v = typeof raw === "string" ? parseFloat(raw) : raw;
  return v / Math.pow(10, scale);
}

// ─── Products ────────────────────────────────────────────────────────────────

async function fetchProducts(): Promise<Map<string, ProductInfo>> {
  const res = await phemexFetch(
    `${PHEMEX_BASE}/public/products`,
    "Products"
  );
  if (!res.ok) throw new Error(`Products HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`Products code=${json.code}`);

  const map = new Map<string, ProductInfo>();
  for (const p of json.data.products as Record<string, any>[]) {
    map.set(p.symbol, {
      symbol: p.symbol,
      displayCurrency: p.displayCurrency || p.baseCurrency || p.currency || "",
      baseCurrency: p.baseCurrency || p.currency || "",
      quoteCurrency: p.quoteCurrency || "USD",
      priceScale: p.priceScale ?? 8,
      ratioScale: p.ratioScale ?? 8,
      type: p.type || "",
      status: p.status || "",
    });
  }
  return map;
}

// ─── Spot Tickers ────────────────────────────────────────────────────────────

async function fetchSpotTickers(
  productMap: Map<string, ProductInfo>
): Promise<TickerRow[]> {
  const res = await phemexFetch(
    `${PHEMEX_BASE}/md/spot/ticker/24hr/all`,
    "Spot tickers"
  );
  if (!res.ok) throw new Error(`Spot tickers HTTP ${res.status}`);
  const json = await res.json();
  if (json.error !== null) throw new Error(`Spot tickers error: ${json.error}`);

  const rows: TickerRow[] = [];
  for (const t of json.result as Record<string, any>[]) {
    const prod = productMap.get(t.symbol);
    if (!prod || prod.type !== "Spot") continue;

    const ps = prod.priceScale;
    const lastPrice = scaleValue(t.lastEp, ps);
    const turnoverUsd = scaleValue(t.turnoverEv, ps);

    if (turnoverUsd < MIN_VOLUME_USD) continue;

    rows.push({
      symbol: t.symbol,
      displaySymbol: prod.displaySymbol || `${prod.baseCurrency} / ${prod.quoteCurrency}`,
      baseCurrency: prod.baseCurrency,
      quoteCurrency: prod.quoteCurrency,
      lastPrice,
      volume24hUsd: turnoverUsd,
      change5m: 0, change10m: 0, change15m: 0, change30m: 0,
      price5mAgo: 0, price10mAgo: 0, price15mAgo: 0, price30mAgo: 0,
    });
  }
  return rows;
}

// ─── Perp Tickers ────────────────────────────────────────────────────────────

async function fetchPerpTickers(
  productMap: Map<string, ProductInfo>
): Promise<TickerRow[]> {
  const res = await phemexFetch(
    `${PHEMEX_BASE}/md/v1/ticker/24hr/all`,
    "Perp tickers"
  );
  if (!res.ok) throw new Error(`Perp tickers HTTP ${res.status}`);
  const json = await res.json();

  // Handle both new ({error, id, result}) and old ({code, data}) formats
  const items: Record<string, any>[] = json.result
    ?? json.data?.rows
    ?? json.data
    ?? [];

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Perp tickers: empty or unrecognised response");
  }

  const rows: TickerRow[] = [];
  for (const item of items) {
    // Support both object and array formats
    const isObj = !Array.isArray(item);
    const symbol = isObj ? item.symbol : item[1];
    const lastEp = isObj ? (item.lastEp ?? item.close) : item[2];
    const turnoverEv = isObj ? (item.turnoverEv ?? item.turnover) : item[item.length - 2];
    const volume = isObj ? item.volume : item[item.length - 1];

    const prod = productMap.get(symbol);
    if (!prod || prod.type !== "Perpetual" || prod.status !== "Listed") continue;

    const ps = prod.priceScale;
    const rs = prod.ratioScale;
    const lastPrice = scaleValue(lastEp, ps);

    // For COIN-margined perps: turnoverEv is in the smallest unit of quote currency
    // Divide by 10^ratioScale to get the value in quote currency
    let volume24hUsd = scaleValue(turnoverEv, rs);
    // Fallback: if turnover seems too small, try volume * price
    if (volume24hUsd < 1 && volume && lastPrice > 0) {
      volume24hUsd = scaleValue(volume, rs) * lastPrice;
    }

    if (volume24hUsd < MIN_VOLUME_USD) continue;

    rows.push({
      symbol,
      displaySymbol: prod.displaySymbol || `${prod.baseCurrency} / ${prod.quoteCurrency}`,
      baseCurrency: prod.baseCurrency,
      quoteCurrency: prod.quoteCurrency,
      lastPrice,
      volume24hUsd,
      change5m: 0, change10m: 0, change15m: 0, change30m: 0,
      price5mAgo: 0, price10mAgo: 0, price15mAgo: 0, price30mAgo: 0,
    });
  }
  return rows;
}

// ─── Klines ─────────────────────────────────────────────────────────────────
// Phemex kline row format:
//   [timestamp(sec), interval, last_close, open, high, low, close, volume, turnover]
//
// IMPORTANT: Percentage changes are SCALE-INVARIANT. We compute them on raw
// Ep values so they're correct regardless of the actual priceScale.
//   change = (currentEp - historicalEp) / historicalEp * 100
//
// We only convert to real prices for the display fields (lastPrice, priceNmAgo).

interface KlineData {
  closeRaw: number;   // raw close Ep
  closePrice: number; // converted close price (for display)
  timestamp: number;
}

async function fetchKline(
  symbol: string,
  priceScale: number
): Promise<KlineData[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const from = nowSec - 2100; // 35 minutes ago to ensure we get 30 complete 1m candles
  const to = nowSec;
  const url = `${PHEMEX_BASE}/exchange/public/md/v2/kline?symbol=${encodeURIComponent(symbol)}&resolution=60&from=${from}&to=${to}`;

  const res = await phemexFetch(url, `Kline ${symbol}`);
  if (!res.ok) return [];

  try {
    const json = await res.json();
    const klineRows = json?.data?.rows;
    if (!Array.isArray(klineRows)) return [];

    return klineRows.map((r: any[]) => ({
      timestamp: Number(r[0]),
      closeRaw: Number(r[6]),       // raw Ep value (for % change calc)
      closePrice: scaleValue(r[6], priceScale), // converted (for display)
    }));
  } catch {
    return [];
  }
}

async function fetchKlinesBatch(
  rows: TickerRow[],
  productMap: Map<string, ProductInfo>
): Promise<Map<string, KlineData[]>> {
  const result = new Map<string, KlineData[]>();

  for (let i = 0; i < rows.length; i += KLINE_BATCH_SIZE) {
    const batch = rows.slice(i, i + KLINE_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const prod = productMap.get(row.symbol);
        const ps = prod?.priceScale ?? 8;
        const klines = await fetchKline(row.symbol, ps);
        return [row.symbol, klines] as const;
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        result.set(r.value[0], r.value[1]);
      }
    }

    // Delay between batches to respect rate limits
    if (i + KLINE_BATCH_SIZE < rows.length) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return result;
}

// ─── Enrich & Sort ───────────────────────────────────────────────────────────

function enrichWithKlineChanges(
  rows: TickerRow[],
  klineMap: Map<string, KlineData[]>,
  topN: number
): TickerRow[] {
  // We also need the raw lastEp for scale-invariant % change calculation.
  // Since we don't store lastEp, we reconstruct it from lastPrice * 10^priceScale.
  // But we don't have priceScale here, so we compute % change using the
  // CONCLOSED prices directly — this is accurate as long as both are
  // converted with the same scale (they are: same product's priceScale).
  //
  // Actually, even simpler: for % change, we just compare the converted
  // prices. Since both use the same scale, the ratio is identical to
  // the raw Ep ratio:
  //   (lastEp/s - histEp/s) / (histEp/s) = (lastEp - histEp) / histEp

  for (const row of rows) {
    const klines = klineMap.get(row.symbol);
    if (!klines || klines.length < 2) continue;

    const len = klines.length;

    // klines are sorted ascending by timestamp.
    // klines[len-1] = most recent completed 1m candle (~1 min ago)
    // klines[len-5] = candle completed ~5 min ago
    // klines[len-10] = candle completed ~10 min ago
    // klines[len-15] = candle completed ~15 min ago
    // klines[len-30] = candle completed ~30 min ago (or klines[0])

    const getHistPrice = (minutesAgo: number): { price: number; raw: number } | null => {
      const idx = len - minutesAgo;
      if (idx < 0 || idx >= len) return null;
      return { price: klines[idx].closePrice, raw: klines[idx].closeRaw };
    };

    const h5 = getHistPrice(5);
    const h10 = getHistPrice(10);
    const h15 = getHistPrice(15);
    const h30 = getHistPrice(30);

    if (h5 && h5.price > 0) {
      row.change5m = ((row.lastPrice - h5.price) / h5.price) * 100;
      row.price5mAgo = h5.price;
    }
    if (h10 && h10.price > 0) {
      row.change10m = ((row.lastPrice - h10.price) / h10.price) * 100;
      row.price10mAgo = h10.price;
    }
    if (h15 && h15.price > 0) {
      row.change15m = ((row.lastPrice - h15.price) / h15.price) * 100;
      row.price15mAgo = h15.price;
    }
    if (h30 && h30.price > 0) {
      row.change30m = ((row.lastPrice - h30.price) / h30.price) * 100;
      row.price30mAgo = h30.price;
    }
  }

  // Sort by absolute 30m change (descending), then by volume
  rows.sort((a, b) => {
    const diff = Math.abs(b.change30m) - Math.abs(a.change30m);
    if (diff !== 0) return diff;
    return b.volume24hUsd - a.volume24hUsd;
  });

  return rows.slice(0, topN);
}

// ─── Mock / Fallback ─────────────────────────────────────────────────────────

function generateMockData(type: string, count: number): TickerRow[] {
  const bases = [
    "BTC","ETH","SOL","XRP","DOGE","BNB","ADA","AVAX","LINK","DOT",
    "MATIC","LTC","UNI","APT","ATOM","NEAR","FIL","ARB","OP","INJ",
    "SUI","TIA","SEI","FTM","RUNE","MANA","GRT","SAND","AAVE",
  ];
  const refPrices: Record<string, number> = {
    BTC:104500, ETH:2480, SOL:172, XRP:2.45, DOGE:0.40,
    BNB:658, ADA:1.05, AVAX:38.5, LINK:22.3, DOT:8.15,
    MATIC:0.55, LTC:108, UNI:13.2, APT:12.8, ATOM:12.5,
    NEAR:7.8, FIL:7.2, ARB:1.55, OP:2.75, INJ:35.5,
    SUI:4.2, TIA:12.8, SEI:0.82, FTM:1.15, RUNE:6.5,
    MANA:0.92, GRT:0.47, SAND:1.05, AAVE:285,
  };

  return bases.slice(0, count).map((base) => {
    const price = refPrices[base] ?? 100;
    const ch5 = (Math.random() - 0.5) * 2;
    const ch10 = (Math.random() - 0.5) * 3;
    const ch15 = (Math.random() - 0.5) * 4;
    const ch30 = (Math.random() - 0.5) * 5;
    return {
      symbol: `${base}USDT`,
      displaySymbol: `${base} / USDT`,
      baseCurrency: base,
      quoteCurrency: "USDT",
      lastPrice: price,
      volume24hUsd: 500_000 + Math.random() * 900_000_000,
      change5m: ch5, change10m: ch10, change15m: ch15, change30m: ch30,
      price5mAgo: price / (1 + ch5 / 100),
      price10mAgo: price / (1 + ch10 / 100),
      price15mAgo: price / (1 + ch15 / 100),
      price30mAgo: price / (1 + ch30 / 100),
    };
  });
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") || "perp";
  const topN = type === "spot" ? TOP_N_SPOT : TOP_N_PERP;

  try {
    // 1. Fetch products for priceScale / ratioScale
    const productMap = await fetchProducts();

    // 2. Fetch tickers
    let rows: TickerRow[];
    if (type === "spot") {
      rows = await fetchSpotTickers(productMap);
    } else {
      rows = await fetchPerpTickers(productMap);
    }

    if (rows.length === 0) {
      throw new Error("No tickers found after volume filtering");
    }

    // 3. Fetch klines for 5m/10m/15m/30m price change calculation
    const klineMap = await fetchKlinesBatch(rows, productMap);

    // 4. Enrich with kline-based changes, sort, and trim
    const finalRows = enrichWithKlineChanges(rows, klineMap, topN);

    const now = Date.now();
    return NextResponse.json({
      fetchedAt: now,
      serverTime: now,
      source: "live",
      rows: finalRows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[market-changes ${type}] ${msg}`);

    const mockRows = generateMockData(type, topN);
    const now = Date.now();
    return NextResponse.json({
      fetchedAt: now,
      serverTime: now,
      source: "mock",
      warning: `Live Phemex API error: ${msg}. Showing simulated market data so the UI stays usable.`,
      rows: mockRows,
    });
  }
}

export const dynamic = "force-dynamic";
export const revalidate = 0;