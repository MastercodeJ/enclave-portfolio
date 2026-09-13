/**
 * JSON-RPC over confidential HTTP, from inside the enclave.
 *
 * Every call here is an HTTP request whose TLS terminates inside the TEE, so
 * the node operator sees ciphertext. Error text is deliberately terse: RPC
 * errors echo calldata, and an uncaught error is a public log line.
 */

import type { HTTPClient, TeeRuntime } from "@chainlink/cre-sdk";
import type { Address, Hex } from "viem";

import { asObject } from "./numeric";

const JSON_HEADERS = { "Content-Type": "application/json" };

export type Rpc = {
  // biome-ignore lint/suspicious/noExplicitAny: config type is the caller's
  runtime: TeeRuntime<any>;
  client: HTTPClient;
  url: string;
  nextId: number;
};

export const rpcCall = (rpc: Rpc, method: string, params: unknown[]): unknown => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpc.nextId++, method, params });
  const response = rpc.client
    .sendRequest(rpc.runtime, {
      url: rpc.url,
      method: "POST",
      body: Buffer.from(new TextEncoder().encode(body)).toString("base64"),
      headers: JSON_HEADERS,
    })
    .result();
  if (response.statusCode >= 400) {
    throw new Error(`rpc ${method} http ${response.statusCode}`);
  }
  const json = asObject(JSON.parse(new TextDecoder().decode(response.body)));
  if (json.error !== undefined) {
    throw new Error(`rpc ${method} failed`);
  }
  return json.result;
};

export const hexToBigint = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("rpc returned a non-hex quantity");
  }
  return BigInt(value);
};

export const ethCall = (rpc: Rpc, to: Address, data: Hex): Hex => {
  const result = rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error("eth_call returned no data");
  }
  return result as Hex;
};

/** Newest block number and timestamp. */
export const latestBlock = (rpc: Rpc): { number: bigint; timestamp: bigint } => {
  const block = asObject(rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]));
  return { number: hexToBigint(block.number), timestamp: hexToBigint(block.timestamp) };
};

export type LogEntry = { blockNumber: bigint; topics: string[]; data: Hex };

export const getLogs = (
  rpc: Rpc,
  address: Address,
  topics: (string | string[] | null)[],
  fromBlock: bigint,
  toBlock: bigint | "latest",
): LogEntry[] => {
  const raw = rpcCall(rpc, "eth_getLogs", [
    {
      address,
      topics,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: toBlock === "latest" ? "latest" : `0x${toBlock.toString(16)}`,
    },
  ]);
  if (!Array.isArray(raw)) {
    throw new Error("eth_getLogs returned no list");
  }
  return raw.map((entry) => {
    const record = asObject(entry);
    return {
      blockNumber: hexToBigint(record.blockNumber),
      topics: Array.isArray(record.topics) ? record.topics.map(String) : [],
      data: String(record.data) as Hex,
    };
  });
};

// ---------------------------------------------------------------------------
// Batching
//
// CRE caps a workflow at 15 HTTP calls per execution -- a production limit the
// simulator enforces. A JSON-RPC batch is one HTTP call carrying many
// requests, so the venue gathers its reads and sends them in a handful of
// round trips instead of one per call.
// ---------------------------------------------------------------------------

export type RpcRequest = { method: string; params: unknown[] };

export const rpcBatch = (rpc: Rpc, requests: RpcRequest[]): unknown[] => {
  if (requests.length === 0) return [];
  const firstId = rpc.nextId;
  const body = JSON.stringify(
    requests.map((request, index) => ({ jsonrpc: "2.0", id: firstId + index, method: request.method, params: request.params })),
  );
  rpc.nextId += requests.length;
  const response = rpc.client
    .sendRequest(rpc.runtime, {
      url: rpc.url,
      method: "POST",
      body: Buffer.from(new TextEncoder().encode(body)).toString("base64"),
      headers: JSON_HEADERS,
    })
    .result();
  if (response.statusCode >= 400) {
    throw new Error(`rpc batch http ${response.statusCode}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  if (!Array.isArray(parsed)) {
    throw new Error("rpc batch returned no list");
  }
  // Responses may arrive in any order; key them by id.
  const byId = new Map<number, Record<string, unknown>>();
  for (const entry of parsed) {
    const record = asObject(entry);
    byId.set(Number(record.id), record);
  }
  return requests.map((request, index) => {
    const record = byId.get(firstId + index);
    if (record === undefined) throw new Error(`rpc batch missing response for ${request.method}`);
    if (record.error !== undefined) throw new Error(`rpc ${request.method} failed`);
    return record.result;
  });
};

export const callRequest = (to: Address, data: Hex): RpcRequest => ({ method: "eth_call", params: [{ to, data }, "latest"] });

export const requireHex = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !value.startsWith("0x")) throw new Error(`${label} returned no data`);
  return value as Hex;
};
