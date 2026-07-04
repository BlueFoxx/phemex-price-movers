"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MarketChangeRow } from "@/lib/phemex";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export type TimeframeKey = "change5m" | "change10m" | "change15m" | "change30m";

type SortKey = TimeframeKey | "volume24hUsd" | "lastPrice" | "symbol";

type SortDir = "asc" | "desc" | null;

interface SortState {
  key: SortKey;
  dir: SortDir;
}

/* -------------------------------------------------------------------------- */
/*                              Helpers & formatters                          */
/* -------------------------------------------------------------------------- */

function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p === 0) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(8);
}

function formatVolume(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "—";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** Pick a Tailwind text color class for a percentage. */
function pctColorClass(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "text-muted-foreground";
  if (pct > 0.01) return "text-emerald-400";
  if (pct < -0.01) return "text-red-400";
  return "text-muted-foreground";
}

/** Pick a background tint class for a percentage cell (used as a subtle heatmap indicator). */
function pctBgClass(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "";
  const abs = Math.min(Math.abs(pct), 5) / 5; // 0..1
  if (pct > 0.01) {
    // Green tint, opacity scaled by magnitude
    const alpha = Math.round(abs * 35) / 100;
    return "bg-emerald-500/10";
  }
  if (pct < -0.01) {
    return "bg-red-500/10";
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/*                          Sortable column header                            */
/* -------------------------------------------------------------------------- */

interface ColumnHeaderProps {
  label: string;
  sortKey: SortKey;
  sortState: SortState;
  onSort: (key: SortKey) => void;
  align?: "left" | "right" | "center";
  className?: string;
  /** Optional sub-label rendered below the main label. */
  hint?: string;
}

function SortableHeader({
  label,
  sortKey,
  sortState,
  onSort,
  align = "right",
  className,
  hint,
}: ColumnHeaderProps) {
  const isActive = sortState.key === sortKey && sortState.dir !== null;
  const alignClass = align === "left" ? "justify-start" : align === "center" ? "justify-center" : "justify-end";

  return (
    <TableHead className={cn("px-3 py-2", className)}>
      <div className={cn("flex items-center gap-1.5", alignClass)}>
        <div className="flex flex-col items-end">
          <span className={cn("text-xs font-semibold tracking-wide", isActive ? "text-foreground" : "text-muted-foreground")}>
            {label}
          </span>
          {hint && <span className="text-[10px] text-muted-foreground/70 font-normal">{hint}</span>}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSort(sortKey)}
          className={cn(
            "h-7 w-7 p-0 hover:bg-muted/80",
            isActive ? "text-foreground" : "text-muted-foreground/60",
          )}
          aria-label={`Sort by ${label}`}
        >
          {isActive && sortState.dir === "asc" ? (
            <ArrowUp className="size-3.5" />
          ) : isActive && sortState.dir === "desc" ? (
            <ArrowDown className="size-3.5" />
          ) : (
            <ChevronsUpDown className="size-3.5" />
          )}
        </Button>
      </div>
    </TableHead>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Table component                               */
/* -------------------------------------------------------------------------- */

export interface MarketDataTableProps {
  rows: MarketChangeRow[];
  loading: boolean;
  onRowClick?: (row: MarketChangeRow) => void;
}

const DEFAULT_SORT: SortState = { key: "change5m", dir: "desc" };

export function MarketDataTable({ rows, loading }: MarketDataTableProps) {
  const [sortState, setSortState] = React.useState<SortState>(DEFAULT_SORT);
  const [search, setSearch] = React.useState("");

  const handleSort = React.useCallback((key: SortKey) => {
    setSortState((cur) => {
      if (cur.key !== key) {
        // First click on a new column → default to desc (highest first).
        return { key, dir: "desc" };
      }
      // Same column: cycle desc → asc → null → desc.
      if (cur.dir === "desc") return { key, dir: "asc" };
      if (cur.dir === "asc") return { key, dir: null };
      return { key, dir: "desc" };
    });
  }, []);

  const filteredRows = React.useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.symbol.toLowerCase().includes(q) ||
        r.displaySymbol.toLowerCase().includes(q) ||
        r.baseCurrency.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const sortedRows = React.useMemo(() => {
    if (sortState.dir === null) return filteredRows;
    const dir = sortState.dir === "asc" ? 1 : -1;
    const key = sortState.key;
    const sorted = [...filteredRows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      // Treat null as -Infinity so it always sorts last regardless of direction.
      const an = av === null ? -Infinity : (typeof av === "number" ? av : String(av));
      const bn = bv === null ? -Infinity : (typeof bv === "number" ? bv : String(bv));
      if (an < bn) return -1 * dir;
      if (an > bn) return 1 * dir;
      return 0;
    });
    return sorted;
  }, [filteredRows, sortState]);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar: search + summary */}
      <div className="flex flex-wrap items-center gap-3 px-1">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search pair (e.g. BTC, ETH, sBTCUSDT)"
            className="pl-8 h-9 bg-muted/40 border-border/50"
          />
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="bg-muted/60 font-mono">
            {filteredRows.length} pair{filteredRows.length === 1 ? "" : "s"}
          </Badge>
          <span className="hidden sm:inline">24h vol &gt; $300K</span>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
        <div className="max-h-[calc(100vh-280px)] min-h-[280px] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="w-12 px-3 py-2 text-xs font-semibold text-muted-foreground text-center">
                  #
                </TableHead>
                <TableHead className="px-3 py-2 text-xs font-semibold text-muted-foreground">
                  Pair
                </TableHead>
                <SortableHeader
                  label="Last Price"
                  sortKey="lastPrice"
                  sortState={sortState}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="5m"
                  hint="Change"
                  sortKey="change5m"
                  sortState={sortState}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="10m"
                  hint="Change"
                  sortKey="change10m"
                  sortState={sortState}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="15m"
                  hint="Change"
                  sortKey="change15m"
                  sortState={sortState}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="30m"
                  hint="Change"
                  sortKey="change30m"
                  sortState={sortState}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="24h Volume"
                  sortKey="volume24hUsd"
                  sortState={sortState}
                  onSort={handleSort}
                  align="right"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && sortedRows.length === 0 ? (
                <SkeletonRows />
              ) : sortedRows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-12">
                    No pairs match your search.
                  </TableCell>
                </TableRow>
              ) : (
                sortedRows.map((row, i) => (
                  <TableRow
                    key={row.symbol}
                    className="border-border/40 hover:bg-muted/30 transition-colors"
                  >
                    <TableCell className="px-3 py-2 text-center text-xs font-mono text-muted-foreground">
                      {i + 1}
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="flex size-7 items-center justify-center rounded-full bg-amber-500/10 text-amber-300 text-[10px] font-bold uppercase">
                          {row.baseCurrency.slice(0, 3)}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold leading-tight">
                            {row.baseCurrency}
                            <span className="text-muted-foreground font-normal">
                              /{row.quoteCurrency}
                            </span>
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground/70 leading-tight">
                            {row.symbol}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right font-mono text-sm tabular-nums">
                      {formatPrice(row.lastPrice)}
                    </TableCell>
                    <PctCell pct={row.change5m} />
                    <PctCell pct={row.change10m} />
                    <PctCell pct={row.change15m} />
                    <PctCell pct={row.change30m} />
                    <TableCell className="px-3 py-2 text-right font-mono text-sm tabular-nums text-muted-foreground">
                      {formatVolume(row.volume24hUsd)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Footer hint */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
        <span>
          Click any column header to sort. Click again to toggle asc / desc / off.
        </span>
        <span className="font-mono">Source: Phemex public API</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                       Sub-components: cells, skeletons                     */
/* -------------------------------------------------------------------------- */

function PctCell({ pct }: { pct: number | null }) {
  return (
    <TableCell className={cn("px-3 py-2 text-right", pctBgClass(pct))}>
      <div className="flex items-center justify-end gap-1">
        {pct !== null && pct > 0 && <ArrowUp className="size-3 text-emerald-400" />}
        {pct !== null && pct < 0 && <ArrowDown className="size-3 text-red-400" />}
        <span
          className={cn(
            "font-mono text-sm tabular-nums font-medium",
            pctColorClass(pct),
          )}
        >
          {formatPct(pct)}
        </span>
      </div>
    </TableCell>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 12 }).map((_, i) => (
        <TableRow key={i} className="border-border/40 hover:bg-transparent">
          <TableCell className="px-3 py-2">
            <div className="h-4 w-4 mx-auto rounded bg-muted/60 animate-pulse" />
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="size-7 rounded-full bg-muted/60 animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-3 w-20 rounded bg-muted/60 animate-pulse" />
                <div className="h-2 w-16 rounded bg-muted/40 animate-pulse" />
              </div>
            </div>
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="ml-auto h-4 w-16 rounded bg-muted/60 animate-pulse" />
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="ml-auto h-4 w-14 rounded bg-muted/60 animate-pulse" />
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="ml-auto h-4 w-14 rounded bg-muted/60 animate-pulse" />
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="ml-auto h-4 w-14 rounded bg-muted/60 animate-pulse" />
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="ml-auto h-4 w-14 rounded bg-muted/60 animate-pulse" />
          </TableCell>
          <TableCell className="px-3 py-2">
            <div className="ml-auto h-4 w-16 rounded bg-muted/60 animate-pulse" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
