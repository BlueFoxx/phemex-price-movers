import { MarketDataTabs } from "@/components/market-data-tabs";

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <MarketDataTabs />
      </div>
    </main>
  );
}
