import { useEffect, useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { useTopPageSnapshot } from "@/data/useTopPageSnapshot";

const REGISTRATION_DEADLINE = new Date("2026-09-23T00:00:00").getTime();

interface CountdownParts {
  days: string;
  hours: string;
  minutes: string;
}

function useCountdownParts(endsAt: number): CountdownParts {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = Math.max(0, endsAt - now);
  const totalMinutes = Math.floor(remaining / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return {
    days: String(days).padStart(2, "0"),
    hours: String(hours).padStart(2, "0"),
    minutes: String(minutes).padStart(2, "0"),
  };
}

function CountdownUnit({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
      <span
        style={{
          font: "var(--weight-bold) var(--text-3xl) var(--font-mono)",
          color: "var(--green-500)",
          textShadow: "0 0 12px rgba(95,217,138,0.65), 0 0 28px rgba(95,217,138,0.35)",
        }}
      >
        {value}
      </span>
      <span
        style={{
          font: "var(--weight-medium) 9px var(--font-mono)",
          letterSpacing: "var(--tracking-widest)",
          textTransform: "uppercase",
          color: "var(--green-300)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function RegisterPage() {
  const { data } = useTopPageSnapshot();
  const countdown = useCountdownParts(REGISTRATION_DEADLINE);

  return (
    <div style={{ minHeight: "100vh", display: "flex", background: "var(--bg-canvas)" }}>
      <Sidebar />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      {data && <RoundsBar round={data.round} />}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "18px",
          padding: "56px 32px",
          background: "radial-gradient(circle at 50% 35%, var(--gray-900), var(--bg-canvas))",
        }}
      >
        <span
          style={{
            font: "var(--weight-bold) var(--text-4xl) var(--font-sans)",
            color: "var(--pink-500)",
            letterSpacing: "var(--tracking-tight)",
            textShadow: "0 0 20px rgba(220,152,204,0.6), 0 0 44px rgba(220,152,204,0.32)",
          }}
        >
          ASCON
        </span>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "18px" }}>
          <CountdownUnit value={countdown.days} label="Days" />
          <span style={{ font: "var(--weight-bold) var(--text-3xl) var(--font-mono)", color: "var(--green-500)", opacity: 0.5 }}>:</span>
          <CountdownUnit value={countdown.hours} label="Hours" />
          <span style={{ font: "var(--weight-bold) var(--text-3xl) var(--font-mono)", color: "var(--green-500)", opacity: 0.5 }}>:</span>
          <CountdownUnit value={countdown.minutes} label="Minutes" />
        </div>
      </main>
      </div>
    </div>
  );
}
