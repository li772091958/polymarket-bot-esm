export type TickSize = string;

export type MarketSearchProps = {
  offset?: number;
  limit?: number;
  order?: string;
  ascending?: boolean;
  id?: number;
  slug?: string[];
  clob_token_ids?: string[];
  condition_ids?: string[];
  market_maker_address?: string[];
  start_date_min?: string;
  start_date_max?: string;
  end_date_min?: string;
  end_date_max?: string;
  closed?: boolean;
  volume_num_min?: number;
  volume_num_max?: number;
  liquidity_num_min?: number;
  liquidity_num_max?: number;
  tag_id?: number;
  active?: boolean;
  include_tag?: boolean;
  game_id?: string;
};
export type Coin = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export type Market = {
  conditionId: string;
  id: string;
  ticker: string;
  slug: string;
  title: string;
  subtitle: string;
  seriesType: string;
  recurrence: string;
  description: string;
  image: string;
  question: string;
  icon: string;
  layout: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  new: boolean;
  featured: boolean;
  restricted: boolean;
  isTemplate: boolean;
  templateVariables: boolean;
  publishedAt: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  commentsEnabled: boolean;
  competitive: string;
  volume24hr: number;
  volume: number;
  liquidity: number;
  startDate: string;
  pythTokenID: string;
  cgAssetName: string;
  score: number;
  outcomePrices: string;
  clobTokenIds: string;
  negRisk: boolean;
  orderPriceMinTickSize: TickSize;
  orderMinSize: number;
  liquidityNum: number;
  volumeNum: number;
  lastTradePrice: number;
  bestBid: number;
  bestAsk: number;
  outcomes: string;
  endDate: string;
  tags: { id: string; label: string }[];
  gameStartTime?: string;
  events: any[];
};
export interface ParsedMarket extends Market {
  up: string;
  down: string;
  tokens: [string, string];
  symbol: Coin;
  base?: number;
}

export type Position = {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventId: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
};

export type ActivitySearchParams = {
  user: string;
  limit?: number;
  offset?: number;
  market?: string[];
  eventId?: string;
  type?: ('TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION')[];
  start?: number;
  end?: number;
  side?: 'BUY' | 'SELL';
  sortBy?: 'TIMESTAMP' | 'TOKENS' | 'CASH';
  sortDirection?: 'ASC' | 'DESC';
};

export type TradesSearchParams = {
  user?: string;
  offset?: number;
  limit?: number;
  side?: 'BUY' | 'SELL';
  filterType?: 'CASH' | 'TOKENS';
  filterAmount?: number;
  market?: string;
};

export type PositionSearchParams = {
  user?: string | undefined;
  limit?: number;
  offset?: number;
  market?: string[] | string;
  redeemable?: boolean;
  mergeable?: boolean;
};

export type MarketPriceSearchParams = {
  token_id: string;
  side: 'BUY' | 'SELL';
};

export type MarketPrice = {
  price: number;
};

export type Trade = {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  usdcSize: number;
  slug: string;
  title: string;
  outcome: string;
};

export type RawOrderFilledArgs = {
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
};
export type ParsedOrderFilledArgs = {
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: number;
  takerAmountFilled: number;
};

/**
 * 大额交易的数据
 */
export interface WhaleTransactionItem {
  transactionHash: string;
  token: string;
  price: number;
  address: string;
  amount: number;
}

export interface LeaderboardSearchParams {
  category?:
    | 'OVERALL'
    | 'POLITICS'
    | 'SPORTS'
    | 'CRYPTO'
    | 'CULTURE'
    | 'MENTIONS'
    | 'WEATHER'
    | 'ECONOMICS'
    | 'TECH'
    | 'FINANCE';

  timePeriod?: 'DAY' | 'WEEK' | 'MONTH' | 'ALL';

  orderBy?: 'PNL' | 'VOL';

  limit?: number;

  offset?: number;

  user?: string;

  userName?: string;
}

export interface TraderLeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string;
  vol: number;
  pnl: number;
  profileImage?: string;
  xUsername?: string;
  verifiedBadge: boolean;
}

export interface Tag {
  id: string;
  label: string;
}

export interface GetClosedPositionsParams {
  user: string;
  market?: string | string[];
  title?: string;
  eventId?: number | number[];
  limit?: number;
  offset?: number;
  sortBy?: 'REALIZEDPNL' | 'TITLE' | 'PRICE' | 'AVGPRICE' | 'TIMESTAMP';
  sortDirection?: 'ASC' | 'DESC';
}

export interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
}

export interface PolyEvent {
  id: string;
  slug: string;
  markets: Market[];
}
