import { EventEmitter } from 'events';
import WebSocket from 'ws';

export const MARKET_CHANNEL = 'market';
export const USER_CHANNEL = 'user';

export interface AuthConfig {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface MakerOrder {
  order_id: string;
  owner: string;
  maker_address: string;
  matched_amount: string;
  price: string;
  fee_rate_bps: string;
  asset_id: string;
  outcome: string;
  outcome_index?: number;
  side: 'BUY' | 'SELL';
}

export interface TradeEvent {
  event_type: 'trade';
  type: 'TRADE';
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time?: string;
  matchtime?: string;
  last_update: string;
  outcome: string;
  owner: string;
  trade_owner: string;
  maker_address: string;
  transaction_hash: string;
  bucket_index: number;
  maker_orders: MakerOrder[];
  trader_side: 'TAKER' | 'MAKER';
  timestamp: string;
}

export interface ParsedTrade {
  order_id: string;
  asset_id: string;
  size: string;
  price: string;
  side: 'BUY' | 'SELL';
  trade_side: 'TAKER' | 'MAKER';
}

export function parseTrade(
  trade: TradeEvent,
  myMakerAddress: string = process.env.FUNDER || ''
): ParsedTrade | null {
  const address = myMakerAddress.toLowerCase();
  if (!address) return null;

  if (trade.maker_address?.toLowerCase() === address) {
    return {
      order_id: trade.taker_order_id,
      asset_id: trade.asset_id,
      size: trade.size,
      price: trade.price,
      side: trade.side,
      trade_side: 'TAKER',
    };
  }

  const myOrders = (trade.maker_orders || []).filter(
    order => order.maker_address.toLowerCase() === address
  );
  if (myOrders.length === 0) return null;

  const totalSize = myOrders.reduce((sum, order) => sum + Number(order.matched_amount), 0);
  if (!Number.isFinite(totalSize) || totalSize <= 0) return null;

  const averagePrice =
    myOrders.reduce(
      (sum, order) => sum + Number(order.price) * Number(order.matched_amount),
      0
    ) / totalSize;
  const firstOrder = myOrders[0]!;

  return {
    order_id: firstOrder.order_id,
    asset_id: firstOrder.asset_id,
    size: String(totalSize),
    price: averagePrice.toFixed(4),
    side: firstOrder.side,
    trade_side: 'MAKER',
  };
}

export interface WebSocketOrderBookConfig {
  channelType: typeof MARKET_CHANNEL | typeof USER_CHANNEL;
  url: string;
  data: string[];
  auth?: AuthConfig | null;
  verbose?: boolean;
}

type WsMessage = string | Record<string, unknown> | unknown[];

export class WebSocketOrderBook extends EventEmitter {
  private readonly channelType: typeof MARKET_CHANNEL | typeof USER_CHANNEL;
  private readonly url: string;
  private readonly data: Set<string>;
  private readonly auth: AuthConfig | null;
  private readonly verbose: boolean;
  private ws: WebSocket | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 100;
  private readonly baseReconnectDelay = 1000;
  private readonly maxReconnectDelay = 10000;
  private isIntentionalClose = false;
  private isRunning = false;

  constructor(config: WebSocketOrderBookConfig) {
    super();
    this.channelType = config.channelType;
    this.url = config.url;
    this.data = new Set(config.data || []);
    this.auth = config.auth || null;
    this.verbose = config.verbose || false;
  }

  public addAssets(assets: string[]) {
    const newAssets = assets.filter(asset => {
      if (this.data.has(asset)) return false;
      this.data.add(asset);
      return true;
    });

    if (newAssets.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendJson({
        operation: 'subscribe',
        [this.channelType === MARKET_CHANNEL ? 'assets_ids' : 'markets']: newAssets,
      });
    }
  }

  public removeAssets(assets: string[]) {
    const removedAssets = assets.filter(asset => this.data.delete(asset));
    if (removedAssets.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendJson({
        operation: 'unsubscribe',
        [this.channelType === MARKET_CHANNEL ? 'assets_ids' : 'markets']: removedAssets,
      });
    }
  }

  public run() {
    if (this.isRunning && this.ws) return;
    this.isRunning = true;
    this.isIntentionalClose = false;
    this.connect();
  }

  public close() {
    this.isIntentionalClose = true;
    this.isRunning = false;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect() {
    try {
      this.ws = new WebSocket(`${this.url}/ws/${this.channelType}`);
      this.ws.on('open', this.onOpen.bind(this));
      this.ws.on('message', this.onMessage.bind(this));
      this.ws.on('error', this.onError.bind(this));
      this.ws.on('close', this.onClose.bind(this));
    } catch {
      this.scheduleReconnect();
    }
  }

  private onOpen() {
    this.reconnectAttempts = 0;
    this.startPing();
    this.sendSubscription();
    this.emit('connected');
  }

  private onMessage(data: WebSocket.RawData) {
    const message = data.toString();
    if (this.verbose && message !== 'PONG') {
      this.emit('raw', message);
    }

    if (message === 'PONG' || message === 'Pong') return;

    try {
      this.emit('data', JSON.parse(message) as WsMessage);
    } catch {
      // The API may send plain heartbeat strings; ignore non-JSON payloads.
    }
  }

  private onError(error: Error) {
    this.emit('ws_error', error);
  }

  private onClose() {
    this.stopPing();
    this.ws = null;
    if (!this.isIntentionalClose) this.scheduleReconnect();
  }

  private sendSubscription() {
    if (this.channelType === MARKET_CHANNEL) {
      this.sendJson({
        assets_ids: Array.from(this.data),
        type: MARKET_CHANNEL,
      });
      return;
    }

    if (this.auth) {
      this.sendJson({
        markets: Array.from(this.data),
        type: USER_CHANNEL,
        auth: this.auth,
      });
    }
  }

  private startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendJson({});
      }
    }, 10_000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private sendJson(payload: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(payload));
  }

  private scheduleReconnect() {
    if (!this.isRunning || this.reconnectAttempts >= this.maxReconnectAttempts) return;

    const delay = Math.min(
      this.baseReconnectDelay * 2 ** this.reconnectAttempts,
      this.maxReconnectDelay
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }
}

const wsUrl = process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com';

export const wsMarket = new WebSocketOrderBook({
  channelType: MARKET_CHANNEL,
  url: wsUrl,
  data: [],
});

export const wsUser = new WebSocketOrderBook({
  channelType: USER_CHANNEL,
  url: wsUrl,
  data: [],
  auth: {
    apiKey: process.env.CLOB_API_KEY || '',
    secret: process.env.CLOB_SECRET || '',
    passphrase: process.env.CLOB_PASS_PHRASE || '',
  },
});

export class WebSocketSports extends EventEmitter {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 100;
  private readonly baseReconnectDelay = 1000;
  private readonly maxReconnectDelay = 10000;
  private isIntentionalClose = false;
  private isRunning = false;

  constructor(url: string) {
    super();
    this.url = url;
  }

  public run() {
    if (this.isRunning && this.ws) return;
    this.isRunning = true;
    this.isIntentionalClose = false;
    this.connect();
  }

  public close() {
    this.isIntentionalClose = true;
    this.isRunning = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect() {
    try {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.emit('connected');
      });
      this.ws.on('message', this.onMessage.bind(this));
      this.ws.on('error', error => this.emit('ws_error', error));
      this.ws.on('close', () => {
        this.ws = null;
        if (!this.isIntentionalClose) this.scheduleReconnect();
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private onMessage(data: WebSocket.RawData) {
    const message = data.toString();
    if (message === 'PING' || message === 'Ping') {
      this.ws?.send('PONG');
      return;
    }

    try {
      this.emit('data', JSON.parse(message) as Record<string, unknown>);
    } catch {
      // Ignore plain heartbeat payloads.
    }
  }

  private scheduleReconnect() {
    if (!this.isRunning || this.reconnectAttempts >= this.maxReconnectAttempts) return;

    const delay = Math.min(
      this.baseReconnectDelay * 2 ** this.reconnectAttempts,
      this.maxReconnectDelay
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }
}

export const wsSports = new WebSocketSports(
  process.env.POLYMARKET_SPORTS_WS_URL || 'wss://sports-api.polymarket.com/ws'
);
