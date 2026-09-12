import unittest
from pydantic import ValidationError
from eris import Action
from eris.actions import swap, raw_tx, bundle
from eris.runtime import Context, wire


class SdkTest(unittest.TestCase):
    def test_aliases_defaults_and_large_amounts(self):
        amount = str(2**100)
        action = swap(token_in="USDC", amount_in=amount)
        self.assertEqual(
            wire(action), {"type": "swap", "tokenIn": "USDC", "amountIn": amount}
        )
        self.assertEqual(wire(Action.model_validate(wire(action))), wire(action))

    def test_bundle_accepts_typed_actions(self):
        action = bundle(actions=[swap(token_in="USDC", amount_in="1000000")])
        self.assertEqual(wire(action)["actions"][0]["type"], "swap")

    def test_raw_deployment(self):
        self.assertEqual(
            wire(raw_tx(tx={"data": "0x6000"})),
            {"type": "rawTx", "tx": {"data": "0x6000"}},
        )

    def test_invalid_input_fails_early(self):
        for args in [
            {"token_in": "usdc", "amount_in": "1"},
            {"token_in": "USDC", "amount_in": "-1"},
        ]:
            with self.assertRaises(ValidationError):
                swap(**args)

    def test_expired_context_cannot_emit(self):
        messages = []
        ctx = Context({"id": 1, "agentId": "one", "address": "0x1"}, messages.append)
        ctx.submit(swap(token_in="USDC", amount_in="1"))
        self.assertEqual(messages[0]["id"], 1)
        self.assertNotIn("wallet_client", vars(ctx))
        ctx._active = False
        with self.assertRaisesRegex(RuntimeError, "expired"):
            ctx.log({"reason": "too late"})


if __name__ == "__main__":
    unittest.main()
