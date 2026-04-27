# Polymarket Copy Trade Bot

Languages:

- [中文版](#中文版)
- [English Version](#english-version)

## 中文版

一个基于 Polymarket CLOB API 的跟单机器人。程序会定时读取目标地址的持仓，按策略过滤后，对自己的账户执行建仓或加仓，并在成功成交后通过 Server 酱推送通知。

### 主要功能

- 定时扫描目标钱包持仓，当前默认每 1 分钟执行一轮。
- 支持按持仓价值、均价、现价等条件过滤目标仓位。
- 支持固定额度或按目标仓位动态计算跟单额度。
- 每轮执行前都会查询自己的最新仓位，根据剩余额度决定是否建仓或加仓。
- 如果检测到某个资产上轮自己持有、本轮已经没有，视为手动清仓，短期内不再买入该资产。
- 支持 dry run 模拟交易，不真实下单。
- 支持成功成交后通过 Server 酱推送订单详情和返回结果。
- 支持 PM2 运行编译后的 `dist/index.js`。

### 技术栈

- Node.js + TypeScript + ESM
- Effect：组织异步流程、错误处理和重试
- `@polymarket/clob-client-v2`：Polymarket CLOB 下单与市场信息
- Axios：HTTP 请求
- Redis：项目内通用缓存/存储封装
- PM2：生产进程管理

### 目录结构

```text
src/
  copyTrade.ts              跟单策略与主循环
  index.ts                  程序入口
  polymarket/api.ts         Polymarket API 与 CLOB Client
  middleware/
    axios.ts                Axios 实例
    logger.ts               日志模块
    notify.ts               Server 酱推送
    RedisService.ts         Redis 封装
  types.ts                  类型定义
ecosystem.config.cjs        PM2 配置
.env.exmple                 环境变量示例
```

### 使用步骤

1. 安装依赖

```bash
npm install
```

2. 创建环境变量文件

```bash
cp .env.exmple .env
```

然后在 `.env` 中填入自己的私钥、funder 地址、CLOB API 凭证等配置。

3. 开发模式运行

```bash
npm run dev
```

4. 编译

```bash
npm run build
```

5. 运行编译后的文件

```bash
npm start
```

6. 使用 PM2 运行

```bash
npm run build
pm2 start ecosystem.config.cjs
```

常用 PM2 命令：

```bash
pm2 logs polymarket-copy-trade
pm2 restart polymarket-copy-trade
pm2 stop polymarket-copy-trade
```

### 配置文件说明

`.env` 不会被 Git 跟踪，请只在本地或服务器上保存真实值。

| 变量 | 说明 |
| --- | --- |
| `PRIVATE_KEY` | 下单钱包私钥 |
| `FUNDER` | Polymarket funder/proxy wallet 地址 |
| `CLOB_HOST` | Polymarket CLOB API 地址，默认可使用 `https://clob-v2.polymarket.com` |
| `GAMMA_HOST` | Gamma API 地址 |
| `CHAIN_ID` | 链 ID，Polygon 为 `137` |
| `CLOB_API_KEY` | CLOB API key |
| `CLOB_SECRET` | CLOB API secret |
| `CLOB_PASS_PHRASE` | CLOB API passphrase |
| `POLY_BUILDER_CODE` | 可选，builder code |
| `ENABLE_AGENT` | 是否启用代理配置 |
| `AGENT_PROTOCOL` | 代理协议，例如 `http` |
| `AGENT_HOST` | 代理地址 |
| `AGENT_PORT` | 代理端口 |
| `SERVER_CHAN_KEYS` | Server 酱 SendKey，多个 key 用英文逗号分隔 |
| `DRY_RUN` | 设置为 `1`、`true`、`yes` 或 `on` 时只模拟交易，不真实下单 |

`.env.exmple` 中还保留了一些备用配置项，例如 RPC、Influx、Relayer 等，目前主流程不一定都会使用。

### 策略配置

跟单策略位于 `src/copyTrade.ts` 的 `STRATEGY` 数组中。每个策略包含：

- `enable`：是否启用策略。
- `address`：目标跟单钱包地址。
- `nickname`：策略名称，用于日志和通知。
- `filter`：目标持仓过滤函数。
- `amount`：跟单额度，可以是固定数字，也可以是根据目标仓位动态计算的函数。
- `dryRun`：策略级模拟交易开关。

下单逻辑会用 `amount - 自己当前该资产 initialValue` 计算剩余额度。若剩余额度在 `0.6` 到 `1` 之间，会按 `1 USDC` 下单；若小于等于 `0.6`，则跳过。

### 风控与错误处理

- 每轮策略执行前会先查询自己的仓位；如果查询失败，本轮策略会跳过，不会继续下单。
- 数据 API 的 502 错误会自动重试，重试后仍失败会记录日志并等待下一轮。
- 手动清仓的资产会进入内存黑名单，默认保留 2 天，避免清仓后又被策略买回。
- 真实下单成功后才会发送推送；推送失败只记录日志，不影响主流程。

### 日志

日志默认写入 `logs/` 目录，同时输出到控制台。`logs/` 已在 `.gitignore` 中忽略。

### 隐私与安全

- 不要提交 `.env`、私钥、API key、真实 RPC token 或 Server 酱 key。
- `.gitignore` 已忽略 `.env`、`.env.*`、`node_modules/`、`dist/`、`logs/`、`.vscode/` 等本地文件。
- 建议先用 `DRY_RUN=true` 观察日志，确认策略符合预期后再开启真实交易。

### 免责声明

本项目仅用于自动化交易研究和个人工具使用。预测市场交易存在风险，任何策略都可能亏损。请确认你理解相关风险，并自行承担交易结果。

## English Version

A copy-trading bot built on top of the Polymarket CLOB API. It periodically reads positions from target wallets, filters them with configurable strategies, opens or scales into matching positions for your own account, and sends a ServerChan notification after a successful fill.

### Features

- Periodically scans target wallet positions. The default cycle interval is 1 minute.
- Filters target positions by position value, average price, current price, and custom rules.
- Supports fixed copy amount or dynamic amount calculation based on each target position.
- Fetches your latest positions before every strategy cycle and decides whether to open or scale in based on remaining allocation.
- Treats a position that existed in the previous cycle but disappeared in the current cycle as a manual close, and temporarily prevents buying it again.
- Supports dry run mode for simulation without placing real orders.
- Sends order details and CLOB responses through ServerChan after successful real fills.
- Supports running compiled `dist/index.js` with PM2.

### Tech Stack

- Node.js + TypeScript + ESM
- Effect for async workflows, typed errors, and retries
- `@polymarket/clob-client-v2` for Polymarket CLOB market data and orders
- Axios for HTTP requests
- Redis wrapper for project-level cache/storage utilities
- PM2 for production process management

### Project Structure

```text
src/
  copyTrade.ts              Copy-trading strategy and main loop
  index.ts                  Application entry point
  polymarket/api.ts         Polymarket API and CLOB Client
  middleware/
    axios.ts                Axios instance
    logger.ts               Logger
    notify.ts               ServerChan notification
    RedisService.ts         Redis wrapper
  types.ts                  Type definitions
ecosystem.config.cjs        PM2 configuration
.env.exmple                 Environment variable example
```

### Getting Started

1. Install dependencies

```bash
npm install
```

2. Create your local environment file

```bash
cp .env.exmple .env
```

Then fill `.env` with your private key, funder address, CLOB API credentials, and other required values.

3. Run in development mode

```bash
npm run dev
```

4. Build

```bash
npm run build
```

5. Run the compiled output

```bash
npm start
```

6. Run with PM2

```bash
npm run build
pm2 start ecosystem.config.cjs
```

Common PM2 commands:

```bash
pm2 logs polymarket-copy-trade
pm2 restart polymarket-copy-trade
pm2 stop polymarket-copy-trade
```

### Environment Variables

`.env` is ignored by Git. Keep real secrets only on your local machine or server.

| Variable | Description |
| --- | --- |
| `PRIVATE_KEY` | Private key of the wallet used for signing orders |
| `FUNDER` | Polymarket funder/proxy wallet address |
| `CLOB_HOST` | Polymarket CLOB API host, usually `https://clob-v2.polymarket.com` |
| `GAMMA_HOST` | Gamma API host |
| `CHAIN_ID` | Chain ID. Polygon is `137` |
| `CLOB_API_KEY` | CLOB API key |
| `CLOB_SECRET` | CLOB API secret |
| `CLOB_PASS_PHRASE` | CLOB API passphrase |
| `POLY_BUILDER_CODE` | Optional builder code |
| `ENABLE_AGENT` | Whether to enable proxy settings |
| `AGENT_PROTOCOL` | Proxy protocol, for example `http` |
| `AGENT_HOST` | Proxy host |
| `AGENT_PORT` | Proxy port |
| `SERVER_CHAN_KEYS` | ServerChan SendKeys, separated by commas |
| `DRY_RUN` | Set to `1`, `true`, `yes`, or `on` to simulate without placing real orders |

`.env.exmple` also contains several optional or reserved values such as RPC, Influx, and Relayer settings. Not all of them are used by the current main flow.

### Strategy Configuration

Strategies are defined in the `STRATEGY` array in `src/copyTrade.ts`. Each strategy contains:

- `enable`: whether the strategy is active.
- `address`: target wallet address to follow.
- `nickname`: strategy display name used in logs and notifications.
- `filter`: function used to filter target positions.
- `amount`: copy amount, either a fixed number or a dynamic function based on the target position.
- `dryRun`: strategy-level simulation switch.

The order amount is calculated as `amount - current initialValue of your own position`. If the remaining amount is between `0.6` and `1`, the bot rounds it up to `1 USDC`; if it is `0.6` or lower, the bot skips the order.

### Risk Control and Error Handling

- The bot fetches your own positions before every strategy cycle. If that request fails, the whole cycle is skipped and no orders are placed.
- Data API 502 errors are retried automatically. If retries still fail, the error is logged and the bot waits for the next cycle.
- Manually closed assets are kept in an in-memory blocklist for 2 days by default, preventing the bot from buying them back too soon.
- Notifications are sent only after real successful orders. Notification failures are logged and do not stop the trading loop.

### Logs

Logs are written to the `logs/` directory and also printed to the console. `logs/` is ignored by Git.

### Privacy and Security

- Never commit `.env`, private keys, API keys, real RPC tokens, or ServerChan keys.
- `.gitignore` excludes `.env`, `.env.*`, `node_modules/`, `dist/`, `logs/`, `.vscode/`, and other local files.
- It is strongly recommended to start with `DRY_RUN=true` and inspect logs before enabling real trading.

### Disclaimer

This project is intended for automated trading research and personal tooling. Prediction market trading involves risk, and any strategy may lose money. Make sure you understand the risks and take full responsibility for your own trading results.
