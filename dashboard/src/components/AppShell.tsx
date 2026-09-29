import { SiteHeader, type NavKey } from "@/components/SiteHeader";
import { Sidebar } from "@/components/Sidebar";
import { useIsMobile } from "@/lib/breakpoints";

/**
 * The frame every page sits in: the header across the top, then the sidebar and the page.
 *
 * Two arrangements. On a wide screen the sidebar (the competition picker) is a column beside the
 * page, under the header. Below `MOBILE` there is no column: the header folds the page links and the
 * picker into its menu, and the page gets the whole width.
 */
export function AppShell({
  activePage,
  children,
}: {
  activePage?: NavKey;
  children: React.ReactNode;
}) {
  const mobile = useIsMobile();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-canvas)",
      }}
    >
      <SiteHeader activePage={activePage} />
      <div style={{ flex: 1, display: "flex", alignItems: "stretch", minWidth: 0 }}>
        {!mobile && <Sidebar activePage={activePage} />}
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
