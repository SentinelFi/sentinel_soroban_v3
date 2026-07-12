"use client";

// Interact — a generic, registry-driven caller for every public entrypoint
// on the six deployed Sentinel contracts. Reads run as free simulations;
// writes are simulated, then signed in the connected wallet.

import { useState } from "react";
import { FaBookOpen, FaEye, FaPenToSquare } from "react-icons/fa6";
import { AddressLine } from "@/components/AddressLine";
import { FunctionForm } from "@/components/FunctionForm";
import { explorerContractUrl } from "@/lib/config";
import { REGISTRY } from "@/lib/registry";

export default function InteractPage() {
  const [activeKey, setActiveKey] = useState(REGISTRY[0].key);
  const contract = REGISTRY.find((c) => c.key === activeKey)!;
  const reads = contract.functions.filter((f) => f.readonly);
  const writes = contract.functions.filter((f) => !f.readonly);

  return (
    <>
      <h1 className="page-title">Interact</h1>
      <p className="page-sub">
        Call any public function on the deployed contracts. Read functions are
        free simulations; write functions are simulated first, then signed in
        your wallet. Badges show who is authorized to execute each call.
      </p>

      <div className="tabs">
        {REGISTRY.map((c) => (
          <button
            key={c.key}
            className={c.key === activeKey ? "active" : ""}
            onClick={() => setActiveKey(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <section className="panel" style={{ marginBottom: 24 }}>
        <h2 className="panel-title">
          <FaBookOpen size={15} /> {contract.label}
        </h2>
        <p className="panel-sub" style={{ marginBottom: 8 }}>{contract.description}</p>
        <AddressLine
          address={contract.address}
          explorerUrl={explorerContractUrl(contract.address)}
          chars={12}
        />
      </section>

      <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "22px 0 12px" }}>
        <FaEye size={14} style={{ color: "var(--accent)" }} /> Read ({reads.length})
      </h3>
      {reads.map((f) => (
        <FunctionForm key={f.name} contractAddress={contract.address} spec={f} />
      ))}

      <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "26px 0 12px" }}>
        <FaPenToSquare size={14} style={{ color: "var(--accent)" }} /> Write ({writes.length})
      </h3>
      {writes.map((f) => (
        <FunctionForm key={f.name} contractAddress={contract.address} spec={f} />
      ))}
    </>
  );
}
