# Agent CLI Reference

## Command

```bash
npm run agent -- "<自然语言指令>"
npm run agent -- --json "<自然语言指令>"
npm run agent -- --execute --yes "<已确认的自然语言指令>"
```

Default mode never sends live orders or relayer transactions. It only queries data or prints a plan.

## Supported Intents

Market query:

```bash
npm run agent -- "查询世界杯 德国vs英国 最近一场赔率"
npm run market -- --asset btc --interval 5m --json
npm run market -- "BTC 最近一次 5分钟 涨跌市场" --json
npm run sync:market-constants
```

Position summary:

```bash
npm run agent -- "看一下我现在的仓位"
```

Buy preparation:

```bash
npm run agent -- "买 10 USDC 德国赢"
npm run agent -- "市价买入 10 USDC 德国赢"
npm run agent -- "限价 0.42 买 10 USDC 德国赢"
```

Sell preparation:

```bash
npm run agent -- "德国赢这个仓位全部市价卖出"
npm run agent -- "德国赢 限价 0.7 卖出"
```

Split / merge / redeem preparation:

```bash
npm run agent -- "拆分 germany-world-cup 10"
npm run agent -- "合并 germany-world-cup 10"
npm run split -- -s btc-updown-5m-1778391900 1
npm run merge -- -s btc-updown-5m-1778391900 1
npm run agent -- "赎回德国赢"
```

## Confirmation Checklist

Before executing any fund-changing command, confirm:

- Market title or slug
- Outcome
- Token id or condition id
- Side: buy, sell, split, merge, or redeem
- Amount
- Order kind: market or limit
- Limit price, or estimated market price for market orders

Then run the same request with `--execute --yes`.

If those checklist items were completed across a multi-turn exchange, the final user message is itself the confirmation. For example, after the assistant has resolved `买德国赢` to one exact match market and the user then provides `1万U 市价`, run `npm run agent -- --execute --yes "10000 USDC 市价买入 <resolved-slug> Yes"` directly instead of asking for another confirmation. Ask again only if the new message changes the target, omits a still-required field, or introduces multiple possible markets.

## Notes

- Amounts are interpreted as USDC for buys and split/merge collateral amounts.
- Full-position sells use the current matched position size.
- If matching returns multiple candidates, ask the user to choose a more specific title, slug, outcome, or asset id.
- If `.env` credentials are missing, read-only Gamma/Data queries may still work, but CLOB prices and live actions can fail.
- Tag and World Cup constants live in `references/market-constants.json`; refresh with `npm run sync:market-constants` when matching feels stale.
