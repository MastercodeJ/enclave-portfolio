import { useState } from "react";
import { getLendingAddress, getVethAddress, getVusdAddress } from "@/lib/contract";

async function addToMetaMask(address: string, symbol: string, decimals: number) {
  const { ethereum } = window as any;
  if (!ethereum) return;
  try {
    await ethereum.request({
      method: "wallet_watchAsset",
      params: { type: "ERC20", options: { address, symbol, decimals } },
    });
  } catch {
    // user rejected or MetaMask not available
  }
}

interface AddressRowProps {
  label: string;
  storageKey: string;
  currentValue: string;
  onSaved: () => void;
  metamask?: { symbol: string; decimals: number };
}

function AddressRow({ label, storageKey, currentValue, onSaved, metamask }: AddressRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentValue);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!currentValue) return;
    navigator.clipboard.writeText(currentValue).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed) {
      localStorage.setItem(storageKey, trimmed);
    } else {
      localStorage.removeItem(storageKey);
    }
    setEditing(false);
    onSaved();
  };

  const handleCancel = () => {
    setDraft(currentValue);
    setEditing(false);
  };

  return (
    <div className="contract-row" style={{ marginBottom: "0.5rem" }}>
      <span className="label" style={{ minWidth: "4rem" }}>{label}</span>
      {editing ? (
        <div className="edit-address">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
          <button className="btn btn-sm btn-primary" onClick={handleSave}>Save</button>
          <button className="btn btn-sm btn-secondary" onClick={handleCancel}>Cancel</button>
        </div>
      ) : (
        <div className="address-inline">
          <code>{currentValue || <span style={{ color: "var(--gray-500)" }}>not set</span>}</code>
          {currentValue && (
            <button className="btn-copy" onClick={handleCopy}>
              {copied ? "✓" : "Copy"}
            </button>
          )}
          <button
            className="btn-copy"
            onClick={() => { setDraft(currentValue); setEditing(true); }}
            title="Edit"
            style={{ padding: "0.2rem 0.45rem" }}
          >
            ✎
          </button>
          {currentValue && metamask && (
            <button
              className="btn-copy"
              onClick={() => addToMetaMask(currentValue, metamask.symbol, metamask.decimals)}
              title={`Add ${metamask.symbol} to MetaMask`}
              style={{ padding: "0.2rem 0.45rem" }}
            >
              add to 🦊
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ContractBox() {
  // Force re-render after save so values update immediately before page reload.
  const [, setTick] = useState(0);

  const handleSaved = () => {
    window.location.reload();
  };

  return (
    <div className="contract-box" style={{ marginTop: "1rem" }}>
      <AddressRow
        label="Lending"
        storageKey="lendingAddress"
        currentValue={getLendingAddress()}
        onSaved={handleSaved}
      />
      <AddressRow
        label="vETH"
        storageKey="vethAddress"
        currentValue={getVethAddress()}
        onSaved={() => { setTick((t) => t + 1); window.location.reload(); }}
        metamask={{ symbol: "vETH", decimals: 2 }}
      />
      <AddressRow
        label="vUSD"
        storageKey="vusdAddress"
        currentValue={getVusdAddress()}
        onSaved={() => { setTick((t) => t + 1); window.location.reload(); }}
        metamask={{ symbol: "vUSD", decimals: 2 }}
      />
    </div>
  );
}
