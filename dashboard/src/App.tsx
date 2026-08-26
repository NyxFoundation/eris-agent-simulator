import { useEffect, useState } from "react";
import { TopPage } from "@/pages/TopPage";
import { LeaderboardPage } from "@/pages/LeaderboardPage";
import { ExplorerPage } from "@/pages/ExplorerPage";
import { MarketPage } from "@/pages/MarketPage";
import { ArchivePage } from "@/pages/ArchivePage";
import { RulesPage } from "@/pages/RulesPage";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { RegisterPage } from "@/pages/RegisterPage";

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const agentMatch = pathname.match(/^\/agent\/([^/]+)$/);
  if (agentMatch) return <AgentDetailPage agentId={decodeURIComponent(agentMatch[1])} />;
  if (pathname === "/leaderboard") return <LeaderboardPage />;
  if (pathname === "/explorer") return <ExplorerPage />;
  if (pathname === "/markets") return <MarketPage />;
  if (pathname === "/archive") return <ArchivePage />;
  if (pathname === "/rules") return <RulesPage />;
  if (pathname === "/register") return <RegisterPage />;
  return <TopPage />;
}
