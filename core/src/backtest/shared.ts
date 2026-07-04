// participant backtest（ADR 0016）の共有ヘルパ: state dump manifest / fingerprint / regime 解決。
//
// backtest CLI は sdk/constants を import する前（ERIS_LOCAL_DEPLOY を立てる前・constants.local.ts の
// 同期前）に評価されるため、このモジュールは node built-in にしか依存しない
// （sdk への transitive import を持たせない）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const STATE_DIR_DEFAULT = "backtest/state";
export const STATE_FILE_NAME = "venues-state.json";
export const MANIFEST_FILE_NAME = "manifest.json";
export const REGIMES_DIR = "config/regimes";

// state dump の manifest（配布物の一部。ADR 0016 §2）。
// deployments を丸ごと同梱する = 参加者側で constants.local.ts を再生成できる
// （gen:local-constants の実行を参加者に要求しない）。
export type StateManifest = {
  schema: 1;
  createdAt: string;
  // 生成元の poc コミット（ドリフト検出。不一致は警告）。
  sourceCommit: string;
  anvilVersion: string;
  chainId: number;
  // 生成元 anvil の genesis block hash。--load-state 後に照合し、別 state との
  // 取り違えを fail-fast で検出する。
  genesisHash: string;
  // state 本体のファイル名（manifest からの相対）。
  stateFile: string;
  // deployments の canonical fingerprint。constants.local.ts に刻まれた値と照合する。
  deploymentsFingerprint: string;
  // deployer/deployments/deployments.json の丸ごと埋め込み。
  deployments: Record<string, unknown>;
};

// 鍵順に依存しない canonical JSON（fingerprint の入力を安定化する）。
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deploymentsFingerprint(deployments: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(deployments)).digest("hex")}`;
}

export function validateStateManifest(
  raw: unknown,
  source: string,
): StateManifest {
  const fail = (what: string): never => {
    throw new Error(`invalid state manifest (${source}): ${what}`);
  };
  if (!raw || typeof raw !== "object") fail("not an object");
  const m = raw as Partial<StateManifest>;
  if (m.schema !== 1) fail(`unsupported schema: ${String(m.schema)}`);
  for (const key of [
    "createdAt",
    "sourceCommit",
    "anvilVersion",
    "genesisHash",
    "stateFile",
    "deploymentsFingerprint",
  ] as const) {
    if (typeof m[key] !== "string" || m[key].length === 0)
      fail(`missing ${key}`);
  }
  if (typeof m.chainId !== "number") fail("missing chainId");
  if (!m.deployments || typeof m.deployments !== "object")
    fail("missing deployments");
  const fp = deploymentsFingerprint(m.deployments);
  if (fp !== m.deploymentsFingerprint)
    fail(
      `deploymentsFingerprint mismatch (manifest ${m.deploymentsFingerprint} != computed ${fp})`,
    );
  return m as StateManifest;
}

export function readStateManifest(stateDir: string): {
  manifest: StateManifest;
  statePath: string;
  manifestPath: string;
} {
  const manifestPath = join(stateDir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath))
    throw new Error(
      `state manifest not found: ${manifestPath}。先に \`npm run gen:state-dump\` で ` +
        `state dump を生成する（要: deployer でデプロイ済みの稼働中 anvil）か、` +
        `配布された state ディレクトリを --state で指定してください（ADR 0016 §2）`,
    );
  const manifest = validateStateManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    manifestPath,
  );
  const statePath = join(stateDir, manifest.stateFile);
  if (!existsSync(statePath))
    throw new Error(
      `state file not found: ${statePath}（manifest はあるが state 本体が無い）`,
    );
  return { manifest, statePath, manifestPath };
}

// constants.local.ts に刻まれた fingerprint をテキストで読む。import で読むと module cache に
// stale な constants が残り、再生成後の値がプロセス内に反映されないため正規表現で抜く。
export function readConstantsFingerprint(
  constantsPath: string,
): string | undefined {
  if (!existsSync(constantsPath)) return undefined;
  const text = readFileSync(constantsPath, "utf8");
  const m = text.match(/^export const DEPLOYMENTS_FINGERPRINT = "([^"]+)";$/m);
  return m?.[1];
}

// regime の protocols → deployments.json の protocols キーの対応。
const VENUE_TO_DEPLOYMENT_KEY: Record<string, string> = {
  uniswap: "uniswapV3",
  balancer: "balancerV2",
  curve: "curve",
  gmx: "gmxV2",
  aave: "aaveV3",
};

// regime が要求する venue が state dump（manifest 同梱 deployments）に揃っているか。
// 欠けている venue 名の配列を返す（空 = OK）。ゼロアドレス call の意味不明なエラーで落ちる前に
// fail-fast するための事前検査（ADR 0016 §2）。
export function missingVenues(
  protocols: string[],
  deployments: Record<string, unknown>,
): string[] {
  const deployed = (deployments.protocols ?? {}) as Record<string, unknown>;
  return protocols.filter((p) => {
    const key = VENUE_TO_DEPLOYMENT_KEY[p];
    return key !== undefined && !deployed[key];
  });
}

// --regime の解決: パス表記（/ を含む or .yaml/.yml で終わる）はそのまま、
// 名前は config/regimes/<name>.yaml を引く。見つからなければ利用可能な regime 一覧付きで fail。
export function resolveRegimePath(root: string, regime: string): string {
  const isPath =
    regime.includes("/") || regime.endsWith(".yaml") || regime.endsWith(".yml");
  const candidate = isPath
    ? resolve(root, regime)
    : resolve(root, REGIMES_DIR, `${regime}.yaml`);
  if (existsSync(candidate)) return candidate;
  const dir = resolve(root, REGIMES_DIR);
  const available = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.replace(/\.yaml$/, ""))
        .join(", ") || "(empty)"
    : "(none)";
  throw new Error(
    `regime not found: ${regime} (${candidate})。available: ${available}`,
  );
}
