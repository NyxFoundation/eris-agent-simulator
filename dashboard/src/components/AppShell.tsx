import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader, type NavKey } from "@/components/SiteHeader";

/**
 * The frame every page sits in: the header across the top, the page at full width, a one-line
 * footer. There is no sidebar (issue #183): the competition picker sits beside the competition's
 * name on the overview and the standings, and the world switcher in the interval bar on the
 * scenario-level pages.
 */
export function AppShell({
  activePage,
  children,
}: {
  activePage?: NavKey;
  children: React.ReactNode;
}) {
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
      <SiteFooter />
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
