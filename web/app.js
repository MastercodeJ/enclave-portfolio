"use strict";

const $ = (id) => document.getElementById(id);
const api = async (path, options) => {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `${res.status} ${res.statusText}`);
  return body;
};
const busy = (spinnerId, on) => $(spinnerId).classList.toggle("hidden", !on);

const EXAMPLES = [
  "Keep me 50/30/20 HBAR USDC SAUCE, rebalance weekly, never trade more than 20% at once",
  "Half HBAR half USDC, rebalance daily",
  "Equal split across HBAR, USDC and DAI",
  "All in HBAR",
];

let TOKENS = [];

// ---------------------------------------------------------------- status

function applyLlmState(configured, network, model, maskedKey) {
  $("statusDot").className = "dot " + (configured ? "on" : "off");
  $("statusText").textContent = configured
    ? `${network} · ${model}`
    : `${network} · no LLM key`;

  $("parseBtn").disabled = !configured;
  $("noLlm").classList.toggle("hidden", configured);
  $("keyForm").classList.toggle("hidden", configured);
  $("keyActive").classList.toggle("hidden", !configured);
  $("keyHint").classList.toggle("hidden", configured);
  $("keyStatus").textContent = configured ? `${maskedKey} · ${model}` : "not set";
  $("keyStatus").style.color = configured ? "var(--good)" : "var(--muted)";
}

async function loadHealth() {
  try {
    const [health, llm] = await Promise.all([
      api("/api/health"),
      api("/api/config/llm").catch(() => ({ ok: false })),
    ]);
    applyLlmState(
      health.llm_configured,
      health.network,
      llm.model || health.detail.model,
      llm.masked_key
    );
    updateSetupSummary();
  } catch (err) {
    $("statusDot").className = "dot off";
    $("statusText").textContent = "backend unreachable";
  }
}

/**
 * Summarise what is configured, and open the Setup block only when nothing
 * is. Setup should never look like a gate: the strategy builder, holdings and
 * prices all work with none of it.
 */
async function updateSetupSummary() {
  const [operator, llm, wallet] = await Promise.all([
    api("/api/operator").catch(() => ({ ok: false })),
    api("/api/config/llm").catch(() => ({ ok: false })),
    api("/api/wallet/config").catch(() => ({ project_id_configured: false })),
  ]);

  const done = [
    operator.ok && "agent account",
    llm.ok && "AI model",
    wallet.project_id_configured && "wallet",
  ].filter(Boolean);

  $("setupSummary").textContent = done.length
    ? `${done.join(", ")} configured`
    : "nothing configured yet — optional";
  $("setupSummary").style.color = done.length ? "var(--good)" : "var(--muted)";

  // Only spring open on a completely fresh install.
  if (!done.length && !$("setupBlock").dataset.touched) {
    $("setupBlock").open = true;
  }
  $("setupBlock").dataset.touched = "1";
}

// ---------------------------------------------------------------- operator

function applyOperatorState(data) {
  const configured = Boolean(data && data.ok);
  $("opForm").classList.toggle("hidden", configured);
  $("opActive").classList.toggle("hidden", !configured);
  $("opHint").classList.toggle("hidden", configured);
  $("opStatus").textContent = configured ? `${data.account_id} · verified` : "not set";
  $("opStatus").style.color = configured ? "var(--good)" : "var(--muted)";

  if (configured) {
    $("opAccountOut").textContent = data.account_id || "—";
    $("opKeyType").textContent = data.key_type || "verified";
    $("opBalance").textContent = data.balance_hbar ? `${data.balance_hbar} HBAR` : "—";
    $("opEvm").textContent = data.evm_address || "—";
  }

  const warnings = (data && data.warnings) || [];
  $("opWarnings").innerHTML = warnings
    .map((w) => `<div class="notice mt">${w}</div>`)
    .join("");
}

async function loadOperator() {
  try {
    applyOperatorState(await api("/api/operator"));
  } catch (err) {
    applyOperatorState(null);
  }
}

async function saveOperator() {
  const accountId = $("opAccount").value.trim();
  const privateKey = $("opKey").value.trim();
  if (!accountId || !privateKey) return;

  $("opError").classList.add("hidden");
  busy("opSpin", true);
  $("saveOpBtn").disabled = true;
  try {
    const result = await api("/api/operator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        private_key: privateKey,
        persist: $("opPersist").checked,
      }),
    });
    // Clear immediately: no reason for the key to stay in the DOM.
    $("opKey").value = "";
    $("opAccount").value = "";
    applyOperatorState(result);
    updateSetupSummary();
  } catch (err) {
    $("opError").textContent = err.message;
    $("opError").classList.remove("hidden");
  } finally {
    busy("opSpin", false);
    $("saveOpBtn").disabled = false;
  }
}

async function clearOperator() {
  await api("/api/operator", { method: "DELETE" });
  await loadOperator();
}

// ---------------------------------------------------------------- llm key

async function saveKey() {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) return;
  $("keyError").classList.add("hidden");
  busy("keySpin", true);
  $("saveKeyBtn").disabled = true;
  try {
    const result = await api("/api/config/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        model: $("modelName").value.trim() || null,
        persist: $("persistKey").checked,
        verify: $("verifyKey").checked,
      }),
    });
    // Clear the field immediately: no reason to keep it in the DOM.
    $("apiKey").value = "";
    applyLlmState(true, "testnet", result.model, result.masked_key);
    updateSetupSummary();
    $("keyStatus").textContent += result.persisted ? " · saved" : " · this session";
  } catch (err) {
    $("keyError").textContent = err.message;
    $("keyError").classList.remove("hidden");
  } finally {
    busy("keySpin", false);
    $("saveKeyBtn").disabled = false;
  }
}

async function clearKey() {
  await api("/api/config/llm", { method: "DELETE" });
  await loadHealth();
}

// ---------------------------------------------------------------- market

async function loadTokens() {
  try {
    TOKENS = await api("/api/tokens");
  } catch (err) {
    $("tokens").innerHTML = `<p class="hint">Could not load tokens: ${err.message}</p>`;
    return;
  }
  const rows = TOKENS.map(
    (t) => `<tr>
      <td><strong>${t.symbol}</strong></td>
      <td class="tid">${t.token_id}</td>
      <td class="num">${t.price_hbar ? Number(t.price_hbar).toFixed(8) : "—"}</td>
      <td class="num">${t.price_usd ? "$" + Number(t.price_usd).toFixed(6) : "—"}</td>
    </tr>`
  ).join("");
  $("tokens").innerHTML =
    `<table><thead><tr><th>Token</th><th>ID</th>
     <th class="num">HBAR</th><th class="num">USD</th></tr></thead>
     <tbody>${rows}</tbody></table>`;
  $("marketNote").textContent = `${TOKENS.filter((t) => t.tradable).length} with liquidity`;
  buildManualRows();
}

// ---------------------------------------------------------------- results

function showProblems(problems) {
  $("resultCard").classList.remove("hidden");
  $("resultTitle").textContent = "Needs a change";
  $("resultSource").textContent = "";
  $("strategy").innerHTML = "";
  $("problems").innerHTML = problems
    .map(
      (p) => `<div class="problem">
        <div class="field">${p.field}</div>
        <div>${p.reason}</div>
        ${p.suggestion ? `<div class="sugg">${p.suggestion}</div>` : ""}
      </div>`
    )
    .join("");
}

function showStrategy(s) {
  $("resultCard").classList.remove("hidden");
  $("resultTitle").textContent = "Strategy";
  $("resultSource").textContent = s.source_prompt;
  $("problems").innerHTML = "";

  const rows = s.allocations
    .map(
      (a) => `<tr>
        <td><strong>${a.symbol}</strong></td>
        <td class="tid">${a.token_id}</td>
        <td class="num">${a.percent}%</td>
        <td style="width:38%"><div class="bar"><i style="width:${a.percent}%"></i></div></td>
      </tr>`
    )
    .join("");

  $("strategy").innerHTML = `
    <table><tbody>${rows}</tbody></table>
    <div class="limits">
      <div class="limit"><div class="k">Rebalance</div><div class="v">${s.cadence}</div></div>
      <div class="limit"><div class="k">Drift trigger</div><div class="v">${s.drift_threshold_pct}%</div></div>
      <div class="limit"><div class="k">Max per trade</div><div class="v">${s.max_trade_pct}%</div></div>
      <div class="limit"><div class="k">Max impact</div><div class="v">${s.max_price_impact_pct}%</div></div>
    </div>`;
}

function render(result) {
  if (result.ok) showStrategy(result.strategy);
  else showProblems(result.problems);
  $("resultCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------------------------------------------------------- prompt

async function parsePrompt() {
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  busy("parseSpin", true);
  $("parseBtn").disabled = true;
  try {
    render(await api("/api/strategy/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
  } catch (err) {
    showProblems([{ field: "prompt", reason: err.message }]);
  } finally {
    busy("parseSpin", false);
    $("parseBtn").disabled = false;
  }
}

// ---------------------------------------------------------------- manual

function manualRow(symbol = "", percent = "") {
  const options = TOKENS.map(
    (t) => `<option value="${t.symbol}" ${t.symbol === symbol ? "selected" : ""}>${t.symbol}</option>`
  ).join("");
  const div = document.createElement("div");
  div.className = "row mt manual-row";
  div.innerHTML = `
    <select style="flex:1;min-width:120px">${options}</select>
    <input type="number" class="pct" value="${percent}" min="0" max="100" step="0.01"
           placeholder="%" style="width:110px">
    <button class="ghost remove" title="Remove">&times;</button>`;
  div.querySelector(".remove").onclick = () => { div.remove(); updateTotal(); };
  div.querySelector(".pct").oninput = updateTotal;
  return div;
}

function buildManualRows() {
  const host = $("manualRows");
  host.innerHTML = "";
  host.appendChild(manualRow("HBAR", 50));
  host.appendChild(manualRow("USDC", 50));
  updateTotal();
}

function readManual() {
  return [...document.querySelectorAll(".manual-row")]
    .map((row) => ({
      symbol: row.querySelector("select").value,
      percent: parseFloat(row.querySelector(".pct").value || "0"),
    }))
    .filter((a) => a.symbol);
}

function updateTotal() {
  const total = readManual().reduce((sum, a) => sum + (a.percent || 0), 0);
  const rounded = Math.round(total * 100) / 100;
  $("manualTotal").textContent = `total ${rounded}%`;
  $("manualTotal").style.color =
    Math.abs(rounded - 100) < 0.01 ? "var(--good)" : "var(--muted)";
}

async function validateManual() {
  busy("validateSpin", true);
  $("validateBtn").disabled = true;
  try {
    render(await api("/api/strategy/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allocations: readManual() }),
    }));
  } catch (err) {
    showProblems([{ field: "allocations", reason: err.message }]);
  } finally {
    busy("validateSpin", false);
    $("validateBtn").disabled = false;
  }
}

// ---------------------------------------------------------------- portfolio

async function loadPortfolio() {
  const address = $("account").value.trim();
  if (!address) return;
  busy("portfolioSpin", true);
  try {
    const p = await api(`/api/portfolio/${encodeURIComponent(address)}`);
    const rows = p.positions
      .map(
        (t) => `<tr>
          <td><strong>${t.symbol || "—"}</strong></td>
          <td class="tid">${t.token_id}</td>
          <td class="num">${t.amount}</td>
          <td>${t.transferable ? "" : '<span style="color:var(--warn)">blocked</span>'}</td>
        </tr>`
      )
      .join("");
    $("portfolio").innerHTML = `
      <table>
        <thead><tr><th>Asset</th><th>ID</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>
          <tr><td><strong>HBAR</strong></td><td class="tid">native</td>
              <td class="num">${p.hbar}</td><td></td></tr>
          ${rows}
        </tbody>
      </table>
      ${p.positions.length ? "" : '<p class="hint mt">No fungible tokens held yet.</p>'}`;
  } catch (err) {
    $("portfolio").innerHTML = `<div class="problem"><div>${err.message}</div></div>`;
  } finally {
    busy("portfolioSpin", false);
  }
}

// ---------------------------------------------------------------- wiring

$("examples").innerHTML = EXAMPLES.map(
  (e, i) => `<button data-i="${i}">${e.length > 46 ? e.slice(0, 44) + "…" : e}</button>`
).join("");
$("examples").onclick = (event) => {
  const index = event.target.dataset.i;
  if (index !== undefined) $("prompt").value = EXAMPLES[index];
};

$("saveOpBtn").onclick = saveOperator;
$("clearOpBtn").onclick = clearOperator;
$("opKey").onkeydown = (e) => { if (e.key === "Enter") saveOperator(); };
$("saveKeyBtn").onclick = saveKey;
$("clearKeyBtn").onclick = clearKey;
$("apiKey").onkeydown = (e) => { if (e.key === "Enter") saveKey(); };
$("parseBtn").onclick = parsePrompt;
$("validateBtn").onclick = validateManual;
$("addRow").onclick = () => { $("manualRows").appendChild(manualRow()); updateTotal(); };
$("loadBtn").onclick = loadPortfolio;
$("account").onkeydown = (e) => { if (e.key === "Enter") loadPortfolio(); };
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) parsePrompt();
};

loadHealth();
loadOperator();
loadTokens();
