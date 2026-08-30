import { useEffect, useState } from "react";
import { HomePage } from "@/pages/HomePage";
import { LeaderboardPage } from "@/pages/LeaderboardPage";
import { ExplorerPage } from "@/pages/ExplorerPage";
import { MarketPage } from "@/pages/MarketPage";
import { ArchivePage } from "@/pages/ArchivePage";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { ScenarioPage } from "@/pages/ScenarioPage";
import { StandingsPage } from "@/pages/StandingsPage";

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const agentMatch = pathname.match(/^\/agent\/([^/]+)$/);
  if (agentMatch)
    return <AgentDetailPage agentId={decodeURIComponent(agentMatch[1])} />;
  if (pathname === "/leaderboard") return <LeaderboardPage />;
  if (pathname === "/explorer") return <ExplorerPage />;
  if (pathname === "/markets") return <MarketPage />;
  if (pathname === "/archive") return <ArchivePage />;
  // The three levels, as three routes. "/" is the whole competition, "/standings" is its full
  // ranking table with the rule exposed as controls, and "/scenario" is one world inside it.
  // "/run" is the old path for that last one, kept so existing links still land somewhere real.
  if (pathname === "/standings") return <StandingsPage />;
  if (pathname === "/scenario" || pathname === "/run") return <ScenarioPage />;
  return <HomePage />;
}
