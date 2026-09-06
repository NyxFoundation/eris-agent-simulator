// vault-keeper (issue #40 phase 4): the honest creator of a buggy contract.
//
// It is the target the exploit-hunter hunts, and the counterpart to trap-launcher: both deploy a
// contract and put value in it, but this one is not a trap. It deploys `LeakyVault` — a vault whose
// deposit / withdraw is correct — supplies its own USDC, and intends to withdraw before the bell.
// It has no idea the vault's `rescue()` is un-gated. That is the whole point of an *honest* victim:
// the mistake is in the code it shipped, not in what it meant to do.
//
// Under the round-trip rule its exposure is real. USDC sitting in the vault is worth zero to it at
// the epoch's final block, so its plan is to round-trip out with `EXIT_BLOCKS` to spare. If a hunter
// drains the vault first, the withdrawal reverts (no balance), and the keeper is left holding the
// zero-scored stranded position — which is exactly the loss, and exactly the transfer the hunter's
// gain is the other side of.
//
// Self-driven (`run(ctx)`, ADR 0015 §3): deploy, wait for the address, deposit, hold, withdraw.
import type { Address } from "viem";
import { encodeFunctionData } from "viem";
import type { AgentContext, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  currentNonce,
  deployAction,
  findDeployedContracts,
} from "../lib/deployContract.js";
import { blocksLeft, bps } from "../lib/agentMarkets.js";

// Share of the USDC balance the keeper puts to work in its vault.
const DEPOSIT_BPS = Number(process.env.ERIS_VAULT_DEPOSIT_BPS ?? "4000");
// Start withdrawing this many blocks before the end; the withdrawal needs a block to land.
const EXIT_BLOCKS = Number(process.env.ERIS_VAULT_EXIT_BLOCKS ?? "12");

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
] as const;

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const vaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "withdrawAll",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "shares",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

type Phase = "deploy" | "await-deploy" | "deposit" | "holding" | "exiting" | "done";

export async function run(ctx: AgentContext): Promise<void> {
  const self = ctx.address;
  let phase: Phase = "deploy";
  let vault: Address | undefined;
  let nonceBeforeDeploy = 0;
  let busy = false;

  ctx.onObservation((obs) => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        await step(obs);
      } catch (error) {
        ctx.log({
          round: obs.round,
          reason: `vault-keeper error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        busy = false;
      }
    })();
  });

  async function step(obs: AgentObservation): Promise<void> {
    if (phase === "done") return;
    const fee = obs.limits?.defaultPriorityFeePerGasWei;

    switch (phase) {
      case "deploy": {
        nonceBeforeDeploy = await currentNonce(ctx.publicClient, self);
        ctx.submit(
          deployAction("LeakyVault", [TOKENS.USDC.address], {
            reason: "deploying a USDC vault",
            maxPriorityFeePerGasWei: fee,
          }),
        );
        ctx.log({
          round: obs.round,
          reason: "deploying a LeakyVault (it does not know rescue() is un-gated)",
          state: { kind: "vault_keeper_deploy", nonce: nonceBeforeDeploy },
        });
        phase = "await-deploy";
        return;
      }
      case "await-deploy": {
        const found = await findDeployedContracts(ctx.publicClient, self, {
          fromNonce: nonceBeforeDeploy,
          toNonce: nonceBeforeDeploy + 2,
        });
        if (found.length === 0) return;
        vault = found[0];
        ctx.log({
          round: obs.round,
          reason: `vault deployed at ${vault}`,
          state: { kind: "vault_keeper_deployed", vault },
        });
        phase = "deposit";
        return;
      }
      case "deposit": {
        if (!vault) {
          phase = "await-deploy";
          return;
        }
        const amount = bps(BigInt(obs.balances.usdcUnits), DEPOSIT_BPS);
        if (amount <= 0n) {
          phase = "holding";
          return;
        }
        // approve then deposit, in one bundle so the deposit sees the allowance. Both are the
        // keeper's own calls to its own contract; the exact-amount approval is the keeper being
        // careful, not the runtime forcing it.
        ctx.submit({
          type: "rawBundle",
          txs: [
            {
              to: TOKENS.USDC.address,
              data: encodeFunctionData({
                abi: erc20ApproveAbi,
                functionName: "approve",
                args: [vault, amount],
              }),
            },
            {
              to: vault,
              data: encodeFunctionData({
                abi: vaultAbi,
                functionName: "deposit",
                args: [amount],
              }),
            },
          ],
          maxPriorityFeePerGasWei: fee,
        } as Record<string, unknown>);
        ctx.log({
          round: obs.round,
          reason: `depositing ${amount} USDC into the vault`,
          state: { kind: "vault_keeper_deposit", vault, amount: amount.toString() },
        });
        phase = "holding";
        return;
      }
      case "holding": {
        if (blocksLeft(obs) > EXIT_BLOCKS) return;
        phase = "exiting";
        return;
      }
      case "exiting": {
        if (!vault) {
          phase = "done";
          return;
        }
        // What the vault holds is the honest question, not what shares the keeper has. If a hunter
        // drained it the keeper still holds shares, but `withdrawAll` would burn them for nothing --
        // so a `shares > 0` check would call that a successful exit. Read the vault's balance too.
        const [owned, vaultBal] = (await Promise.all([
          ctx.publicClient
            .readContract({ address: vault, abi: vaultAbi, functionName: "shares", args: [self] })
            .catch(() => 0n),
          ctx.publicClient
            .readContract({
              address: TOKENS.USDC.address,
              abi: erc20BalanceAbi,
              functionName: "balanceOf",
              args: [vault],
            })
            .catch(() => 0n),
        ])) as [bigint, bigint];
        if (owned > 0n && vaultBal > 0n && blocksLeft(obs) > 1) {
          ctx.submit({
            type: "rawTx",
            tx: {
              to: vault,
              data: encodeFunctionData({
                abi: vaultAbi,
                functionName: "withdrawAll",
                args: [],
              }),
            },
            maxPriorityFeePerGasWei: fee,
          } as Record<string, unknown>);
          ctx.log({
            round: obs.round,
            reason: `round-tripping out of the vault with ${blocksLeft(obs)} blocks left`,
            state: { kind: "vault_keeper_exit", vault },
          });
          return;
        }
        // "exited" only when there was something to exit *with*. Shares against an empty vault means
        // it was drained -- the keeper is left at the zero-scored stranded deposit, which is the
        // loss, and the finding.
        const drained = owned > 0n && vaultBal === 0n;
        ctx.log({
          round: obs.round,
          reason: drained
            ? "could not exit: the vault was drained before the bell"
            : "exited",
          state: {
            kind: "vault_keeper_done",
            vault,
            drained,
            strandedShares: owned.toString(),
          },
        });
        phase = "done";
        return;
      }
    }
  }
}
