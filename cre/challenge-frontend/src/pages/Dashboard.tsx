import { useEffect, useState } from "react";
import { formatUnits, parseAbi, parseAbiItem } from "viem";

import { publicClient } from "@/lib/client";
import {
  OFFICIAL_LENDING, OFFICIAL_VETH, OFFICIAL_VUSD,
  PRIVATE_LENDING, PRIVATE_VETH, PRIVATE_VUSD,
  UNISWAP, WORKFLOW_WALLET,
} from "../../addresses";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const POOL = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function token0() view returns (address)",
]);
const LENDING = parseAbi([
  "function getUserPosition(address) view returns ((uint256 collateral, uint256 debt, uint256 hf, uint256 numOperations, uint256 lastUpdateTime, uint256 cumulativeDebtTime))",
  "function vETHPrice() view returns (uint256)",
  "function scenarioStartTime() view returns (uint256)",
  "function scenarioEndTime() view returns (uint256)",
  "function challengeOpen() view returns (bool)",
]);
const SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const DEPOSIT = parseAbiItem("event Deposit(address indexed user, uint256 amount)");
const REPAY = parseAbiItem("event Repay(address indexed user, uint256 amount)");
const LIQUIDATED = parseAbiItem("event Liquidated(address indexed user, uint256 debtRepaid, uint256 collateralSeized)");

const LOOKBACK = 9_000n; // ~30 hours of Sepolia blocks; public RPCs cap log ranges
/** Logs are decoration; a rate-limited RPC must not blank the page. */
// biome-ignore lint/suspicious/noExplicitAny: passthrough
const safeLogs = async <T,>(p: Promise<T[]>): Promise<T[]> => { try { return await p; } catch { return []; } };
const etherscan = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/** token1-per-token0 from sqrtPriceX96, as a float for display only. */
const priceFromSqrt = (sqrt: bigint, dec0: number, dec1: number) => {
  const p = Number(sqrt) / 2 ** 96;
  return p * p * 10 ** (dec0 - dec1);
};

/** Served only by a local operator process (bun run operator). Never public. */
type Operator = {
  computedAt: string;
  signals: { type: string; strengthBps: number; params: Record<string, unknown> }[];
  policy: { driftThresholdBps: number; maxTradeBps: number; maxPriceImpactBps: number };
  rows: { symbol: string; baseBps: number; targetBps: number; currentBps: number; driftBps: number; deltaUsd: number; minBps: number; maxBps: number }[];
  maxDriftBps: number;
  wouldAct: boolean;
  planned: { side: string; symbol: string; notionalUsd: number }[];
};
const OPERATOR_URL = "http://127.0.0.1:8790/operator";
const pctOf = (bps: number) => `${(bps / 100).toFixed(2)}%`;

type Portfolio = {
  rows: { symbol: string; amount: number; priceUsd: number; valueUsd: number; weight: number }[];
  totalUsd: number;
  swaps: { hash: string; block: bigint; pool: string; amount0: bigint; amount1: bigint }[];
};

type Position = {
  label: string;
  collateral: number; debt: number; hf: number; ops: number;
  price: number; freeVeth: number; freeVusd: number;
  open: boolean; started: boolean; ended: boolean;
  actions: { hash: string; block: bigint; kind: string; amount: number }[];
  liquidations: number;
};

async function loadPortfolio(): Promise<Portfolio> {
  const { WETH, USDC, LINK } = UNISWAP.tokens;
  const [bWeth, bUsdc, bLink, s0WU, s0WL, t0WU, t0WL] = await publicClient.multicall({
    contracts: [
      { address: WETH.address, abi: ERC20, functionName: "balanceOf", args: [WORKFLOW_WALLET] },
      { address: USDC.address, abi: ERC20, functionName: "balanceOf", args: [WORKFLOW_WALLET] },
      { address: LINK.address, abi: ERC20, functionName: "balanceOf", args: [WORKFLOW_WALLET] },
      { address: UNISWAP.pools.WETH_USDC, abi: POOL, functionName: "slot0" },
      { address: UNISWAP.pools.WETH_LINK, abi: POOL, functionName: "slot0" },
      { address: UNISWAP.pools.WETH_USDC, abi: POOL, functionName: "token0" },
      { address: UNISWAP.pools.WETH_LINK, abi: POOL, functionName: "token0" },
    ],
    allowFailure: false,
  });
  // WETH in USDC
  const wuToken0IsUsdc = (t0WU as string).toLowerCase() === USDC.address.toLowerCase();
  const wuRaw = priceFromSqrt((s0WU as readonly unknown[])[0] as bigint, wuToken0IsUsdc ? 6 : 18, wuToken0IsUsdc ? 18 : 6);
  const wethUsd = wuToken0IsUsdc ? 1 / wuRaw : wuRaw;
  // LINK in WETH
  const wlToken0IsLink = (t0WL as string).toLowerCase() === LINK.address.toLowerCase();
  const wlRaw = priceFromSqrt((s0WL as readonly unknown[])[0] as bigint, 18, 18);
  const linkInWeth = wlToken0IsLink ? wlRaw : 1 / wlRaw;
  const linkUsd = linkInWeth * wethUsd;

  const rowsRaw = [
    { symbol: "WETH", amount: Number(formatUnits(bWeth as bigint, 18)), priceUsd: wethUsd },
    { symbol: "USDC", amount: Number(formatUnits(bUsdc as bigint, 6)), priceUsd: 1 },
    { symbol: "LINK", amount: Number(formatUnits(bLink as bigint, 18)), priceUsd: linkUsd },
  ];
  const totalUsd = rowsRaw.reduce((s, r) => s + r.amount * r.priceUsd, 0);
  const rows = rowsRaw.map((r) => ({ ...r, valueUsd: r.amount * r.priceUsd, weight: totalUsd > 0 ? (r.amount * r.priceUsd) / totalUsd : 0 }));

  const latest = await publicClient.getBlockNumber();
  const from = latest > LOOKBACK ? latest - LOOKBACK : 0n;
  const logs = await safeLogs(publicClient.getLogs({
    address: [UNISWAP.pools.WETH_USDC, UNISWAP.pools.WETH_LINK],
    event: SWAP, args: { recipient: WORKFLOW_WALLET }, fromBlock: from, toBlock: "latest",
  }));
  const swaps = logs
    .map((l) => ({ hash: l.transactionHash!, block: l.blockNumber!, pool: l.address.toLowerCase() === UNISWAP.pools.WETH_USDC.toLowerCase() ? "WETH/USDC" : "WETH/LINK", amount0: l.args.amount0!, amount1: l.args.amount1! }))
    .sort((a, b) => (a.block < b.block ? 1 : -1))
    .slice(0, 12);
  return { rows, totalUsd, swaps };
}

async function loadPosition(label: string, lending: `0x${string}`, veth: `0x${string}`, vusd: `0x${string}`): Promise<Position> {
  const [pos, price, started, ended, open, fVeth, fVusd] = await publicClient.multicall({
    contracts: [
      { address: lending, abi: LENDING, functionName: "getUserPosition", args: [WORKFLOW_WALLET] },
      { address: lending, abi: LENDING, functionName: "vETHPrice" },
      { address: lending, abi: LENDING, functionName: "scenarioStartTime" },
      { address: lending, abi: LENDING, functionName: "scenarioEndTime" },
      { address: lending, abi: LENDING, functionName: "challengeOpen" },
      { address: veth, abi: ERC20, functionName: "balanceOf", args: [WORKFLOW_WALLET] },
      { address: vusd, abi: ERC20, functionName: "balanceOf", args: [WORKFLOW_WALLET] },
    ],
    allowFailure: false,
  });
  const p = pos as { collateral: bigint; debt: bigint; hf: bigint; numOperations: bigint };
  const priceN = Number(price as bigint);
  const liveHf = p.debt > 0n ? Number((p.collateral * (price as bigint) * 78n) / (100n * p.debt)) : Infinity;
  const latest = await publicClient.getBlockNumber();
  const from = latest > LOOKBACK ? latest - LOOKBACK : 0n;
  const [dep, rep, liq] = await Promise.all([
    safeLogs(publicClient.getLogs({ address: lending, event: DEPOSIT, args: { user: WORKFLOW_WALLET }, fromBlock: from, toBlock: "latest" })),
    safeLogs(publicClient.getLogs({ address: lending, event: REPAY, args: { user: WORKFLOW_WALLET }, fromBlock: from, toBlock: "latest" })),
    safeLogs(publicClient.getLogs({ address: lending, event: LIQUIDATED, args: { user: WORKFLOW_WALLET }, fromBlock: from, toBlock: "latest" })),
  ]);
  const actions = [
    ...dep.map((l) => ({ hash: l.transactionHash!, block: l.blockNumber!, kind: "deposit vETH", amount: Number(l.args.amount!) / 100 })),
    ...rep.map((l) => ({ hash: l.transactionHash!, block: l.blockNumber!, kind: "repay vUSD", amount: Number(l.args.amount!) / 100 })),
  ].sort((a, b) => (a.block < b.block ? 1 : -1)).slice(0, 10);
  return {
    label,
    collateral: Number(p.collateral) / 100, debt: Number(p.debt) / 100, hf: liveHf, ops: Number(p.numOperations),
    price: priceN / 100, freeVeth: Number(fVeth as bigint) / 100, freeVusd: Number(fVusd as bigint) / 100,
    open: open as boolean, started: (started as bigint) > 0n, ended: (ended as bigint) > 0n,
    actions, liquidations: liq.length,
  };
}

export function DashboardPage() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [reveal, setReveal] = useState(() => new URLSearchParams(window.location.search).get("reveal") === "1");

  // Probe for the local operator service; absent in any public deployment.
  useEffect(() => {
    let cancelled = false;
    fetch(OPERATOR_URL).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!cancelled && d && !d.error) setOperator(d as Operator); }).catch(() => {});
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pf, official, priv] = await Promise.all([
          loadPortfolio(),
          loadPosition("Official challenge", OFFICIAL_LENDING, OFFICIAL_VETH, OFFICIAL_VUSD),
          loadPosition("Private test copy", PRIVATE_LENDING, PRIVATE_VETH, PRIVATE_VUSD),
        ]);
        if (!cancelled) { setPortfolio(pf); setPositions([official, priv]); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tick]);

  return (
    <main className="container">
      <div className="dash-head">
        <div>
          <h1>Enclave Portfolio</h1>
          <p className="muted">Everything below is public on Sepolia. The strategy that produced it is not.</p>
        </div>
        <div className="dash-badges">
          <div className="enclave-badge">🔒 decisions made in AWS Nitro · Chainlink CRE</div>
          {operator && (
            <button className={`btn btn-sm ${reveal ? "btn-warning" : "btn-secondary"}`} onClick={() => setReveal((v) => !v)}>
              {reveal ? "Hide sealed values" : "Reveal sealed values (operator, local only)"}
            </button>
          )}
        </div>
      </div>
      {reveal && operator && (
        <div className="info-box operator-note">
          Operator view. These values come from a process on <b>this machine</b> reading the owner's spec —
          not from the chain, not from the enclave, and not available to anyone else. Computed {new Date(operator.computedAt).toLocaleTimeString()}.
        </div>
      )}
      {error && <div className="alert-error">{error}</div>}

      <section className="panel">
        <div className="card-head">
          <h2>Confidential rebalancer · Uniswap V3</h2>
          <span className="muted">wallet {WORKFLOW_WALLET.slice(0, 6)}…{WORKFLOW_WALLET.slice(-4)}</span>
        </div>
        {!portfolio ? <p className="muted">loading…</p> : (
          <>
            <div className="stat-row">
              <div className="stat"><div className="stat-label">book value</div><div className="stat-value">${portfolio.totalUsd.toFixed(2)}</div></div>
              <div className="stat"><div className="stat-label">target weights</div>
                {reveal && operator ? <div className="stat-value revealed">{operator.rows.map((r) => `${r.symbol} ${pctOf(r.targetBps)}`).join(" · ")}</div> : <div className="stat-value sealed">sealed</div>}</div>
              <div className="stat"><div className="stat-label">drift band</div>
                {reveal && operator ? <div className="stat-value revealed">{pctOf(operator.policy.driftThresholdBps)} · now {pctOf(operator.maxDriftBps)} {operator.wouldAct ? "→ would act" : "→ hold"}</div> : <div className="stat-value sealed">sealed</div>}</div>
              <div className="stat"><div className="stat-label">signals</div>
                {reveal && operator ? <div className="stat-value revealed">{operator.signals.map((g) => `${g.type} ${pctOf(g.strengthBps)}${"lookback" in g.params ? ` (${String(g.params.lookback)})` : ""}`).join(" · ") || "none"}</div> : <div className="stat-value sealed">sealed</div>}</div>
            </div>
            <table className="table">
              <thead><tr><th>token</th><th>held</th><th>price</th><th>value</th><th>weight</th>{reveal && operator && <><th className="revealed">base</th><th className="revealed">target</th><th className="revealed">drift</th><th className="revealed">bounds</th></>}</tr></thead>
              <tbody>
                {portfolio.rows.map((r) => (
                  <tr key={r.symbol}>
                    <td><b>{r.symbol}</b></td>
                    <td>{r.amount.toFixed(r.symbol === "USDC" ? 2 : 6)}</td>
                    <td>${r.priceUsd.toFixed(2)}</td>
                    <td>${r.valueUsd.toFixed(2)}</td>
                    <td>
                      <div className="weight"><div className="weight-bar" style={{ width: `${(r.weight * 100).toFixed(1)}%` }} /><span>{(r.weight * 100).toFixed(1)}%</span></div>
                    </td>
                    {reveal && operator && (() => { const o = operator.rows.find((x) => x.symbol === r.symbol); return o ? <>
                      <td className="revealed">{pctOf(o.baseBps)}</td>
                      <td className="revealed"><b>{pctOf(o.targetBps)}</b></td>
                      <td className="revealed">{pctOf(o.driftBps)}</td>
                      <td className="revealed">{pctOf(o.minBps)}–{pctOf(o.maxBps)}</td>
                    </> : <td colSpan={4} />; })()}
                  </tr>
                ))}
              </tbody>
            </table>
            {reveal && operator && (
              <div className="info-box operator-note">
                <b>What the enclave would do next:</b>{" "}
                {operator.wouldAct
                  ? operator.planned.map((t) => `${t.side.toUpperCase()} ${t.symbol} $${t.notionalUsd.toFixed(2)}`).join(" · ")
                  : "hold — within the drift band"}
                <span className="muted"> · max trade {pctOf(operator.policy.maxTradeBps)} of book · impact cap {pctOf(operator.policy.maxPriceImpactBps)}</span>
              </div>
            )}
            <h3 className="subhead">Swaps by the workflow wallet</h3>
            {portfolio.swaps.length === 0 ? <p className="muted">none in the last ~5 days</p> : (
              <ul className="tx-list">
                {portfolio.swaps.map((s) => (
                  <li key={`${s.hash}-${s.pool}-${s.block}`}>
                    <span className="badge">{s.pool}</span>
                    <span className="muted">block {s.block.toString()}</span>
                    <a href={etherscan(s.hash)} target="_blank" rel="noopener noreferrer">{short(s.hash)}</a>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Prices are read from the same pools the workflow trades in. Testnet prices are not market prices.</p>
          </>
        )}
      </section>

      <div className="two-col">
        {positions.map((p) => (
          <section className="panel" key={p.label}>
            <div className="card-head">
              <h2>Liquidation protection · {p.label}</h2>
              <span className={`badge ${p.liquidations > 0 ? "badge-danger" : p.hf <= 100 ? "badge-warning" : "badge-safe"}`}>
                {p.liquidations > 0 ? `liquidated ×${p.liquidations}` : p.hf <= 100 ? "liquidatable" : "safe"}
              </span>
            </div>
            <div className="stat-row">
              <div className="stat"><div className="stat-label">health factor</div><div className="stat-value">{Number.isFinite(p.hf) ? (p.hf / 100).toFixed(2) : "∞"}</div></div>
              <div className="stat"><div className="stat-label">vETH price</div><div className="stat-value">${p.price.toFixed(2)}</div></div>
              <div className="stat"><div className="stat-label">collateral</div><div className="stat-value">{p.collateral.toFixed(2)} vETH</div></div>
              <div className="stat"><div className="stat-label">debt</div><div className="stat-value">{p.debt.toFixed(2)} vUSD</div></div>
            </div>
            <div className="chips">
              <span className="stat-chip"><span className="stat-chip-label">free vETH</span><span className="stat-chip-value">{p.freeVeth.toFixed(2)}</span></span>
              <span className="stat-chip"><span className="stat-chip-label">free vUSD</span><span className="stat-chip-value">{p.freeVusd.toFixed(2)}</span></span>
              <span className="stat-chip"><span className="stat-chip-label">interventions</span><span className="stat-chip-value">{p.ops}</span></span>
              <span className="stat-chip"><span className="stat-chip-label">scenario</span><span className="stat-chip-value">{p.ended ? "stopped" : p.started ? "running" : p.open ? "open, not started" : "closed"}</span></span>
            </div>
            <div className="stat-row">
              <div className="stat"><div className="stat-label">trigger / target hf</div><div className="stat-value sealed">sealed</div></div>
              <div className="stat"><div className="stat-label">floor price · caps · cooldown</div><div className="stat-value sealed">sealed</div></div>
            </div>
            <h3 className="subhead">Workflow actions</h3>
            {p.actions.length === 0 ? <p className="muted">none yet</p> : (
              <ul className="tx-list">
                {p.actions.map((a) => (
                  <li key={a.hash + a.kind}>
                    <span className="badge">{a.kind}</span><span>{a.amount.toFixed(2)}</span>
                    <a href={etherscan(a.hash)} target="_blank" rel="noopener noreferrer">{short(a.hash)}</a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
