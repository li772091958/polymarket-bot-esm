---
name: polymarket-operator
description: Operate this repository's Polymarket tooling from natural-language requests. Use when the user asks in Chinese or English to query Polymarket markets or odds, inspect current positions and PnL, prepare or execute buy/sell orders, market-sell a position, split collateral into outcome tokens, merge outcome tokens, redeem settled positions, or otherwise manage this project's Polymarket account. This skill is project-local and may call this repository's code and npm scripts.
---

# Polymarket Operator

## Core Rule

Use this skill only inside this repository. Prefer the project CLI and modules over ad hoc API code.

Never place a live order, split, merge, or redeem from an ambiguous request. For any action that changes funds or positions:

1. Resolve the market, outcome, side, amount, order type, and price/slippage context.
2. Show the user the exact matched target and estimated market price when applicable.
3. Ask for confirmation if anything is missing or ambiguous.
4. Execute only after explicit confirmation, using `--execute --yes`.

Read-only actions such as market queries and position summaries may run immediately.

If a multi-turn exchange has already resolved a unique fund-changing action, do not ask for one more generic confirmation. For example, if the user first says `买德国赢`, the skill resolves and shows the latest Germany World Cup match win market, then the user supplies the missing amount and says `市价` or gives a limit price, the market, outcome, side, amount, and order type are now fully confirmed. Run the exact `npm run agent -- --execute --yes ...` command immediately. Only ask again if the newly supplied information conflicts with the resolved plan or creates multiple possible targets.

When displaying FIFA World Cup match markets, always show Chinese team names alongside the English names, for example `德国(Germany) vs. 库拉索(Curaçao)`. If the CLI JSON includes `eventTitleZh` or `titleZh`, use those fields for display.

## Project CLI

Use:

```bash
npm run agent -- "<natural language request>"
```

This command defaults to read-only behavior or a non-executing plan. It can:

- Query markets and odds: `npm run agent -- "查询世界杯 德国vs英国 最近一场赔率"`
- Fast crypto up/down lookup: `npm run market -- --asset btc --interval 5m --json`
- Refresh tag and World Cup constants: `npm run sync:market-constants`
- Refresh FIFA World Cup game schedule cache: `npm run sync:worldcup-games`
- Summarize positions and PnL: `npm run agent -- "看一下我现在的仓位"`
- Prepare buys: `npm run agent -- "买 10 USDC 德国赢"`
- Prepare sells: `npm run agent -- "德国赢这个仓位全部市价卖出"`
- Prepare split / merge / redeem: natural language containing `拆分`, `合并`, or `赎回`

Use JSON output when you need structured parsing:

```bash
npm run agent -- --json "<request>"
```

For detailed CLI behavior, examples, and safety rules, see `references/agent-cli.md`.

## Trade Workflow

For buy requests:

- If the user did not specify market vs limit, ask: “是市价买入，还是限价买入？如果限价，请给价格。”
- If there is no relevant context and the user says to buy a country to win, such as `买德国赢`, treat it as that country's latest FIFA World Cup match win market, not the outright winner market. First query the latest matching game through the Redis-backed World Cup game index, display the matched event, Chinese and English team names, the `Yes` price from `outcomePrices`, and ask the user to confirm amount plus market/limit price before placing any order.
- If that context already exists from the immediately preceding assistant response and the user supplies the remaining amount plus `市价`, `market`, or a limit price, execute directly with the previously resolved market slug and outcome. Do not run a fresh broad search and do not ask “确认下单吗” again.
- Interpret natural amount phrases such as `10 USDC`, `30万`, and `三千万` as USDC not token count.
- For limit buys, the CLI converts USDC amount to outcome-token size using `size = amount / price`.
- For market buys, get the estimated market price before execution.

For sell requests:

- Match against current positions, not open markets.
- If multiple positions match, ask the user to choose by title/outcome/asset id.
- For market sells, make sure the CLI returns an estimated executable market price before asking for final confirmation.
- Use existing sell logic through `runSell`, which sells the full matched position.

For split / merge / redeem:

- Use `npm run market` first for crypto up/down markets such as “BTC 最近一次 5分钟 涨跌市场”; do not rely on broad market search for these high-frequency slugs.
- Resolve the target condition id through market search unless the user provided a direct condition id.
- For FIFA World Cup game/match queries, use the repository agent/query methods. They first match against the Redis-backed `polymarket:worldcup:games:v1` schedule index, then fetch the matched event by slug and flatten `event.markets`; individual game moneyline markets may not be discoverable through `/markets` alone.
- For FIFA World Cup two-team matchup queries such as `德国和英国最近一场比赛`, require both teams to match the same cached event. If there is no cached event containing both teams, report no match instead of falling back to outright/futures markets.
- For FIFA World Cup outright queries such as `德国夺冠概率`, use the generated World Cup winner constants to jump directly to the winner market, then display the `Yes` probability from `outcomePrices`. Buy requests for `德国夺冠` should resolve to the `Yes` outcome of that market.
- For FIFA World Cup cache maintenance, natural-language requests like `更新世界杯相关的索引缓存` should run the agent cache-refresh path or `npm run sync:worldcup-games`.
- For redeem, operate only on redeemable positions.
- Treat relayer transactions as live fund-changing actions requiring confirmation.

## Execution

Only after the user confirms the exact plan, run:

```bash
npm run agent -- --execute --yes "<confirmed natural language request>"
```

Do not use `--execute --yes` for the user's first ambiguous sentence. If the user confirms in a later message with enough information to make the previously resolved operation unique, execute immediately. The later message can be terse, such as `市价`, `限价 0.42`, `1万U 市价`, or `下单`, as long as the conversation context already contains the exact market/outcome/side/amount/order type needed to build the command.

## Existing Scripts

Prefer these existing commands when they fit exactly:

- `npm run sell <asset-or-title> [-p price]` for manual full-position sell.
- `npm run split -- -s <slug> <amount>` or `npm run split -- -c <conditionId> <amount>` for direct split.
- `npm run merge -- -s <slug> <amount>` or `npm run merge -- -c <conditionId> <amount>` for direct merge.
- `npm run market -- --asset btc --interval 5m --json` for fast crypto up/down market lookup.
- `npm run cashout` for the existing high-price sell / redeem cycle.

The natural-language agent wraps these capabilities and adds matching, quoting, and confirmation discipline.

## Constants

Market tag and World Cup matching constants are generated into:

- `src/polymarket/generated/marketConstants.ts` for code.
- `.codex/skills/polymarket-operator/references/market-constants.json` for skill reference.

Refresh them with:

```bash
npm run sync:market-constants
```

Use these constants before broad market search when a request includes known tags, World Cup, teams, `夺冠`, or `冠军`.
