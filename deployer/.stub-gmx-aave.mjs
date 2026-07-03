// deployments.json に inert な gmxV2/aaveV3 スタブを追加する（gen:local-constants が全 5 venue を
// 要求するため）。sim は uniswap/balancer/curve のみ有効化するので gmx/aave 定数は一切参照されない。
// deployments.json は gitignore 済みなので diff は残らない。
import { readFileSync, writeFileSync } from "node:fs";
const path = new URL("./deployments/deployments.json", import.meta.url);
const d = JSON.parse(readFileSync(path, "utf8"));
const S = "0x000000000000000000000000000000000000dEaD";
const weth = d.tokens.WETH;
d.protocols.gmxV2 ??= {
  RoleStore: S,
  DataStore: S,
  Oracle: S,
  EventEmitter: S,
  Router: S,
  ExchangeRouter: S,
  OrderHandler: S,
  OrderVault: S,
  LiquidationHandler: S,
  Reader: S,
  Config: S,
  markets: [{ indexToken: weth, marketToken: S }],
};
d.protocols.aaveV3 ??= {
  poolAddressesProvider: S,
  pool: S,
  aaveOracle: S,
  aclManager: S,
  poolDataProvider: S,
};
writeFileSync(path, `${JSON.stringify(d, null, 2)}\n`);
console.log("stubbed gmxV2/aaveV3 into deployments.json (inert; sim uses only uni/bal/curve)");
