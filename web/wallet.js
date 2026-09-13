/**
 * WalletConnect pairing and allowance approval.
 *
 * Loaded as a module so the WalletConnect SDK can come from a CDN without a
 * build step. The server never sees a private key: it builds the unsigned
 * allowance transaction, and the wallet signs it.
 *
 * Flow (HIP-820):
 *   1. SignClient.connect() -> a `wc:` pairing URI, rendered as a QR
 *   2. user scans with HashPack and approves the session
 *   3. server builds an unsigned AccountAllowanceApproveTransaction
 *   4. hedera_signAndExecuteTransaction sends it to the wallet to sign
 */

const CDN = {
  signClient: "https://esm.sh/@walletconnect/sign-client@2",
  qrcode: "https://esm.sh/qrcode@1.5.4",
};

const $ = (id) => document.getElementById(id);

let signClient = null;
let session = null;
let walletConfig = null;

const state = {
  set(message, kind = "muted") {
    const el = $("walletStatus");
    el.textContent = message;
    el.style.color = `var(--${kind})`;
  },
};

async function loadConfig() {
  walletConfig = await fetch("/api/wallet/config").then((r) => r.json());
  const configured = walletConfig.project_id_configured;
  $("wcSetup").classList.toggle("hidden", configured);
  $("connectBtn").disabled = !configured;
  if (!walletConfig.spender_account_id) {
    state.set("No agent account configured (HEDERA_OPERATOR_ID).", "warn");
  }
  return walletConfig;
}

async function saveProjectId() {
  const projectId = $("wcProjectId").value.trim();
  if (!projectId) return;
  $("wcError").classList.add("hidden");
  try {
    const res = await fetch("/api/config/walletconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, persist: $("wcPersist").checked }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail);
    $("wcProjectId").value = "";
    await loadConfig();
    state.set("Project id saved. Ready to connect.", "good");
  } catch (err) {
    $("wcError").textContent = err.message;
    $("wcError").classList.remove("hidden");
  }
}

async function connect() {
  $("connectBtn").disabled = true;
  state.set("Opening a WalletConnect session…");
  try {
    const [{ default: SignClient }, QRCode] = await Promise.all([
      import(CDN.signClient),
      import(CDN.qrcode),
    ]);

    const { project_id: projectId } = await fetch("/api/config/walletconnect")
      .then((r) => r.json());

    signClient = await SignClient.init({
      projectId,
      metadata: {
        name: "DeFi Copilot",
        description: "Autonomous HTS portfolio rebalancing on Hedera",
        url: window.location.origin,
        icons: [`${window.location.origin}/static/icon.png`],
      },
    });

    signClient.on("session_delete", () => {
      session = null;
      showDisconnected();
    });

    const { uri, approval } = await signClient.connect({
      requiredNamespaces: {
        hedera: {
          chains: [walletConfig.chain_id],
          methods: ["hedera_signAndExecuteTransaction", "hedera_signTransaction"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    });

    if (uri) {
      const canvas = $("qrCanvas");
      await (QRCode.default || QRCode).toCanvas(canvas, uri, {
        width: 260,
        margin: 1,
        color: { dark: "#e6e8ee", light: "#0f1115" },
      });
      $("qrBox").classList.remove("hidden");
      $("wcUri").value = uri;
      state.set("Scan with HashPack, then approve the connection.");
    }

    session = await approval();
    showConnected();
  } catch (err) {
    state.set(`Could not connect: ${err.message}`, "bad");
    $("connectBtn").disabled = false;
  }
}

function connectedAccount() {
  // CAIP-10: "hedera:testnet:0.0.x"
  const accounts = session?.namespaces?.hedera?.accounts || [];
  return accounts[0]?.split(":").pop() || null;
}

function showConnected() {
  $("qrBox").classList.add("hidden");
  $("connectBtn").classList.add("hidden");
  $("walletConnected").classList.remove("hidden");
  const account = connectedAccount();
  $("walletAccount").textContent = account || "unknown";
  state.set("Wallet connected.", "good");
  if (account) $("account").value = account;
}

function showDisconnected() {
  $("qrBox").classList.add("hidden");
  $("walletConnected").classList.add("hidden");
  $("connectBtn").classList.remove("hidden");
  $("connectBtn").disabled = false;
  state.set("Wallet disconnected.");
}

async function disconnect() {
  if (signClient && session) {
    try {
      await signClient.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: "User disconnected" },
      });
    } catch (err) {
      /* the session may already be gone; the UI reset below is what matters */
    }
  }
  session = null;
  showDisconnected();
}

function readGrants() {
  return [...document.querySelectorAll(".grant-row")]
    .map((row) => ({
      symbol: row.querySelector("select").value,
      amount: row.querySelector("input").value.trim(),
    }))
    .filter((g) => g.amount && Number(g.amount) > 0);
}

async function requestApproval() {
  const owner = connectedAccount();
  if (!owner) return state.set("Connect a wallet first.", "warn");

  const grants = readGrants();
  if (!grants.length) return state.set("Set a spending cap for at least one token.", "warn");

  $("approveBtn").disabled = true;
  state.set("Building the allowance…");
  try {
    const res = await fetch("/api/wallet/allowance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_account_id: owner, grants }),
    });
    const built = await res.json();
    if (!res.ok) throw new Error(built.detail);

    state.set("Approve the allowance in your wallet…");
    const result = await signClient.request({
      topic: session.topic,
      chainId: built.chain_id,
      request: {
        method: built.method,
        params: {
          signerAccountId: built.signer_account_id,
          transactionList: built.transaction_list_base64,
        },
      },
    });

    state.set(
      `Allowance granted: ${built.summary.join(", ")} to ${built.spender_account_id}.`,
      "good"
    );
    $("approvalResult").textContent = JSON.stringify(result, null, 2);
    $("approvalResult").classList.remove("hidden");
  } catch (err) {
    state.set(`Approval failed: ${err.message}`, "bad");
  } finally {
    $("approveBtn").disabled = false;
  }
}

// -------------------------------------------------------------- grant rows

function grantRow(symbol = "HBAR", amount = "") {
  const tokens = ["HBAR", "USDC", "DAI", "SAUCE", "CLXY", "HBARX"];
  const div = document.createElement("div");
  div.className = "row mt grant-row";
  div.innerHTML = `
    <select style="flex:1;min-width:110px">
      ${tokens.map((t) => `<option ${t === symbol ? "selected" : ""}>${t}</option>`).join("")}
    </select>
    <input type="number" min="0" step="any" value="${amount}"
           placeholder="max amount" style="width:150px">
    <button class="ghost remove" title="Remove">&times;</button>`;
  div.querySelector(".remove").onclick = () => div.remove();
  return div;
}

export function initWallet() {
  $("grantRows").appendChild(grantRow("HBAR", 500));
  $("grantRows").appendChild(grantRow("USDC", 200));

  $("saveWcBtn").onclick = saveProjectId;
  $("connectBtn").onclick = connect;
  $("disconnectBtn").onclick = disconnect;
  $("approveBtn").onclick = requestApproval;
  $("addGrant").onclick = () => $("grantRows").appendChild(grantRow());
  $("copyUri").onclick = () => {
    $("wcUri").select();
    document.execCommand("copy");
    state.set("Pairing link copied.", "good");
  };

  loadConfig().catch(() => state.set("Could not reach the backend.", "bad"));
}
