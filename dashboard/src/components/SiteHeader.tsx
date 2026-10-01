// The bar across the top of every page: where you are in the dashboard, and the two things a
// visitor may want before reading anything — to register, and to read it in the other language.
//
// It used to be a sidebar with the language toggle at its very bottom, which on a phone was inside
// a drawer; registration was not linked anywhere. The name is ASCON, the competition's, because
// that is what a participant arrives looking for (ascon.dev); "Eris" is the simulator underneath.
//
// Below `MOBILE` the page links fold into a menu. Registration and the language stay on the bar at
// every width.

import { useEffect, useState } from "react";
import {
  DISCORD_URL,
  REGISTRATION_FORM_URL,
  SCHEDULE,
  SUBMISSION_FORM_URL,
  registrationOpen,
  submissionOpen,
  rulesUrl,
} from "@/data/competitionInfo";
import { isSeedProvider } from "@/data/provider";
import { InfoTip, TipText } from "@/design-system/InfoTip";
import { setLocale, useLocale } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { useIsMobile } from "@/lib/breakpoints";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { formatJstDay } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { navigate } from "@/navigation";

export type NavKey =
  "overview" | "standings" | "scenario" | "markets" | "explorer";

type NavItem = { key: NavKey; label: string; path: string };

/** Up to the widest phones (430px): too narrow for the wordmark beside both forms and the toggle. */
const PHONE = "(max-width: 430px)";

function navItems(): NavItem[] {
  return [
    { key: "overview", label: t("nav.overview"), path: "/" },
    // The seed provider has no competitions, so there is nothing to rank.
    ...(isSeedProvider
      ? []
      : [
          {
            key: "standings" as const,
            label: t("nav.standings"),
            path: "/standings",
          },
        ]),
    { key: "scenario", label: t("nav.scenario"), path: "/scenario" },
    { key: "markets", label: t("nav.markets"), path: "/markets" },
    { key: "explorer", label: t("nav.explorer"), path: "/explorer" },
  ];
}

/** A real link (middle-click opens a tab), routed in-app on a plain click. */
function inAppClick(path: string, after?: () => void) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
      return;
    e.preventDefault();
    navigate(path);
    after?.();
  };
}

function Brand({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <a
      href="/"
      onClick={inAppClick("/")}
      aria-label={t("header.home")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "9px",
        flexShrink: 0,
        color: "var(--text-primary)",
        textDecoration: "none",
      }}
    >
      <img
        src="/ascon-icon.png"
        alt=""
        width={26}
        height={26}
        style={{ display: "block" }}
      />
      {wordmark && (
        <span
          style={{
            font: "var(--weight-bold) var(--text-md) var(--font-sans)",
            letterSpacing: "0.04em",
          }}
        >
          ASCON
        </span>
      )}
    </a>
  );
}

function RegisterButton({ compact }: { compact: boolean }) {
  const now = useNow();
  const locale = useLocale();
  if (!registrationOpen(now)) return null;
  const registration = SCHEDULE.find((p) => p.key === "registration");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
      <a
        href={REGISTRATION_FORM_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: "32px",
          padding: compact ? "0 11px" : "0 15px",
          borderRadius: "var(--radius-full)",
          background: "var(--pink-500)",
          color: "var(--gray-950)",
          font: "var(--weight-semibold) var(--text-sm) var(--font-sans)",
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        {t("header.register")}
      </a>
      <InfoTip
        label={t("header.register")}
        title={t("header.registerTipTitle")}
      >
        <TipText>
          {t("header.registerTipDiscord")}{" "}
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-link)" }}
          >
            {t("header.registerTipDiscordLink")}
          </a>
        </TipText>
        <TipText>
          {t("header.registerTipPeriod", {
            last: registration ? formatJstDay(registration.last, locale) : "",
          })}{" "}
          <a
            href={rulesUrl(locale, "1")}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-link)" }}
          >
            {t("overview.rulesLink", { section: "§1" })}
          </a>
        </TipText>
      </InfoTip>
    </span>
  );
}

/**
 * "Submit", right of "Register": the agent submission form, while it takes submissions (9/23–10/31
 * JST). Outlined rather than filled, so the two read as two different forms. After 10/24 it is the
 * only one left on the bar.
 */
function SubmitButton({ compact }: { compact: boolean }) {
  const now = useNow();
  if (!submissionOpen(now)) return null;
  return (
    <a
      href={SUBMISSION_FORM_URL}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: "32px",
        boxSizing: "border-box",
        padding: compact ? "0 11px" : "0 15px",
        borderRadius: "var(--radius-full)",
        border: "1px solid var(--pink-500)",
        color: "var(--pink-300)",
        font: "var(--weight-semibold) var(--text-sm) var(--font-sans)",
        textDecoration: "none",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {t("header.submit")}
    </a>
  );
}

/** One button, labelled with the language it switches to (as on ascon.dev). */
function LanguageToggle() {
  const locale = useLocale();
  const other = locale === "ja" ? "en" : "ja";
  return (
    <button
      type="button"
      onClick={() => setLocale(other)}
      aria-label={t("header.language")}
      style={{
        height: "32px",
        padding: "0 11px",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-full)",
        background: "transparent",
        color: "var(--text-primary)",
        font: "var(--text-xs) var(--font-mono)",
        letterSpacing: "var(--tracking-wide)",
        cursor: "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span lang={other}>{other === "ja" ? "日本語" : "EN"}</span>
    </button>
  );
}

function NavLink({
  item,
  active,
  vertical,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  vertical: boolean;
  onNavigate?: () => void;
}) {
  return (
    <a
      href={item.path}
      onClick={inAppClick(item.path, onNavigate)}
      aria-current={active ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: vertical ? "space-between" : "center",
        height: vertical ? "52px" : "var(--header-h)",
        padding: vertical ? "0 var(--space-4)" : "0 12px",
        boxSizing: "border-box",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
        letterSpacing: "var(--tracking-widest)",
        textTransform: "uppercase",
        textDecoration: "none",
        whiteSpace: "nowrap",
        ...(vertical
          ? {
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `3px solid ${active ? "var(--pink-500)" : "transparent"}`,
              background: active ? "var(--bg-surface-raised)" : "transparent",
            }
          : {
              boxShadow: active ? "inset 0 -2px 0 var(--pink-500)" : "none",
            }),
      }}
    >
      <span>{item.label}</span>
      {vertical && active && <span aria-hidden>/</span>}
    </a>
  );
}

const BAR: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 30,
  height: "var(--header-h)",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "0 var(--space-4)",
  borderBottom: "1px solid var(--border-subtle)",
  background: "var(--bg-sunken)",
  boxSizing: "border-box",
};

export function SiteHeader({ activePage }: { activePage?: NavKey }) {
  // Read so every label re-renders when the language changes.
  useLocale();
  const mobile = useIsMobile();
  const phone = useMediaQuery(PHONE);
  const [open, setOpen] = useState(false);
  const nav = navItems();

  // Growing the window past the breakpoint while the menu is open would otherwise leave the scrim
  // over a page that has its sidebar back.
  useEffect(() => {
    if (!mobile) setOpen(false);
  }, [mobile]);

  // Escape closes the menu, and the page behind it does not scroll while it is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!mobile) {
    return (
      <header style={BAR}>
        <div style={{ flexShrink: 0, marginRight: "12px" }}>
          <Brand />
        </div>
        <nav
          aria-label={t("header.nav")}
          style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}
        >
          {nav.map((item) => (
            <NavLink
              key={item.key}
              item={item}
              active={item.key === activePage}
              vertical={false}
            />
          ))}
        </nav>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <RegisterButton compact={false} />
          <SubmitButton compact={false} />
          <LanguageToggle />
        </div>
      </header>
    );
  }

  return (
    <>
      <header
        style={{
          ...BAR,
          gap: phone ? "6px" : "8px",
          padding: phone ? "0 8px 0 10px" : "0 10px 0 14px",
        }}
      >
        {/* On a phone the bar holds Register, Submit, the language and the menu; the wordmark
            gives way first (the mark still links home, and says so to a screen reader). */}
        <Brand wordmark={!phone} />
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: phone ? "4px" : "6px",
          }}
        >
          <RegisterButton compact />
          <SubmitButton compact />
          <LanguageToggle />
          <button
            type="button"
            aria-label={t("nav.menu")}
            aria-expanded={open}
            onClick={() => setOpen(true)}
            style={{
              width: "36px",
              height: "32px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-surface-raised)",
              color: "var(--text-primary)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "3px",
                width: "14px",
              }}
            >
              <span style={BURGER_BAR} />
              <span style={BURGER_BAR} />
              <span style={BURGER_BAR} />
            </span>
          </button>
        </div>
      </header>

      {open && (
        <>
          <div className="nav-scrim" onClick={() => setOpen(false)} />
          <div
            className="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("nav.menu")}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              bottom: 0,
              zIndex: 41,
              width: "min(286px, 86vw)",
              background: "var(--bg-sunken)",
              borderRight: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}
          >
            <div
              style={{
                height: "var(--header-h)",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 var(--space-3) 0 14px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <Brand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("picker.close")}
                style={{
                  width: "34px",
                  height: "34px",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-sm)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  font: "var(--text-base) var(--font-mono)",
                  lineHeight: 1,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
            <nav
              aria-label={t("header.nav")}
              style={{ display: "flex", flexDirection: "column" }}
            >
              {nav.map((item) => (
                <NavLink
                  key={item.key}
                  item={item}
                  active={item.key === activePage}
                  vertical
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </nav>
          </div>
        </>
      )}
    </>
  );
}

const BURGER_BAR: React.CSSProperties = {
  height: "1.5px",
  background: "currentColor",
  borderRadius: "1px",
};
