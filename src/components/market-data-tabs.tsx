"use client";

import * as React from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MarketDataTable } from "@/components/market-data-table";
import type { MarketSnapshot, MarketChangeRow } from "@/lib/phemex";

type MarketType = "perp" | "spot";

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds

export function MarketDataTabs() {
  const [activeType, setActiveType] = React.useState<MarketType>("perp");
  const [snapshots, setSnapshots] = React.useState<Record<MarketType, MarketSnapshot | null>>({
    perp: null,
    spot: null,
  });
  const [loading, setLoading] = React.useState<Record<MarketType, boolean>>({
    perp: true,
    spot: true,
  });
  const [errors, setErrors] = React.useState<Record<MarketType, string | null>>({
    perp: null,
    spot: null,
  });
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [lastRefreshAttempt, setLastRefreshAttempt] = React.useState<number>(Date.now());

  const fetchData = React.useCallback(async (type: MarketType) => {
    setLoading((s) => ({ ...s, [type]: true }));
    setErrors((s) => ({ ...s, [type]: null }));
    try {
      const res = await fetch(`/api/market-changes?type=${type}`, { cache: "no-store" });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(errJson.error ?? `HTTP ${res.status}`);
      }
      const data: MarketSnapshot = await res.json();
      setSnapshots((s) => ({ ...s, [type]: data }));
    } catch (err) {
      setErrors((s) => ({
        ...s,
        [type]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setLoading((s) => ({ ...s, [type]: false }));
      setLastRefreshAttempt(Date.now());
    }
  }, []);

  // Initial load for both markets.
  React.useEffect(() => {
    void fetchData("perp");
    void fetchData("spot");
  }, [fetchData]);

  // Auto-refresh both markets every 30 seconds when enabled.
  React.useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void fetchData("perp");
      void fetchData("spot");
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  const activeSnapshot = snapshots[activeType];
  const activeLoading = loading[activeType];
  const activeError = errors[activeType];

  const handleRefreshAll = () => {
    void fetchData("perp");
    void fetchData("spot");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-3 px-1">
        <div className="flex items-center gap-2">
          <Activity className="size-5 text-amber-400" />
          <div className="flex flex-col">
            <h1 className="text-lg font-semibold tracking-tight">Phemex Price Movers</h1>
            <p className="text-xs text-muted-foreground">
              Real-time ranking of pairs by recent price change
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
            className={cn(
              "h-8 gap-1.5",
              autoRefresh
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                autoRefresh ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/50",
              )}
            />
            Auto {autoRefresh ? "ON" : "OFF"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshAll}
            className="h-8 gap-1.5"
            disabled={activeLoading}
          >
            <RefreshCw className={cn("size-3.5", activeLoading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Source warning banner */}
      {activeSnapshot?.source === "mock" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <span className="font-semibold">Simulated data — live Phemex API unreachable</span>
            <span className="text-amber-200/80">{activeSnapshot.warning}</span>
          </div>
        </div>
      )}

      {/* Error banner (only shown if there's an error AND no fallback data) */}
      {activeError && !activeSnapshot && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <span className="font-semibold">Failed to load market data</span>
            <span className="text-red-200/80 font-mono break-all">{activeError}</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeType} onValueChange={(v) => setActiveType(v as MarketType)}>
        <TabsList className="bg-muted/50">
          <TabsTrigger value="perp" className="gap-1.5 data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
            USDⓈ-M Perpetual
            {snapshots.perp && (
              <Badge variant="secondary" className="ml-1 bg-muted/70 text-[10px] py-0 px-1.5">
                {snapshots.perp.rows.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="spot" className="gap-1.5 data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
            Spot
            {snapshots.spot && (
              <Badge variant="secondary" className="ml-1 bg-muted/70 text-[10px] py-0 px-1.5">
                {snapshots.spot.rows.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="perp">
          <MarketDataTable
            rows={snapshots.perp?.rows ?? []}
            loading={loading.perp && !snapshots.perp}
          />
        </TabsContent>
        <TabsContent value="spot">
          <MarketDataTable
            rows={snapshots.spot?.rows ?? []}
            loading={loading.spot && !snapshots.spot}
          />
        </TabsContent>
      </Tabs>

      {/* Footer status */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3 px-1 text-[11px] text-muted-foreground">
        <span>
          Last refresh:{" "}
          <span className="font-mono">
            {activeSnapshot
              ? new Date(activeSnapshot.fetchedAt).toLocaleTimeString()
              : "—"}
          </span>
        </span>
        <span>
          Data source:{" "}
          <span
            className={cn(
              "font-mono",
              activeSnapshot?.source === "live" ? "text-emerald-400" : "text-amber-300",
            )}
          >
            {activeSnapshot?.source === "live" ? "LIVE (Phemex)" : "SIMULATED"}
          </span>
        </span>
      </div>
    </div>
  );
}
