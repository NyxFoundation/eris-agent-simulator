import { useEffect, useState } from "react";
import { TopPage } from "@/pages/TopPage";
import { LeaderboardPage } from "@/pages/LeaderboardPage";
import { ExplorerPage } from "@/pages/ExplorerPage";
import { MarketPage } from "@/pages/MarketPage";
import { ArchivePage } from "@/pages/ArchivePage";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { MatrixPage } from "@/pages/MatrixPage";

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
  // One run's overview. It used to be the landing page, which meant the dashboard opened on a single
  // draw from a regime's distribution — the reading config/scenarios/public.yaml explicitly warns
  // against. The outer unit is the matrix, so that is what "/" resolves to; MatrixPage falls back to
  // this view when there is no matrix on disk (the standalone `sim:realtime` loop).
  if (pathname === "/run") return <TopPage />;
  return <MatrixPage />;
}
