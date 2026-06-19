// roster id → エージェント分類（ADR 0008「フロントエンド・パネル構成」の色分け根拠）。
//
// ロスター（mixed30 等）の id 命名規約から kind（自己改善 / 固定 / baseline）と
// base 戦略・連番を導く。registry emit（agents_registered）は baseline フラグも渡すので、
// それを優先しつつ id 文字列からも補完する（id だけでも分類できるよう純粋関数に保つ）。

export type AgentKind = "si" | "frozen" | "baseline";

export type AgentClass = {
  kind: AgentKind;
  base: string | null; // base 戦略 id（crossvenue / cvbal / venue / ...）
  index: number | null; // 連番（si-codex-01-... → 1）。無ければ null
};

const BASELINE_IDS = new Set(["noop", "random"]);

function looksSelfImprove(id: string): boolean {
  return /^si[-_]/.test(id) || /codex|llm|selfimprove|self-improve/.test(id);
}

function looksFrozen(id: string): boolean {
  return /^(fix|frozen|fixed)[-_]/.test(id);
}

function extractIndex(id: string): number | null {
  const m = id.match(/-(\d+)(?:-|$)/);
  return m ? Number(m[1]) : null;
}

function extractBase(id: string, kind: AgentKind): string | null {
  if (kind === "si") {
    // si-codex-01-crossvenue / si-01-arb / si-crossvenue を crossvenue 等へ正規化
    const m = id.match(/^si[-_](?:[a-z]+[-_])?(?:\d+[-_])?(.+)$/i);
    return m ? m[1] : null;
  }
  if (kind === "frozen") {
    const m = id.match(/^(?:fix|frozen|fixed)[-_](.+)$/i);
    return m ? m[1] : id;
  }
  return null;
}

export function classifyAgent(
  id: string,
  opts?: { baseline?: boolean },
): AgentClass {
  let kind: AgentKind;
  if (opts?.baseline || BASELINE_IDS.has(id)) {
    kind = "baseline";
  } else if (looksSelfImprove(id)) {
    kind = "si";
  } else if (looksFrozen(id)) {
    kind = "frozen";
  } else {
    // 既定: 固定戦略扱い（自己改善/baseline は上で判別済み）
    kind = "frozen";
  }
  return { kind, base: extractBase(id, kind), index: extractIndex(id) };
}

// id の安定ハッシュ（同一 id → 同一色）。FNV-1a。
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function bandHue(id: string, lo: number, hi: number): number {
  return lo + (hashStr(id) % Math.max(1, hi - lo));
}

// kind で色相帯を分け（si=青〜紫 / frozen=橙〜赤 / baseline=灰）、
// 帯の中は id ハッシュで散らして同 kind 内も見分けられるようにする。
export function agentColor(id: string, kind: AgentKind): string {
  switch (kind) {
    case "si":
      return `hsl(${bandHue(id, 185, 280)} 72% 62%)`;
    case "frozen":
      return `hsl(${bandHue(id, 16, 48)} 82% 58%)`;
    default:
      return "hsl(220 6% 62%)";
  }
}
