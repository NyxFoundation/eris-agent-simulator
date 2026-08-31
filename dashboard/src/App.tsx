import { useEffect, useState } from "react";
import { HomePage } from "@/pages/HomePage";
import { ExplorerPage } from "@/pages/ExplorerPage";
import { MarketPage } from "@/pages/MarketPage";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { ScenarioPage } from "@/pages/ScenarioPage";

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
  if (pathname === "/explorer") return <ExplorerPage />;
  if (pathname === "/markets") return <MarketPage />;
  // The three levels, as two routes plus the agent pages: "/" is the competition (its standings),
  // "/scenario" is one world inside it. Markets and Explorer stay at the scenario level, because a
  // venue's state and a block range only mean anything inside one world.
  if (pathname === "/scenario") return <ScenarioPage />;
  return <HomePage />;
}
