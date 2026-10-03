import { useEffect, useState } from "react";
import { OverviewPage } from "@/pages/OverviewPage";
import { StandingsPage } from "@/pages/StandingsPage";
import { ExplorerPage } from "@/pages/ExplorerPage";
import { MarketPage } from "@/pages/MarketPage";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { ScenarioPage } from "@/pages/ScenarioPage";
import { UpdatesPage } from "@/pages/UpdatesPage";
import { useLocale } from "@/i18n/locale";

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const locale = useLocale();

  // Screen readers and the browser's own translation offer read the page's language from here.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // "/world" was the board's own route until the scenario page became the board. A link kept from
  // then lands on the scenario page, and the address bar says so.
  useEffect(() => {
    if (pathname === "/world") {
      window.history.replaceState({}, "", "/scenario");
      setPathname("/scenario");
    }
  }, [pathname]);

  const agentMatch = pathname.match(/^\/agent\/([^/]+)$/);
  if (agentMatch)
    return <AgentDetailPage agentId={decodeURIComponent(agentMatch[1])} />;
  if (pathname === "/explorer") return <ExplorerPage />;
  if (pathname === "/markets") return <MarketPage />;
  // "/" is the overview a participant lands on: the schedule, the rules in brief, the top of the
  // table and where everything else lives. The three levels below it, as two routes plus the agent
  // pages: "/standings" is the competition, "/scenario" is one world inside it, shown as a board of
  // its agents walked block by block. Markets and Explorer stay at the scenario level, because a
  // venue's state and a block range only mean anything inside one world.
  // "/updates" is the environment's update history: the guide describes the current environment,
  // so a participant who read it last week needs the diff, and needs it where they already are.
  // The index lists the dated entries; "/updates/<YYYY-MM-DD>" is one of them.
  const updateMatch = pathname.match(/^\/updates\/(\d{4}-\d{2}-\d{2})$/);
  if (updateMatch) return <UpdatesPage entrySlug={updateMatch[1]} />;
  if (pathname === "/updates") return <UpdatesPage />;
  if (pathname === "/standings") return <StandingsPage />;
  if (pathname === "/scenario" || pathname === "/world") return <ScenarioPage />;
  return <OverviewPage />;
}
