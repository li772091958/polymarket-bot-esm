import { OrderType, Side, type TickSize } from '@polymarket/clob-client-v2';
import { Effect } from 'effect';
import * as readline from 'node:readline';
import { ApiError, cbc, getPositions } from './polymarket/api.js';
import type { Position } from './types.js';

class SellMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SellMatchError';
  }
}

export type SellOptions = {
  price?: number;
  size?: number;
  ratio?: number;
};

const normalize = (value: string) => value.trim().toLowerCase();

const formatPosition = (position: Position) => ({
  title: position.title,
  outcome: position.outcome,
  asset: position.asset,
  size: position.size,
  curPrice: position.curPrice,
  currentValue: position.currentValue,
});

const printPosition = (label: string, position: Position) => {
  console.log(label);
  console.table(formatPosition(position));
};

const formatPositionLine = (position: Position) =>
  `${position.title} | ${position.outcome} | size=${position.size} | cur=${position.curPrice} | ${position.asset}`;

const truncateLine = (line: string) => {
  const columns = process.stdout.columns || 120;
  const maxLength = Math.max(20, columns - 1);

  return line.length > maxLength ? `${line.slice(0, maxLength - 3)}...` : line;
};

const roundDown = (value: number, decimals: number) =>
  Math.floor(value * 10 ** decimals) / 10 ** decimals;

const resolveSellSize = (position: Position, options: SellOptions = {}) => {
  const size = Number(position.size);
  if (!Number.isFinite(size) || size <= 0) {
    throw new SellMatchError(`Invalid position size: ${position.size}`);
  }

  if (options.size !== undefined && options.ratio !== undefined) {
    throw new SellMatchError('Cannot specify both size and ratio');
  }

  const rawSellSize =
    options.size !== undefined
      ? options.size
      : options.ratio !== undefined
        ? size * options.ratio
        : size;

  if (!Number.isFinite(rawSellSize) || rawSellSize <= 0) {
    throw new SellMatchError(`Invalid sell size: ${rawSellSize}`);
  }

  if (rawSellSize > size) {
    throw new SellMatchError(`Sell size exceeds position size: ${rawSellSize} > ${size}`);
  }

  const roundedSize = roundDown(rawSellSize, 2);
  if (roundedSize <= 0) {
    throw new SellMatchError(`Sell size is too small after rounding: ${rawSellSize}`);
  }

  return roundedSize;
};

const formatCause = (cause: unknown) => {
  if (!(cause instanceof Error)) return String(cause);
  return cause.stack || cause.message;
};

const selectPositionWithKeyboard = (positions: Position[], keyword: string) =>
  new Promise<Position>((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(
        new SellMatchError(
          [
            `模糊匹配到多个持仓，但当前终端不支持键盘选择: ${keyword}`,
            ...positions.map(position => `- ${formatPositionLine(position)}`),
          ].join('\n')
        )
      );
      return;
    }

    let selectedIndex = 0;
    const wasRaw = process.stdin.isRaw;
    let hasRendered = false;

    const cleanupInput = () => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write('\x1B[?25h');
    };

    const renderOptions = () => {
      if (hasRendered) {
        readline.moveCursor(process.stdout, 0, -positions.length);
      } else {
        process.stdout.write(
          `模糊匹配到多个持仓，请选择要清仓的仓位: ${keyword}\n上下键选择，Enter 确认，Ctrl+C 取消\n\n`
        );
        hasRendered = true;
      }

      positions.forEach((position, index) => {
        const selected = index === selectedIndex;
        const prefix = selected ? '> ' : '  ';
        const line = truncateLine(`${prefix}${formatPositionLine(position)}`);

        readline.clearLine(process.stdout, 0);
        process.stdout.write(selected ? `\x1B[7m${line}\x1B[0m\n` : `${line}\n`);
      });
    };

    const render = () => {
      process.stdout.write('\x1B[?25l');
      renderOptions();
    };

    const onKeypress = (_value: string, key: readline.Key) => {
      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + positions.length) % positions.length;
        render();
        return;
      }

      if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % positions.length;
        render();
        return;
      }

      if (key.name === 'return') {
        const selected = positions[selectedIndex];
        cleanupInput();
        process.stdout.write(`\n已选择: ${formatPositionLine(selected)}\n`);
        resolve(selected);
        return;
      }

      if (key.ctrl && key.name === 'c') {
        cleanupInput();
        process.stdout.write('\n');
        reject(new SellMatchError('已取消清仓'));
      }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);
    render();
  });

const findTargetPosition = (positions: Position[], keyword: string) =>
  Effect.tryPromise({
    try: async () => {
      const query = keyword.trim();
      if (!query) {
        throw new SellMatchError('sell 参数不能为空');
      }

      const exactAsset = positions.find(position => position.asset === query);
      if (exactAsset) return exactAsset;

      const fuzzyTitleMatches = positions.filter(position =>
        normalize(position.title).includes(normalize(query))
      );

      if (fuzzyTitleMatches.length === 0) {
        throw new SellMatchError(`未找到匹配持仓: ${query}`);
      }

      if (fuzzyTitleMatches.length > 1) {
        return selectPositionWithKeyboard(fuzzyTitleMatches, query);
      }

      return fuzzyTitleMatches[0];
    },
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const postMarketSellOrder = (position: Position, options: SellOptions = {}) =>
  Effect.tryPromise({
    try: async () => {
      const size = resolveSellSize(position, options);
      const marketInfo = await cbc.getClobMarketInfo(position.conditionId);
      const marketPrice = await cbc.calculateMarketPrice(
        position.asset,
        Side.SELL,
        size,
        OrderType.FOK
      );

      const response = await cbc.createAndPostMarketOrder(
        {
          tokenID: position.asset,
          side: Side.SELL,
          amount: size,
          orderType: OrderType.FOK,
        },
        {
          tickSize: String(marketInfo.mts) as TickSize,
          negRisk: position.negativeRisk,
        },
        OrderType.FOK
      );

      return { marketPrice, response };
    },
    catch: cause =>
      new ApiError({
        message: formatCause(cause),
        url: `sell:${position.asset}`,
      }),
  });

const postLimitSellOrder = (position: Position, price: number, options: SellOptions = {}) =>
  Effect.tryPromise({
    try: async () => {
      const size = resolveSellSize(position, options);
      const marketInfo = await cbc.getClobMarketInfo(position.conditionId);
      const response = await cbc.createAndPostOrder(
        {
          tokenID: position.asset,
          side: Side.SELL,
          price,
          size,
        },
        {
          tickSize: String(marketInfo.mts) as TickSize,
          negRisk: position.negativeRisk,
        },
        OrderType.GTC
      );

      return { price, response };
    },
    catch: cause =>
      new ApiError({
        message: formatCause(cause),
        url: `limit-sell:${position.asset}`,
      }),
  });

export const runSell = (keyword: string, options: SellOptions = {}) =>
  Effect.gen(function* () {
    const positions = yield* getPositions({
      user: process.env.FUNDER,
      limit: 500,
    });
    const position = yield* findTargetPosition(positions, keyword);

    yield* Effect.sync(() => {
      printPosition('Sell target matched:', position);
    });

    if (options.price === undefined) {
      const { marketPrice, response } = yield* postMarketSellOrder(position, options);

      yield* Effect.sync(() => {
        console.log('Market sell order posted:');
        console.table({
          ...formatPosition(position),
          marketPrice,
        });
        console.log('Response:', response);
      });

      return { position, marketPrice, response };
    }

    const { price, response } = yield* postLimitSellOrder(position, options.price, options);

    yield* Effect.sync(() => {
      console.log('Limit sell order posted:');
      console.table({
        ...formatPosition(position),
        price,
      });
      console.log('Response:', response);
    });

    return { position, price, response };
  });
