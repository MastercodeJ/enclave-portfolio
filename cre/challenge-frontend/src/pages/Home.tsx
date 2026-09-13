import { useState, useCallback, useEffect } from "react";
import { type Abi } from "viem";
import { ContractBox } from "@/components/ContractBox";
import { useWallet } from "@/lib/wallet";
import { useRead, useWrite, useUserPosition } from "@/lib/hooks";
import type { UserPosition } from "@/lib/hooks";
import { publicClient } from "@/lib/client";
import {
  LENDING_ABI,
  ERC20_ABI,
  getLendingAddress,
  getVethAddress,
  getVusdAddress,
} from "@/lib/contract";

// ─── Display helpers ──────────────────────────────────────────────────────────

const MAX_U256 = 2n ** 256n - 1n;

function fmtUnits(raw: bigint | undefined, decimals = 2): string {
  if (raw === undefined) return "—";
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtHF(raw: bigint | undefined): string {
  if (raw === undefined) return "—";
  if (raw === MAX_U256) return "∞";
  return (Number(raw) / 100).toFixed(2);
}

function hfClass(raw: bigint | undefined): string {
  if (raw === undefined || raw === MAX_U256) return "hf-safe";
  const hf = Number(raw);
  if (hf > 107) return "hf-safe";
  if (hf > 100) return "hf-warning";
  return "hf-danger";
}

function statusBadge(raw: bigint | undefined): { label: string; cls: string } {
  if (raw === undefined) return { label: "—", cls: "" };
  if (raw === MAX_U256) return { label: "Safe", cls: "badge-safe" };
  const hf = Number(raw);
  if (hf > 107) return { label: "Safe", cls: "badge-safe" };
  if (hf > 100) return { label: "At Risk", cls: "badge-warning" };
  return { label: "Liquidatable", cls: "badge-danger" };
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtDebtTime(raw: bigint): string {
  if (raw === 0n) return "—";
  // debt-time = vUSD-units * seconds. Show in "vUSD·days"
  const vUsdDays = Number(raw) / 100 / 86400;
  if (vUsdDays < 1) return `${(Number(raw) / 100 / 3600).toFixed(1)} vUSD·hr`;
  return `${vUsdDays.toFixed(1)} vUSD·day`;
}

// ─── Input helpers ────────────────────────────────────────────────────────────

function displayToUnits(displayVal: string): bigint {
  const f = parseFloat(displayVal);
  if (isNaN(f) || f <= 0) return 0n;
  return BigInt(Math.floor(f * 100));
}

// ─── Scenario start chip ─────────────────────────────────────────────────────

function ScenarioStartChip({ lendingAddress, enabled }: { lendingAddress: `0x${string}`; enabled: boolean }) {
  const { data: scenarioStart } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "scenarioStartTime", enabled },
    [lendingAddress]
  );
  const started = scenarioStart !== undefined && scenarioStart > 0n;
  const label = scenarioStart === undefined
    ? "—"
    : started
    ? new Date(Number(scenarioStart) * 1000).toLocaleString()
    : "Not started";
  return (
    <div className="stat-chip">
      <span className="stat-chip-label">Scenario Start</span>
      <span className="stat-chip-value" style={{ fontSize: started ? "0.875rem" : undefined, color: started ? "var(--emerald-400)" : undefined }}>
        {label}
      </span>
    </div>
  );
}

function ChallengeOpenChip({ lendingAddress, enabled }: { lendingAddress: `0x${string}`; enabled: boolean }) {
  const { data: isOpen } = useRead<boolean>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "challengeOpen", enabled },
    [lendingAddress]
  );
  return (
    <div className="stat-chip">
      <span className="stat-chip-label">Registration</span>
      <span className="stat-chip-value" style={{ color: isOpen ? "var(--emerald-400)" : "var(--red-400)" }}>
        {isOpen === undefined ? "—" : isOpen ? "Open" : "Closed"}
      </span>
    </div>
  );
}

// ─── Protocol stats ───────────────────────────────────────────────────────────

interface ProtocolStatsProps {
  lendingAddress: `0x${string}`;
  enabled: boolean;
}

function ProtocolStats({ lendingAddress, enabled }: ProtocolStatsProps) {
  const { data: ethPrice } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "vETHPrice", enabled },
    [lendingAddress]
  );
  const { data: maxLtv } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "MAX_LTV", enabled },
    [lendingAddress]
  );
  const { data: liquiThresh } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "LIQUI_THRESHOLD", enabled },
    [lendingAddress]
  );
  const { data: numUsers } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "numUsers", enabled },
    [lendingAddress]
  );

  return (
    <div className="stats-strip" style={{ marginBottom: "2rem" }}>
      <div className="stat-chip">
        <span className="stat-chip-label">ETH Price</span>
        <span className="stat-chip-value">
          {ethPrice !== undefined ? `${fmtUnits(ethPrice)} vUSD/vETH` : "—"}
        </span>
      </div>
      <div className="stat-chip">
        <span className="stat-chip-label">Participants</span>
        <span className="stat-chip-value">{numUsers !== undefined ? numUsers.toString() : "—"}</span>
      </div>
      <div className="stat-chip">
        <span className="stat-chip-label">MAX LTV</span>
        <span className="stat-chip-value">{maxLtv !== undefined ? `${maxLtv}%` : "—"}</span>
      </div>
      <div className="stat-chip">
        <span className="stat-chip-label">Liquidation Threshold</span>
        <span className="stat-chip-value">{liquiThresh !== undefined ? `${liquiThresh}%` : "—"}</span>
      </div>
      <ScenarioStartChip lendingAddress={lendingAddress} enabled={enabled} />
      <ChallengeOpenChip lendingAddress={lendingAddress} enabled={enabled} />
    </div>
  );
}

// ─── My Position ─────────────────────────────────────────────────────────────

interface MyPositionProps {
  lendingAddress: `0x${string}`;
  address: `0x${string}`;
  refreshTick: number;
  onRefresh: () => void;
}

function MyPosition({ lendingAddress, address, refreshTick, onRefresh }: MyPositionProps) {
  const vethAddr = getVethAddress();
  const vusdAddr = getVusdAddress();

  const { data: position, refetch: refetchPosition } = useUserPosition(lendingAddress, LENDING_ABI, address);
  const collateral = position?.collateral;
  const debt = position?.debt;
  const hf = position?.hf;

  const { data: vethBal, refetch: refetchVeth } = useRead<bigint>(
    { address: vethAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [address] },
    [vethAddr, address]
  );
  const { data: vusdBal, refetch: refetchVusd } = useRead<bigint>(
    { address: vusdAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [address] },
    [vusdAddr, address]
  );

  useEffect(() => {
    if (refreshTick === 0) return;
    refetchPosition();
    refetchVeth();
    refetchVusd();
  }, [refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refetchAll = useCallback(() => {
    refetchPosition();
    refetchVeth();
    refetchVusd();
    onRefresh();
  }, [refetchPosition, refetchVeth, refetchVusd, onRefresh]);

  const badge = statusBadge(hf);

  return (
    <div className="panel" style={{ marginBottom: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 className="subhead" style={{ margin: 0 }}>My Position</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span style={{ fontSize: "0.875rem", color: "var(--gray-400)" }}>
            Wallet Balances:{" "}
            <strong style={{ color: "#fff" }}>vETH {fmtUnits(vethBal)}</strong>
            <span style={{ display: "inline-block", width: "1.5rem" }} />
            <strong style={{ color: "#fff" }}>vUSD {fmtUnits(vusdBal)}</strong>
          </span>
          <button className="btn btn-sm btn-secondary" onClick={refetchAll}>Refresh</button>
        </div>
      </div>
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: "1rem" }}>
        <div className="stat">
          <div className="stat-label">Collateral</div>
          <div className="stat-value">{fmtUnits(collateral)} vETH</div>
        </div>
        <div className="stat">
          <div className="stat-label">Debt</div>
          <div className="stat-value">{fmtUnits(debt)} vUSD</div>
        </div>
        <div className="stat">
          <div className="stat-label">Health Factor</div>
          <div className={`stat-value ${hfClass(hf)}`}>{fmtHF(hf)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Status</div>
          <div className="stat-value">
            <span className={`badge badge-lg ${badge.cls}`}>{badge.label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Action Panel ─────────────────────────────────────────────────────────────

type ActionTab = "deposit" | "borrow" | "repay" | "withdraw";

interface ActionPanelProps {
  lendingAddress: `0x${string}`;
  address: `0x${string}`;
  onTxSuccess: () => void;
}

function ActionPanel({ lendingAddress, address, onTxSuccess }: ActionPanelProps) {
  const { walletClient } = useWallet();
  const [tab, setTab] = useState<ActionTab>("deposit");
  const [amount, setAmount] = useState("");
  const { write, isPending, isConfirming, isSuccess, error, reset } = useWrite(walletClient);

  const { data: challengeOpen } = useRead<boolean>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "challengeOpen" },
    [lendingAddress]
  );
  const { data: scenarioStart } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "scenarioStartTime" },
    [lendingAddress]
  );
  const isActive = !!challengeOpen && scenarioStart !== undefined && scenarioStart > 0n;

  const vethAddr = getVethAddress();
  const vusdAddr = getVusdAddress();

  const { data: vethAllowance, refetch: refetchVethAllow } = useRead<bigint>(
    { address: vethAddr, abi: ERC20_ABI, functionName: "allowance", args: [address, lendingAddress] },
    [vethAddr, address, lendingAddress]
  );
  const { data: vusdAllowance, refetch: refetchVusdAllow } = useRead<bigint>(
    { address: vusdAddr, abi: ERC20_ABI, functionName: "allowance", args: [address, lendingAddress] },
    [vusdAddr, address, lendingAddress]
  );

  const units = displayToUnits(amount);
  const isBusy = isPending || isConfirming;

  const needsApprove = (() => {
    if (tab === "deposit" && vethAllowance !== undefined && units > 0n) return vethAllowance < units;
    if (tab === "repay" && vusdAllowance !== undefined && units > 0n) return vusdAllowance < units;
    return false;
  })();

  const handleSubmit = async () => {
    if (units === 0n) return;
    reset();

    // Approve flow for deposit / repay
    if (tab === "deposit" && needsApprove) {
      const ok = await write({
        address: vethAddr,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [lendingAddress, units],
      });
      if (!ok) return;
      refetchVethAllow();
    }
    if (tab === "repay" && needsApprove) {
      const ok = await write({
        address: vusdAddr,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [lendingAddress, units],
      });
      if (!ok) return;
      refetchVusdAllow();
    }

    const fnMap: Record<ActionTab, string> = {
      deposit: "deposit",
      borrow: "borrow",
      repay: "repay",
      withdraw: "withdrawCollateral",
    };

    const ok = await write({
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: fnMap[tab],
      args: [units],
    });
    if (ok) {
      setAmount("");
      onTxSuccess();
    }
  };

  const tokenLabel = (t: ActionTab) => {
    if (t === "deposit" || t === "withdraw") return "vETH";
    return "vUSD";
  };

  return (
    <div className="panel" style={{ marginBottom: "2rem" }}>
      <h2 className="subhead">Actions</h2>
      <div className="action-tabs">
        {(["deposit", "borrow", "repay", "withdraw"] as ActionTab[]).map((t) => (
          <button
            key={t}
            className={`action-tab${tab === t ? " active" : ""}`}
            onClick={() => { setTab(t); setAmount(""); reset(); }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="field">
        <label className="field-label">
          Amount ({tokenLabel(tab)})
        </label>
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          placeholder={`e.g. 1.00 ${tokenLabel(tab)}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {amount && units > 0n && (
          <div className="field-hint">= {units.toString()} on-chain units</div>
        )}
      </div>

      {!isActive && (
        <div className="info-box info-pending" style={{ marginBottom: "0.75rem" }}>
          {!challengeOpen
            ? "Actions are unavailable — registration is closed."
            : "Actions are unavailable — the scenario has not started yet."}
        </div>
      )}

      {isActive && needsApprove && (
        <div className="info-box info-pending" style={{ marginBottom: "0.75rem" }}>
          Approval required — clicking submit will send 2 transactions: first approve, then {tab}.
        </div>
      )}

      <button
        className="btn btn-primary btn-block"
        disabled={isBusy || units === 0n || !isActive}
        onClick={handleSubmit}
      >
        {isPending
          ? "Waiting for wallet…"
          : isConfirming
          ? "Confirming…"
          : needsApprove
          ? `Approve + ${tab.charAt(0).toUpperCase() + tab.slice(1)}`
          : tab.charAt(0).toUpperCase() + tab.slice(1)}
      </button>

      {isSuccess && (
        <div className="info-box" style={{ marginTop: "0.75rem", color: "var(--emerald-400)" }}>
          Transaction confirmed!
        </div>
      )}
      {error && (
        <div className="alert-error" style={{ marginTop: "0.75rem" }}>{error}</div>
      )}
    </div>
  );
}

// ─── Admin Panel ──────────────────────────────────────────────────────────────

interface AdminPanelProps {
  lendingAddress: `0x${string}`;
  onTxSuccess: () => void;
}

function AdminPanel({ lendingAddress, onTxSuccess }: AdminPanelProps) {
  const { walletClient } = useWallet();
  const [open, setOpen] = useState(false);
  const [newPrice, setNewPrice] = useState("");
  const { write, isPending, isConfirming, isSuccess, error, reset } = useWrite(walletClient);
  const { write: write2, isPending: p2, isConfirming: c2, isSuccess: s2, error: e2 } = useWrite(walletClient);
  const { write: write3, isPending: p3, isConfirming: c3, isSuccess: s3, error: e3 } = useWrite(walletClient);
  const { write: writeOpen, isPending: pOpen, isConfirming: cOpen, isSuccess: sOpen, error: eOpen } = useWrite(walletClient);

  const { data: challengeOpen, refetch: refetchChallengeOpen } = useRead<boolean>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "challengeOpen" },
    [lendingAddress]
  );

  const isBusyOpen = pOpen || cOpen;

  const handleOpen = async () => {
    const ok = await writeOpen({ address: lendingAddress, abi: LENDING_ABI, functionName: "open", args: [] });
    if (ok) { refetchChallengeOpen(); onTxSuccess(); }
  };

  const handleClose = async () => {
    const ok = await writeOpen({ address: lendingAddress, abi: LENDING_ABI, functionName: "close", args: [] });
    if (ok) { refetchChallengeOpen(); onTxSuccess(); }
  };

  const { data: currentPrice, refetch: refetchPrice } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "vETHPrice" },
    [lendingAddress]
  );
  const { data: scenarioStart, refetch: refetchStart } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "scenarioStartTime" },
    [lendingAddress]
  );
  const { data: scenarioEnd, refetch: refetchEnd } = useRead<bigint>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "scenarioEndTime" },
    [lendingAddress]
  );

  const scenarioStarted = scenarioStart !== undefined && scenarioStart > 0n;
  const scenarioStopped = scenarioEnd !== undefined && scenarioEnd > 0n;
  const scenarioStartDate = scenarioStarted ? new Date(Number(scenarioStart) * 1000).toLocaleString() : null;
  const scenarioEndDate = scenarioStopped ? new Date(Number(scenarioEnd) * 1000).toLocaleString() : null;

  const isBusy = isPending || isConfirming;
  const isBusy2 = p2 || c2;
  const isBusy3 = p3 || c3;

  const handlePriceUpdate = async () => {
    reset();
    const f = parseFloat(newPrice);
    if (isNaN(f) || f <= 0) return;
    const units = BigInt(Math.floor(f * 100));
    const ok = await write({
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: "updatevETHPrice",
      args: [units],
    });
    if (ok) { setNewPrice(""); refetchPrice(); onTxSuccess(); }
  };

  const handleCheckAll = async () => {
    await write2({
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: "checkAllHF",
      args: [],
    });
    onTxSuccess();
  };

  const handleStart = async () => {
    const ok = await write3({
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: "start",
      args: [],
    });
    if (ok) { refetchStart(); onTxSuccess(); }
  };

  const { write: write4, isPending: p4, isConfirming: c4, isSuccess: s4, error: e4 } = useWrite(walletClient);
  const isBusy4 = p4 || c4;

  const handleStop = async () => {
    const ok = await write4({
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: "stop",
      args: [],
    });
    if (ok) { refetchEnd(); onTxSuccess(); }
  };

  return (
    <div className="panel" style={{ marginBottom: "2rem", borderColor: "rgba(234,179,8,0.3)" }}>
      <button
        className="link-btn"
        style={{ fontSize: "1rem", fontWeight: 700, color: "var(--yellow-400)", width: "100%", textAlign: "left", marginBottom: open ? "1rem" : 0 }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"} Admin Panel
      </button>

      {open && (
        <div className="stack-sm">
          {/* Challenge open / close */}
          <div style={{ fontSize: "0.875rem", color: "var(--gray-400)" }}>
            Registration:{" "}
            <strong style={{ color: challengeOpen ? "var(--emerald-400)" : "var(--red-400)" }}>
              {challengeOpen === undefined ? "—" : challengeOpen ? "Open" : "Closed"}
            </strong>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={isBusyOpen || !!challengeOpen}
              onClick={handleOpen}
            >
              {pOpen ? "Waiting…" : cOpen ? "Confirming…" : "Open Registration"}
            </button>
            <button
              className="btn btn-warning"
              style={{ flex: 1 }}
              disabled={isBusyOpen || !challengeOpen}
              onClick={handleClose}
            >
              {pOpen ? "Waiting…" : cOpen ? "Confirming…" : "Close Registration"}
            </button>
          </div>
          {sOpen && <div className="info-box" style={{ color: "var(--emerald-400)" }}>Registration status updated!</div>}
          {eOpen && <div className="alert-error">{eOpen}</div>}

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />

          {/* Scenario start / stop */}
          <div style={{ fontSize: "0.875rem", color: "var(--gray-400)" }}>
            Scenario Start:{" "}
            <strong style={{ color: scenarioStarted ? "var(--emerald-400)" : "#fff" }}>
              {scenarioStart === undefined ? "—" : scenarioStarted ? scenarioStartDate : "Not started"}
            </strong>
          </div>
          {scenarioStopped && (
            <div style={{ fontSize: "0.875rem", color: "var(--gray-400)" }}>
              Scenario End:{" "}
              <strong style={{ color: "var(--red-400)" }}>{scenarioEndDate}</strong>
            </div>
          )}
          {!scenarioStarted && (
            <>
              <button className="btn btn-primary btn-block" disabled={isBusy3} onClick={handleStart}>
                {p3 ? "Waiting…" : c3 ? "Confirming…" : "▶ Start Scenario"}
              </button>
              {s3 && <div className="info-box" style={{ color: "var(--emerald-400)" }}>Scenario started! Shared debt-time clock is now running.</div>}
              {e3 && <div className="alert-error">{e3}</div>}
            </>
          )}
          {scenarioStarted && !scenarioStopped && (
            <>
              <button className="btn btn-block" style={{ backgroundColor: "var(--red-400)", color: "#000" }} disabled={isBusy4} onClick={handleStop}>
                {p4 ? "Waiting…" : c4 ? "Confirming…" : "⏹ Stop Scenario + Calculate Scores"}
              </button>
              {s4 && <div className="info-box" style={{ color: "var(--emerald-400)" }}>Scenario stopped! Loan continuity scores have been calculated and emitted.</div>}
              {e4 && <div className="alert-error">{e4}</div>}
            </>
          )}
          {scenarioStopped && (
            <div className="info-box" style={{ color: "var(--yellow-300)", borderColor: "rgba(234,179,8,0.3)" }}>
              Scenario complete — scores are final.
            </div>
          )}

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />

          <div style={{ fontSize: "0.875rem", color: "var(--gray-400)" }}>
            Current vETH Price:{" "}
            <strong style={{ color: "#fff" }}>
              {currentPrice !== undefined ? `${fmtUnits(currentPrice)} vUSD/vETH` : "—"}
            </strong>
          </div>

          <div className="field" style={{ marginBottom: "0.5rem" }}>
            <label className="field-label">New vETH Price (display units, e.g. 1850.00)</label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 1850.00"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-warning"
                disabled={isBusy || !newPrice}
                onClick={handlePriceUpdate}
              >
                {isPending ? "Waiting…" : isConfirming ? "Confirming…" : "Update Price"}
              </button>
            </div>
          </div>

          {isSuccess && <div className="info-box" style={{ color: "var(--emerald-400)" }}>Price updated!</div>}
          {error && <div className="alert-error">{error}</div>}

          <button
            className="btn btn-warning btn-block"
            disabled={isBusy2}
            onClick={handleCheckAll}
          >
            {p2 ? "Waiting…" : c2 ? "Confirming…" : "Check All HF + Liquidate"}
          </button>

          {s2 && <div className="info-box" style={{ color: "var(--emerald-400)" }}>HF check complete!</div>}
          {e2 && <div className="alert-error">{e2}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Ranking Table ────────────────────────────────────────────────────────────

interface RankEntry {
  address: `0x${string}`;
  collateral: bigint;
  debt: bigint;
  hf: bigint;
  numOperations: bigint;
  cumulativeDebtTime: bigint;
}

interface RankingTableProps {
  lendingAddress: `0x${string}`;
  connectedAddress: `0x${string}` | null;
  refreshTick: number;
}

function RankingTable({ lendingAddress, connectedAddress, refreshTick }: RankingTableProps) {
  const [entries, setEntries] = useState<RankEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!lendingAddress) return;
    setIsLoading(true);
    try {
      // Get all user addresses via listUsers()
      const addresses = await publicClient.readContract({
        address: lendingAddress,
        abi: LENDING_ABI as Abi,
        functionName: "listUsers",
      }) as readonly `0x${string}`[];

      if (addresses.length === 0) { setEntries([]); setIsLoading(false); return; }

      // Multicall getUserPosition for each address
      const calls = addresses.map((addr) => ({
        address: lendingAddress,
        abi: LENDING_ABI as Abi,
        functionName: "getUserPosition",
        args: [addr],
      }));

      const results = await publicClient.multicall({ allowFailure: true, contracts: calls });

      const list: RankEntry[] = addresses.map((addr, i) => {
        const r = results[i];
        if (r.status !== "success") return { address: addr, collateral: 0n, debt: 0n, hf: 0n, numOperations: 0n, cumulativeDebtTime: 0n };
        const pos = r.result as UserPosition;
        return {
          address: addr,
          collateral: pos.collateral,
          debt: pos.debt,
          hf: pos.hf,
          numOperations: pos.numOperations,
          cumulativeDebtTime: pos.cumulativeDebtTime,
        };
      });

      // Sort: HF descending; users with debt=0 go to bottom
      list.sort((a, b) => {
        const aNoDebt = a.debt === 0n;
        const bNoDebt = b.debt === 0n;
        if (aNoDebt && !bNoDebt) return 1;
        if (!aNoDebt && bNoDebt) return -1;
        if (a.hf === MAX_U256 && b.hf !== MAX_U256) return -1;
        if (b.hf === MAX_U256 && a.hf !== MAX_U256) return 1;
        if (a.hf > b.hf) return -1;
        if (a.hf < b.hf) return 1;
        return 0;
      });

      setEntries(list);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, [lendingAddress, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 className="subhead" style={{ margin: 0 }}>Leaderboard</h2>
        <button className="btn btn-sm btn-secondary" onClick={load} disabled={isLoading}>
          {isLoading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {isLoading && <div className="muted">Loading participants…</div>}
      {!isLoading && entries.length === 0 && (
        <div className="empty">
          <div className="empty-icon">📋</div>
          <div className="empty-title">No participants yet</div>
          <div className="empty-sub">Be the first to join!</div>
        </div>
      )}

      {entries.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="ranking-table">
            <thead>
              <tr>
                <th style={{ textAlign: "center" }}>#</th>
                <th>Address</th>
                <th>Collateral</th>
                <th>Debt</th>
                <th>Health Factor</th>
                <th>Status</th>
                <th>#op</th>
                <th>Debt-Time Score</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const badge = statusBadge(e.hf);
                const isMe = connectedAddress?.toLowerCase() === e.address.toLowerCase();
                return (
                  <tr key={e.address}>
                    <td className="rank-num">{i + 1}</td>
                    <td>
                      <span className={isMe ? "rank-me" : ""} style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}>
                        {isMe ? "★ " : ""}{shortAddr(e.address)}
                      </span>
                    </td>
                    <td>{fmtUnits(e.collateral)} vETH</td>
                    <td>{fmtUnits(e.debt)} vUSD</td>
                    <td className={hfClass(e.hf)}>{fmtHF(e.hf)}</td>
                    <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                    <td style={{ textAlign: "center", fontSize: "0.85rem" }}>{e.numOperations.toString()}</td>
                    <td style={{ fontSize: "0.8rem", color: "var(--gray-400)" }}>{fmtDebtTime(e.cumulativeDebtTime)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────

export function HomePage() {
  const { address, isConnected } = useWallet();
  const [refreshTick, setRefreshTick] = useState(0);

  const lendingAddress = getLendingAddress();
  const hasLending = !!lendingAddress;

  const { data: isUser, refetch: refetchIsUser } = useRead<boolean>(
    {
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: "isUser",
      args: [address ?? "0x0000000000000000000000000000000000000000"],
      enabled: hasLending && isConnected && !!address,
    },
    [lendingAddress, address]
  );

  const { data: challengeIsOpen } = useRead<boolean>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "challengeOpen", enabled: hasLending },
    [lendingAddress]
  );

  const { data: adminRole } = useRead<`0x${string}`>(
    { address: lendingAddress, abi: LENDING_ABI, functionName: "ADMIN_ROLE", enabled: hasLending },
    [lendingAddress]
  );

  const { data: isAdmin } = useRead<boolean>(
    {
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: "hasRole",
      args: [adminRole, address ?? "0x0000000000000000000000000000000000000000"],
      enabled: hasLending && isConnected && !!address && adminRole !== undefined,
    },
    [lendingAddress, address, adminRole]
  );

  const { walletClient } = useWallet();
  const { write: joinWrite, isPending: joinPending, isConfirming: joinConfirming, isSuccess: joinSuccess, error: joinError } = useWrite(walletClient);

  const handleJoin = async () => {
    const ok = await joinWrite({
      address: lendingAddress,
      abi: LENDING_ABI,
      functionName: "join",
      args: [],
    });
    if (ok) {
      refetchIsUser();
      setRefreshTick((t) => t + 1);
    }
  };

  const handleTxSuccess = useCallback(() => {
    refetchIsUser();
    setRefreshTick((t) => t + 1);
  }, [refetchIsUser]);

  const joinBusy = joinPending || joinConfirming;

  return (
    <div className="container">
      {/* 1. Page head */}
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Liquidation Protection Challenge</h1>
          <p className="page-subtitle">Automated position management with Chainlink Confidential Workflows</p>
        </div>
      </div>

      <ContractBox />

      {!hasLending && (
        <div className="info-box info-pending" style={{ margin: "1.5rem 0" }}>
          Enter the lending contract address above to get started.
        </div>
      )}

      {hasLending && (
        <>
          {/* 2. Protocol stats */}
          <div style={{ marginTop: "2rem" }}>
            <ProtocolStats lendingAddress={lendingAddress} enabled={hasLending} />
          </div>

          {/* 3. My Position */}
          {isConnected && address && isUser && (
            <MyPosition
              lendingAddress={lendingAddress}
              address={address}
              refreshTick={refreshTick}
              onRefresh={() => setRefreshTick((t) => t + 1)}
            />
          )}

          {/* 4. Action Panel */}
          <div className="panel" style={{ marginBottom: "2rem" }}>
            <h2 className="subhead">Participate</h2>
            {!isConnected && (
              <div className="info-box">Connect wallet to participate</div>
            )}
            {isConnected && address && !isUser && (
              <div>
                <p className="muted" style={{ marginBottom: "1rem" }}>
                  Join the challenge to get starter vETH and vUSD, with a virtual collateral position.
                </p>
                {!challengeIsOpen && (
                  <div className="info-box info-pending" style={{ marginBottom: "0.75rem" }}>
                    Registration is currently closed — the organizer has not opened the challenge yet.
                  </div>
                )}
                <button
                  className="btn btn-primary btn-block btn-lg"
                  disabled={joinBusy || !challengeIsOpen}
                  onClick={handleJoin}
                >
                  {joinPending ? "Waiting for wallet…" : joinConfirming ? "Confirming…" : "Join Challenge"}
                </button>
                {joinSuccess && (
                  <div className="info-box" style={{ marginTop: "0.75rem", color: "var(--emerald-400)" }}>
                    Joined! Refresh the page to see your position.
                  </div>
                )}
                {joinError && (
                  <div className="alert-error" style={{ marginTop: "0.75rem" }}>{joinError}</div>
                )}
              </div>
            )}
            {isConnected && address && isUser && (
              <ActionPanel
                lendingAddress={lendingAddress}
                address={address}
                onTxSuccess={handleTxSuccess}
              />
            )}
          </div>

          {/* 5. Admin Panel */}
          {isConnected && address && isAdmin && (
            <AdminPanel lendingAddress={lendingAddress} onTxSuccess={handleTxSuccess} />
          )}

          {/* 6. Ranking Table */}
          <RankingTable
            lendingAddress={lendingAddress}
            connectedAddress={address ?? null}
            refreshTick={refreshTick}
          />
        </>
      )}
    </div>
  );
}
