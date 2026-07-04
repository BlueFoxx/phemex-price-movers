import { NextRequest, NextResponse } from "next/server";
import { fetchMarketSnapshot } from "@/lib/phemex";

/**
 * GET /api/market-changes?type=perp|spot
 *
 * Returns the full market-change snapshot for one market type. The response
 * is suitable for the frontend to render in the table directly — all % changes
 * are precomputed for the 5m / 10m / 15m / 30m windows.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const type = (sp.get("type") ?? "perp").toLowerCase();
  if (type !== "perp" && type !== "spot") {
    return NextResponse.json(
      { error: "Invalid `type` param. Must be 'perp' or 'spot'." },
      { status: 400 },
    );
  }

  try {
    const snapshot = await fetchMarketSnapshot(type as "perp" | "spot");
    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Unknown error fetching market data.",
      },
      { status: 500 },
    );
  }
}
