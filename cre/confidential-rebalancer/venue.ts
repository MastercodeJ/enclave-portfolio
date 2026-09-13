/**
 * A venue is where the portfolio lives and trades.
 *
 * The decision logic in main.ts never knows which venue it is talking to. It
 * asks for holdings, prices, price history and quotes; it hands back a trade
 * list. The mock venue answers from fixtures over HTTP; the Uniswap venue
 * answers from Sepolia and executes real swaps, signed inside the enclave.
 */

import type { HTTPClient, TeeRuntime } from "@chainlink/cre-sdk";

import { E8_DECIMALS, asObject, parseDecimalToScaled, parseIntegerString } from "./numeric";
import { parsePriceHistory } from "./signal";

export type Holding = {
  tokenId: string;
  symbol: string;
  /** Integer amount in the token's smallest unit. */
  rawBalance: bigint;
  decimals: number;
};

export type PlannedTrade = {
  tokenId: string;
  symbol: string;
  side: "buy" | "sell";
  /** Always positive, USD at 1e8. */
  notionalUsdE8: bigint;
};

export type Quote = {
  /** Output in the destination token's base units, at the quoted size. */
  amountOut: bigint;
  /** Realised cost versus spot, in bps, fees included. */
  impactBps: bigint;
};

export type ExecutableTrade = PlannedTrade & {
  minAmountOut: bigint;
  destinationTokenId: string;
};

export type Venue = {
  holdings(universe: string[]): Holding[];
  /** token_id -> price in the quote currency at 1e8. */
  prices(universe: string[]): Map<string, bigint>;
  /** token_id -> oldest-first price series at 1e8, `periods` long. */
  history(universe: string[], periods: number): Map<string, bigint[]>;
  /** One quote per trade, same order. */
  quotes(trades: PlannedTrade[], quoteTokenId: string): Quote[];
  /** Executes in order. Returns an opaque id for the log line. */
  execute(trades: ExecutableTrade[], accountId: string): Promise<string>;
};

// ---------------------------------------------------------------------------
// Mock venue: the HTTP fixture service in mock-server.js
// ---------------------------------------------------------------------------

export type MockConfig = {
  base_url: string;
  api_key: string;
  account_id: string;
};

export const parseHoldings = (payload: unknown): Holding[] => {
  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length === 0) {
    throw new Error("portfolio response contained no holdings");
  }
  return rows.map((row) => {
    const record = asObject(row);
    const tokenId = String(record.token_id ?? "").trim();
    if (tokenId === "") {
      throw new Error("holding row is missing token_id");
    }
    const decimals = Number(record.decimals);
    if (!Number.isInteger(decimals)) {
      throw new Error(`holding ${tokenId} has non-integer decimals`);
    }
    return {
      tokenId,
      symbol: String(record.symbol ?? tokenId),
      rawBalance: parseIntegerString(String(record.raw_balance ?? ""), `raw_balance for ${tokenId}`),
      decimals,
    };
  });
};

export const parsePrices = (payload: unknown): Map<string, bigint> => {
  const prices = new Map<string, bigint>();
  for (const [tokenId, raw] of Object.entries(asObject(payload))) {
    prices.set(tokenId, parseDecimalToScaled(String(raw), E8_DECIMALS, `price for ${tokenId}`));
  }
  if (prices.size === 0) {
    throw new Error("price response contained no prices");
  }
  return prices;
};

export const mockVenue = (
  // biome-ignore lint/suspicious/noExplicitAny: config type is the caller's
  runtime: TeeRuntime<any>,
  client: HTTPClient,
  config: MockConfig,
): Venue => {
  const headers = { "Content-Type": "application/json", "x-api-key": config.api_key };
  const decode = (body: Uint8Array) => new TextDecoder().decode(body);
  const get = (path: string): Record<string, unknown> => {
    const response = client.sendRequest(runtime, { url: `${config.base_url}${path}`, method: "GET", headers }).result();
    if (response.statusCode >= 400) throw new Error(`GET ${path} failed status=${response.statusCode}`);
    return asObject(JSON.parse(decode(response.body)));
  };
  const post = (path: string, body: Record<string, unknown>): Record<string, unknown> => {
    const encoded = Buffer.from(new TextEncoder().encode(JSON.stringify(body))).toString("base64");
    const response = client.sendRequest(runtime, { url: `${config.base_url}${path}`, method: "POST", body: encoded, headers }).result();
    if (response.statusCode >= 400) throw new Error(`POST ${path} failed status=${response.statusCode}`);
    return asObject(JSON.parse(decode(response.body)));
  };

  return {
    holdings: () => parseHoldings(get(`/portfolio/${config.account_id}`).holdings),
    prices: () => parsePrices(get("/prices").prices),
    history: (_universe, periods) => parsePriceHistory(get(`/history?periods=${periods}`).history, parseDecimalToScaled),
    quotes: (trades, quoteTokenId) =>
      trades.map((trade) => {
        const response = post("/quote", {
          token_in: trade.side === "buy" ? quoteTokenId : trade.tokenId,
          token_out: trade.side === "buy" ? trade.tokenId : quoteTokenId,
          notional_usd_e8: trade.notionalUsdE8.toString(),
        });
        return {
          amountOut: parseIntegerString(String(response.amount_out ?? ""), `amount_out for ${trade.tokenId}`),
          impactBps: parseIntegerString(String(response.price_impact_bps ?? ""), `price_impact_bps for ${trade.tokenId}`),
        };
      }),
    execute: async (trades, accountId) => {
      const response = post("/execute-rebalance", {
        account_id: accountId,
        trades: trades.map((trade) => ({
          token_id: trade.tokenId,
          symbol: trade.symbol,
          side: trade.side,
          notional_usd_e8: trade.notionalUsdE8.toString(),
          min_amount_out: trade.minAmountOut.toString(),
          destination_token_id: trade.destinationTokenId,
        })),
      });
      return String(response.execution_id ?? "unknown");
    },
  };
};
