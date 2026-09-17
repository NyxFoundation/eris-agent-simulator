import { Sidebar, type SidebarNavKey } from "@/components/Sidebar";
import { useIsMobile } from "@/lib/breakpoints";

/**
 * The frame every page sits in: navigation, then the page.
 *
 * Each page used to open with the same twelve lines of flex and then render `<Sidebar/>` itself, so
 * the arrangement was stated five times and could only ever be a row. It is one component now
 * because it has to be two arrangements: a row with the sidebar as a column, and — below `MOBILE` —
 * a column with the sidebar as a top bar above the page.
 */
export function AppShell({
  activePage,
  children,
}: {
  activePage?: SidebarNavKey;
  children: React.ReactNode;
}) {
  const mobile = useIsMobile();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: mobile ? "column" : "row",
        alignItems: "stretch",
        background: "var(--bg-canvas)",
      }}
    >
      <Sidebar activePage={activePage} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The centred column a page's body lives in. Width and gutters come from `--page-max` and
 * `--page-pad-x`, which is where a wide display is allowed to matter.
 */
export const PAGE_MAIN: React.CSSProperties = {
  maxWidth: "var(--page-max)",
  width: "100%",
  minWidth: 0,
  margin: "0 auto",
  padding: "var(--page-pad-top) var(--page-pad-x) 64px",
  boxSizing: "border-box",
};
