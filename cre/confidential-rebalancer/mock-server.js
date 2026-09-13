/**
 * Deterministic stand-in for the DeFi Copilot service.
 *
 * It speaks the same shapes the real Hedera-backed service will: raw integer
 * balances in base units, decimal-string prices, and integer quotes. Swapping
 * this for the real thing is a change of `portfolio_base_url`, nothing more.
 *
 * Amounts are strings, not JSON numbers, throughout. A raw HBAR balance at 8
 * decimals passes Number.MAX_SAFE_INTEGER at ~90M HBAR, and JSON.parse would
 * silently round it.
 */

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const API_KEY = process.env.REBALANCER_PORTFOLIO_API_KEY ?? "mock-portfolio-key";

const BPS_DENOMINATOR = 10_000n;
const USD_SCALE = 10n ** 8n;

/**
 * Testnet token ids from src/config.py. WHBAR (0.0.15058) is what pools
 * actually trade -- see the HBAR aliasing note in the project README.
 */
const TOKENS = {
  "0.0.15058": { symbol: "WHBAR", decimals: 8, priceUsd: "0.05", depthUsd: 400_000n },
  "0.0.5449": { symbol: "USDC", decimals: 6, priceUsd: "1.00", depthUsd: 5_000_000n },
  "0.0.1183558": { symbol: "SAUCE", decimals: 6, priceUsd: "0.01", depthUsd: 90_000n },
};

/**
 * A deliberately drifted portfolio: 62 / 25 / 13 against a 50 / 30 / 20
 * target, on a $10,000 book. Max drift is 1200 bps, comfortably through a
 * 500 bps band, so a simulation run actually produces trades.
 */
const HOLDINGS = [
  { token_id: "0.0.15058", symbol: "WHBAR", raw_balance: "12400000000000", decimals: 8 },
  { token_id: "0.0.5449", symbol: "USDC", raw_balance: "2500000000", decimals: 6 },
  { token_id: "0.0.1183558", symbol: "SAUCE", raw_balance: "130000000000", decimals: 6 },
];

const parseDecimalToScaled = (raw, scaleDecimals) => {
  const [intPart = "0", fracPart = ""] = String(raw).trim().split(".");
  return BigInt(`${intPart}${fracPart.slice(0, scaleDecimals).padEnd(scaleDecimals, "0")}`);
};

/**
 * Deterministic price history, oldest-first, ending exactly at the spot price.
 *
 * Each token gets its own per-period volatility so the enclave's risk-parity
 * tilt has something real to bite on: USDC is near-flat, WHBAR moderate, SAUCE
 * wild. A fixed LCG seed per token means every run produces the same series,
 * so a simulation is reproducible and a demo does not change under you.
 *
 * Float math is fine here -- this is a test fixture generating fixture data.
 * The workflow parses the decimal strings back into exact fixed point.
 */
const PERIOD_VOLATILITY = {
  "0.0.15058": 0.03, // WHBAR: moderate
  "0.0.5449": 0.0005, // USDC: a stablecoin, near-flat
  "0.0.1183558": 0.08, // SAUCE: thin and volatile
};

const buildSeries = (tokenId, token, periods) => {
  let seed = 0;
  for (const character of tokenId) {
    seed = (seed * 31 + character.charCodeAt(0)) % 2147483647;
  }
  const nextUnit = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const sigma = PERIOD_VOLATILITY[tokenId] ?? 0.02;
  const spot = Number(token.priceUsd);

  // Walk backwards from spot so the final element is exactly today's price.
  const series = new Array(periods);
  series[periods - 1] = spot;
  for (let index = periods - 2; index >= 0; index--) {
    const shock = (nextUnit() - 0.5) * 2 * sigma;
    series[index] = series[index + 1] / (1 + shock);
  }

  return series.map((price) => price.toFixed(8));
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const unauthorized = () => json({ error: "invalid x-api-key" }, 401);

/**
 * Linear price-impact proxy: impact_bps = notional / pool_depth.
 *
 * Not a real AMM curve -- the production path uses src/market/quotes.py, which
 * computes exact constant-product output. This only has to be monotonic in
 * size so the enclave's impact cap can be exercised.
 */
const quoteImpactBps = (tokenOut, notionalUsdE8) => {
  const depthE8 = TOKENS[tokenOut].depthUsd * USD_SCALE;
  return (notionalUsdE8 * BPS_DENOMINATOR) / depthE8;
};

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("x-api-key") !== API_KEY) {
      return unauthorized();
    }

    if (request.method === "GET" && url.pathname.startsWith("/portfolio/")) {
      return json({
        account_id: url.pathname.slice("/portfolio/".length),
        network: "testnet",
        holdings: HOLDINGS,
      });
    }

    if (request.method === "GET" && url.pathname === "/history") {
      const periods = Number(url.searchParams.get("periods") ?? 20);
      if (!Number.isInteger(periods) || periods < 2 || periods > 500) {
        return json({ error: `bad periods ${periods}` }, 400);
      }
      const history = {};
      for (const [tokenId, token] of Object.entries(TOKENS)) {
        history[tokenId] = buildSeries(tokenId, token, periods);
      }
      return json({ history });
    }

    if (request.method === "GET" && url.pathname === "/prices") {
      const prices = {};
      for (const [tokenId, token] of Object.entries(TOKENS)) {
        prices[tokenId] = token.priceUsd;
      }
      return json({ prices });
    }

    if (request.method === "POST" && url.pathname === "/quote") {
      const body = await request.json();
      const tokenOut = body.token_out;
      if (!TOKENS[tokenOut]) {
        return json({ error: `unknown token_out ${tokenOut}` }, 400);
      }

      const notionalUsdE8 = BigInt(body.notional_usd_e8);
      const priceOutE8 = parseDecimalToScaled(TOKENS[tokenOut].priceUsd, 8);
      const outScale = 10n ** BigInt(TOKENS[tokenOut].decimals);

      // Gross output before impact, then haircut by the impact. Truncating
      // division rounds output down -- never in the trader's favour.
      const grossOut = (notionalUsdE8 * outScale) / priceOutE8;
      const impactBps = quoteImpactBps(tokenOut, notionalUsdE8);
      const amountOut = (grossOut * (BPS_DENOMINATOR - impactBps)) / BPS_DENOMINATOR;

      return json({
        token_in: body.token_in,
        token_out: tokenOut,
        amount_out: amountOut.toString(),
        price_impact_bps: impactBps.toString(),
      });
    }

    if (request.method === "POST" && url.pathname === "/execute-rebalance") {
      const body = await request.json();
      console.log(`[mock] execute-rebalance ${JSON.stringify(body.trades)}`);
      return json({
        execution_id: `mock-exec-${Date.now()}`,
        accepted_legs: (body.trades ?? []).length,
      });
    }

    return json({ error: `no route for ${request.method} ${url.pathname}` }, 404);
  },
});

console.log(`[mock] DeFi Copilot stand-in listening on http://127.0.0.1:${server.port}`);
