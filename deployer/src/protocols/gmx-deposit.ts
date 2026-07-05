import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeAbiParameters,
  keccak256,
  parseAbiParameters,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { accounts, deployerWallet, publicClient, advance } from "../clients.js";
import { anvilChain } from "../config.js";
import { loadForgeArtifact, waitTx, ok, info } from "../util.js";

// ---------------------------------------------------------------------------
// GMX V2 GM pool liquidity seed.
// The deployer holds CONTROLLER / ORDER_KEEPER via the localhost roles, so it can both create
// the deposit and run the keeper execution by itself. Minimal port of the deposit mechanism from
// test/gmx-e2e.ts for seeding.
// ---------------------------------------------------------------------------

const dep = accounts.deployer;
const EXECUTION_FEE = 30_000_000_000_000_000n; // 0.03 ETH (ample since base-fee is 0)

function hashString(s: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("string"), [s]));
}
const IS_ORACLE_PROVIDER_ENABLED = hashString("IS_ORACLE_PROVIDER_ENABLED");
const ORACLE_PROVIDER_FOR_TOKEN = hashString("ORACLE_PROVIDER_FOR_TOKEN");
const MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR = hashString(
  "MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR",
);

const KEYS = {
  isOracleProviderEnabled: (provider: Address): Hex =>
    keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, address"), [
        IS_ORACLE_PROVIDER_ENABLED,
        provider,
      ]),
    ),
  oracleProviderForToken: (oracle: Address, token: Address): Hex =>
    keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, address, address"), [
        ORACLE_PROVIDER_FOR_TOKEN,
        oracle,
        token,
      ]),
    ),
};

/** Convert a USD price to GMX scale (price * 10^(30 - tokenDecimals)) */
function toGmxPrice(usd: number, tokenDecimals: number): bigint {
  const P = 1_000_000n;
  const usdScaled = BigInt(Math.round(usd * Number(P)));
  return (usdScaled * 10n ** BigInt(30 - tokenDecimals)) / P;
}

const dataStoreAbi = [
  {
    type: "function",
    name: "setBool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "bool" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setAddress",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "address" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setUint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

const mockOracleAbi = [
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "price", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

const depositAddresses = {
  name: "addresses",
  type: "tuple",
  components: [
    { name: "receiver", type: "address" },
    { name: "callbackContract", type: "address" },
    { name: "uiFeeReceiver", type: "address" },
    { name: "market", type: "address" },
    { name: "initialLongToken", type: "address" },
    { name: "initialShortToken", type: "address" },
    { name: "longTokenSwapPath", type: "address[]" },
    { name: "shortTokenSwapPath", type: "address[]" },
  ],
} as const;

const exchangeRouterAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "sendWnt",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sendTokens",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "createDeposit",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          depositAddresses,
          { name: "minMarketTokens", type: "uint256" },
          { name: "shouldUnwrapNativeToken", type: "bool" },
          { name: "executionFee", type: "uint256" },
          { name: "callbackGasLimit", type: "uint256" },
          { name: "dataList", type: "bytes32[]" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const satisfies Abi;

const setPricesParams = {
  name: "oracleParams",
  type: "tuple",
  components: [
    { name: "tokens", type: "address[]" },
    { name: "providers", type: "address[]" },
    { name: "data", type: "bytes[]" },
  ],
} as const;

const depositHandlerAbi = [
  {
    type: "function",
    name: "executeDeposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "bytes32" }, setPricesParams],
    outputs: [],
  },
] as const satisfies Abi;

export type GmDepositCore = {
  DataStore: Address;
  Oracle: Address;
  Router: Address;
  ExchangeRouter: Address;
  DepositVault: Address;
  DepositHandler: Address;
};

export type GmMarket = {
  marketToken: Address;
  longToken: Address;
  shortToken: Address;
};

/** Register the mock provider in the DataStore and set prices (deployer = CONTROLLER) */
async function setupOracle(
  core: GmDepositCore,
  mock: Address,
  prices: { token: Address; usd: number; decimals: number }[],
) {
  const set = async (
    fn: "setBool" | "setAddress" | "setUint",
    args: readonly unknown[],
  ) => {
    const h = await deployerWallet.writeContract({
      address: core.DataStore,
      abi: dataStoreAbi,
      functionName: fn,
      args: args as never,
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  };
  await set("setBool", [KEYS.isOracleProviderEnabled(mock), true]);
  await set("setUint", [
    MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR,
    (1n << 256n) - 1n,
  ]);
  for (const { token, usd, decimals } of prices) {
    await set("setAddress", [
      KEYS.oracleProviderForToken(core.Oracle, token),
      mock,
    ]);
    const h = await deployerWallet.writeContract({
      address: mock,
      abi: mockOracleAbi,
      functionName: "setPrice",
      args: [token, toGmxPrice(usd, decimals)],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }
}

function encExchange(
  functionName: "sendWnt" | "sendTokens" | "createDeposit",
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName,
    args: args as never,
  });
}

/**
 * Deposit liquidity into a GM pool. The deployer is both depositor and keeper executor.
 * longAmount=long token(WETH) / shortAmount=short token(USDC).
 */
export async function seedGmLiquidity(
  core: GmDepositCore,
  market: GmMarket,
  longAmount: bigint,
  shortAmount: bigint,
  prices: { token: Address; usd: number; decimals: number }[],
): Promise<void> {
  info("GMX V2: depositing liquidity into the GM pool");
  const mockArt = loadForgeArtifact("MockOracleProvider", "MockOracleProvider");
  const mockHash = await deployerWallet.deployContract({
    abi: mockArt.abi,
    bytecode: mockArt.bytecode,
    account: dep,
    chain: anvilChain,
  });
  const mock = (await waitTx(mockHash)).contractAddress as Address;
  await setupOracle(core, mock, prices);

  // deployer approves the long/short tokens to the Router (sendTokens does transferFrom via the Router)
  for (const [token, amount] of [
    [market.longToken, longAmount],
    [market.shortToken, shortAmount],
  ] as const) {
    const h = await deployerWallet.writeContract({
      address: token,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [core.Router, amount],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }

  // createDeposit (multicall: execution fee + long + short + createDeposit)
  const params = {
    addresses: {
      receiver: dep.address,
      callbackContract: zeroAddress,
      uiFeeReceiver: zeroAddress,
      market: market.marketToken,
      initialLongToken: market.longToken,
      initialShortToken: market.shortToken,
      longTokenSwapPath: [] as Address[],
      shortTokenSwapPath: [] as Address[],
    },
    minMarketTokens: 0n,
    shouldUnwrapNativeToken: false,
    executionFee: EXECUTION_FEE,
    callbackGasLimit: 0n,
    dataList: [] as Hex[],
  };
  const calls = [
    encExchange("sendWnt", [core.DepositVault, EXECUTION_FEE]),
    encExchange("sendTokens", [
      market.longToken,
      core.DepositVault,
      longAmount,
    ]),
    encExchange("sendTokens", [
      market.shortToken,
      core.DepositVault,
      shortAmount,
    ]),
    encExchange("createDeposit", [params]),
  ];
  const { result, request } = await publicClient.simulateContract({
    address: core.ExchangeRouter,
    abi: exchangeRouterAbi,
    functionName: "multicall",
    args: [calls],
    value: EXECUTION_FEE,
    account: dep,
  });
  const results = result as readonly Hex[];
  const key = decodeAbiParameters(
    [{ type: "bytes32" }],
    results[results.length - 1],
  )[0] as Hex;
  const submitHash = await deployerWallet.writeContract(request as never);
  await waitTx(submitHash);

  // keeper execution (deployer = ORDER_KEEPER). advance so the oracle timestamp is after the order.
  await advance(2);
  const execHash = await deployerWallet.writeContract({
    address: core.DepositHandler,
    abi: depositHandlerAbi,
    functionName: "executeDeposit",
    args: [
      key,
      {
        tokens: prices.map((p) => p.token),
        providers: prices.map(() => mock),
        data: prices.map(() => "0x" as Hex),
      },
    ],
    account: dep,
    chain: anvilChain,
    gas: 20_000_000n,
  });
  await waitTx(execHash);
  ok("GM liquidity deposit", `${market.marketToken} (long+short)`);
}
