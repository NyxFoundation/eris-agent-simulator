import { parseUnits, type Address } from "viem";
import { deployerWallet, publicClient, accounts } from "./clients.js";
import { anvilChain, TOKEN_SPECS, INITIAL_MINT } from "./config.js";
import { loadForgeArtifact, waitTx, ok, info } from "./util.js";
import { setTokens, setProtocol } from "./registry.js";

/**
 * Deploy the shared mock tokens.
 * - WETH (key=WETH) deploys WETH9 (supports deposit/withdraw)
 * - The rest deploy MockERC20 and mint an initial balance to the deployer
 * Returns a map of token key -> address.
 */
export async function deployTokens(): Promise<Record<string, Address>> {
  info("Deploying the shared mock tokens");
  const weth9 = loadForgeArtifact("WETH9", "WETH9");
  const erc20 = loadForgeArtifact("MockERC20", "MockERC20");
  const result: Record<string, Address> = {};

  for (const spec of TOKEN_SPECS) {
    if (spec.key === "WETH") {
      const hash = await deployerWallet.deployContract({
        abi: weth9.abi,
        bytecode: weth9.bytecode,
        account: accounts.deployer,
        chain: anvilChain,
        args: [],
      });
      const rc = await waitTx(hash);
      result.WETH = rc.contractAddress as Address;
      ok("WETH9", result.WETH);
      continue;
    }

    const hash = await deployerWallet.deployContract({
      abi: erc20.abi,
      bytecode: erc20.bytecode,
      account: accounts.deployer,
      chain: anvilChain,
      args: [spec.name, spec.symbol, spec.decimals],
    });
    const rc = await waitTx(hash);
    const addr = rc.contractAddress as Address;
    result[spec.key] = addr;

    const mintHuman = INITIAL_MINT[spec.key];
    if (mintHuman) {
      const amount = parseUnits(mintHuman, spec.decimals);
      const mh = await deployerWallet.writeContract({
        address: addr,
        abi: erc20.abi,
        functionName: "mint",
        args: [accounts.deployer.address, amount],
        account: accounts.deployer,
        chain: anvilChain,
      });
      await waitTx(mh);
    }
    ok(`${spec.symbol} (${spec.decimals}d)`, addr);
  }

  // Ensure the deployer has WETH: wrap some ETH
  await wrapWeth(result.WETH, parseUnits("10000", 18));

  setTokens(result);

  // Place Multicall3. On a fork the canonical 0xcA11.. already exists, but an empty anvil
  // does not have it, so deploy our own and record it in the registry (for poc scoring reconstruct / viem multicall).
  await deployMulticall3();

  return result;
}

/** Deploy Multicall3 and record it in registry.common.multicall3 */
async function deployMulticall3() {
  const mc = loadForgeArtifact("Multicall3", "Multicall3");
  const hash = await deployerWallet.deployContract({
    abi: mc.abi,
    bytecode: mc.bytecode,
    account: accounts.deployer,
    chain: anvilChain,
    args: [],
  });
  const rc = await waitTx(hash);
  const addr = rc.contractAddress as Address;
  setProtocol("common", { multicall3: addr });
  ok("Multicall3", addr);
}

/** Deposit the deployer's ETH into WETH9 */
export async function wrapWeth(weth: Address, amount: bigint) {
  const weth9 = loadForgeArtifact("WETH9", "WETH9");
  const hash = await deployerWallet.writeContract({
    address: weth,
    abi: weth9.abi,
    functionName: "deposit",
    value: amount,
    account: accounts.deployer,
    chain: anvilChain,
  });
  await waitTx(hash);
}

export async function balanceOf(
  tokenAddr: Address,
  owner: Address,
): Promise<bigint> {
  const erc20 = loadForgeArtifact("MockERC20", "MockERC20");
  return publicClient.readContract({
    address: tokenAddr,
    abi: erc20.abi,
    functionName: "balanceOf",
    args: [owner],
  }) as Promise<bigint>;
}
