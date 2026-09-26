<!-- 参加者へ送る文面のドラフト。<> の箇所を差し替えて使う。
     共通トークンの値はここには書かない（このファイルは git に入る）。台帳から転記すること。
     台帳: ~/ascon-participant-tokens/ASCON_RPCキー台帳.xlsx（Drive にも同じもの） -->

# ASCON 試行環境への接続情報

<チーム名> 様

試行環境の接続情報をお送りします。**この期間のスコアは競技結果には入りません。**
動作確認と、本番と同じ環境で手元のエージェントを回していただくためのものです。

---

## 1. 接続先

| | |
|---|---|
| RPC エンドポイント | `https://ascon-rpc.nyx.foundation/` |
| chainId | `31337` (`0x7a69`) |
| ブロック生成 | 2 秒ごと |
| ダッシュボード | https://ascon-dash.nyx.foundation （認証不要） |
| ブロックエクスプローラ | https://ascon-explorer.nyx.foundation （認証不要） |

## 2. 認証情報（ヘッダ3つ）

RPC には **HTTP ヘッダを3つ**付けてください。1つでも欠けると `403` になります。

```
X-ASCON-Key:             <貴チーム専用のキー>
CF-Access-Client-Id:     <共通のCLIENT_ID（台帳「使い方」シート参照）>
CF-Access-Client-Secret: <共通のCLIENT_SECRET（台帳「使い方」シート参照）>
```

- **`X-ASCON-Key` は貴チーム専用**です。他チームと共有しないでください。
  これが利用ログとレート制限の単位なので、共有すると互いの上限を食い合います。
- 下2つは**全チーム共通**です。手前の Cloudflare を通るためのもので、身元はキーの方で見ています。

> 発行直後の1分ほどは `403` を返すことがあります。Cloudflare 側への反映待ちなので、
> 少し置いてからお試しください。

## 3. 疎通確認

```sh
export ASCON_KEY='<貴チーム専用のキー>'
export CF_ID='<共通のCLIENT_ID（台帳「使い方」シート参照）>'
export CF_SECRET='<共通のCLIENT_SECRET（台帳「使い方」シート参照）>'

curl -s -X POST https://ascon-rpc.nyx.foundation/ \
  -H "X-ASCON-Key: $ASCON_KEY" \
  -H "CF-Access-Client-Id: $CF_ID" \
  -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "content-type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

`{"jsonrpc":"2.0","id":1,"result":"0x..."}` が返れば成功です。数秒おいて再実行し、
数値が増えていればチェーンが動いています。

## 4. ウォレットを作ってアドレスを登録する

試行環境に faucet はありません。**取引用の資産は、運営がアドレスを登録したときに配布されます**
（登録したアドレスには全員同じ額を 1 回だけ配ります）。まずご自身の鍵を作ってください。

**鍵の作り方**（どちらか一方。リポジトリの直下で実行）

```sh
cast wallet new                      # Foundry。Address と Private key が表示されます

node --input-type=module -e "import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const key = generatePrivateKey(); console.log('address', privateKeyToAccount(key).address); console.log('key    ', key)"
```

- **秘密鍵（Private key）は手元だけに置いてください。**エージェントの起動時に
  `ERIS_AGENT_PRIVATE_KEY` として渡すものです。リポジトリの外のファイル（`chmod 600`）などに保管し、
  **運営を含め誰にも送らないでください。**運営から秘密鍵を尋ねることはありません。
- 試行環境専用の新しい鍵を作ってください。実際の資産が入っている鍵は使わないでください。

**アドレスを Discord で共有する**

参加登録時に参加した Discord の ASCON チャンネルに、次の形で投稿してください。

```
team:     <チーム名>
agent id: <エージェントの表示名。英小文字・数字・ハイフン>
address:  0x…
```

投稿するのは**アドレスだけ**です（アドレスは公開情報で、ダッシュボードやエクスプローラにも表示されます）。
秘密鍵を誤って投稿した場合、その鍵は使えなくなります。新しい鍵を作り直してください。

**このあとの流れ**

1. 運営がアドレスを登録します。登録から**約 1 分**で、ガス用の ETH と取引用の資産が入金されます。
   金額は `manifest.json` の `funding`（`ethWei` / `wethWei` / `usdcUnits` / `wbtcUnits`）です。
2. 入金は §3 と同じヘッダで確認できます（`eth_blockNumber` を
   `"method":"eth_getBalance","params":["0x<アドレス>","latest"]` に置き換えて実行）。
   ダッシュボードの「自分のエージェントを探す」にアドレスを入れても確認できます。
3. 練習用の順位には**登録の翌日から**載ります（登録した日はその日の開始時点の残高がないため、
   0 点ではなく採点対象外として扱います）。

- **2 体目のエージェント**を動かす場合は、鍵をもう 1 つ作って同じ形で投稿してください。
- **アドレスを変える・最初からやり直す**場合は、新しい鍵と**新しい agent id** で投稿してください
  （登録は追加のみで、既存の agent id のアドレスは変更できません）。

## 5. コードから使う

ヘッダを付けられる HTTP トランスポートなら何でも構いません。

**viem**

```ts
import { createPublicClient, http, defineChain } from "viem";

const ascon = defineChain({
  id: 31337,
  name: "ASCON practice",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://ascon-rpc.nyx.foundation/"] } },
});

const client = createPublicClient({
  chain: ascon,
  transport: http("https://ascon-rpc.nyx.foundation/", {
    fetchOptions: {
      headers: {
        "X-ASCON-Key": process.env.ASCON_KEY!,
        "CF-Access-Client-Id": process.env.CF_ID!,
        "CF-Access-Client-Secret": process.env.CF_SECRET!,
      },
    },
  }),
});
```

**ethers v6**

```ts
import { JsonRpcProvider, FetchRequest } from "ethers";

const req = new FetchRequest("https://ascon-rpc.nyx.foundation/");
req.setHeader("X-ASCON-Key", process.env.ASCON_KEY!);
req.setHeader("CF-Access-Client-Id", process.env.CF_ID!);
req.setHeader("CF-Access-Client-Secret", process.env.CF_SECRET!);
const provider = new JsonRpcProvider(req, 31337);
```

## 6. 使えるメソッドと使えないメソッド

標準的な `eth_` / `net_` / `web3_` が使えます。仕様はこちらをご参照ください。

- **JSON-RPC の一覧と各メソッドの引数・戻り値**
  https://ethereum.org/en/developers/docs/apis/json-rpc/
- **正式な仕様（OpenRPC）**
  https://github.com/ethereum/execution-apis
- **ブラウザで試せるプレイグラウンド**
  https://ethereum-json-rpc.com
- viem: https://viem.sh ／ ethers: https://docs.ethers.org/v6/

**通らないもの**（403 `method not permitted` を返します）

| 種類 | 例 | 理由 |
|---|---|---|
| チートコード | `anvil_setBalance`, `evm_mine`, `evm_setNextBlockTimestamp` | 残高や時間を書き換えられると競技が成立しません |
| ノードの鍵を使うもの | `eth_sendTransaction`, `eth_accounts`, `eth_sign` | 署名は各自の鍵でお願いします |
| mempool の覗き見 | `txpool_*`, `eth_subscribe` | 他チームの注文が見えてしまうため |

**送信は `eth_sendRawTransaction` を使ってください。** 署名は手元で行い、署名済みの raw を投げる形です。

## 7. 制限

| | |
|---|---|
| レート | 100 req/秒（バースト 300）。貴チーム専用のキー単位です |
| 1 トランザクションのガス上限 | 30,000,000 |
| ブロックのガス上限 | 320,000,000 |

`eth_call` / `eth_estimateGas` / `eth_getLogs` など EVM を実行する読み取りは 5 回分として数えます。
上限を超えると `429` を返しますが、しばらく待てば回復します。

## 8. 環境マニフェスト

venue のアドレス・トークンのアドレス・PriceFeed・評価区間の長さは、添付の
`manifest.json` に入っています。アドレスをコードに直接書かず、こちらを読んでください。

## 9. 困ったとき

| 症状 | 確認すること |
|---|---|
| `403` / `missing or unknown X-ASCON-Key` | キーの綴り。発行直後なら1分ほど待つ |
| `403`（HTMLが返る） | `CF-Access-*` の2つが付いているか |
| `403 method not permitted` | §6 の表。そのメソッドは意図的に塞いでいます |
| `429` | レート上限。間隔を空けてください |
| 残高が0 | §4 のアドレスを Discord に投稿済みか。投稿済みで反映がなければ、アドレスを添えてご連絡ください |

ご不明な点は <連絡先> までお願いします。
