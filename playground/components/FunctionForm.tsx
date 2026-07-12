"use client";

// Generic call form rendered from a registry FunctionSpec: typed inputs,
// read queries via free simulation, writes via simulate → wallet-sign →
// submit, with the decoded result (or a precise error) shown inline.

import { useMemo, useState } from "react";
import {
  FaChevronDown,
  FaChevronUp,
  FaCircleInfo,
  FaPlay,
  FaSignature,
} from "react-icons/fa6";
import type { xdr } from "@stellar/stellar-sdk";
import { useWallet } from "@/app/providers";
import { explorerTxUrl } from "@/lib/config";
import { stringifyResult } from "@/lib/format";
import {
  AUTH_HINT,
  AUTH_LABEL,
  type ArgSpec,
  type FunctionSpec,
} from "@/lib/registry";
import { encodeArg, type ArgType, type ArgValue } from "@/lib/scval";
import { invokeWrite, simulateRead, simulateWrite } from "@/lib/soroban";

type Status =
  | { kind: "idle" }
  | { kind: "pending"; text: string }
  | { kind: "ok"; text: string; txHash?: string }
  | { kind: "error"; text: string };

function inputModeFor(type: ArgType): "text" | "select" | "date" | "bool" {
  if (typeof type === "object") {
    if ("enum" in type || "variant" in type) return "select";
    return inputModeFor(type.option);
  }
  if (type === "date") return "date";
  if (type === "bool") return "bool";
  return "text";
}

function placeholderFor(type: ArgType): string {
  if (typeof type === "object" && "option" in type) {
    return `${placeholderFor(type.option)} (optional)`;
  }
  if (typeof type === "object") return "";
  switch (type) {
    case "address":
      return "G… or C… address";
    case "symbol":
      return "e.g. AA100";
    case "u32":
    case "u64":
    case "i128":
      return "integer";
    case "amount7":
      return "USDC, e.g. 50";
    case "amount10":
      return "shares, e.g. 50";
    case "timestamp":
      return "unix seconds (UTC)";
    case "bytes32":
      return "64 hex characters";
    default:
      return "";
  }
}

function ArgInput({
  spec,
  value,
  onChange,
  walletAddress,
}: {
  spec: ArgSpec;
  value: ArgValue;
  onChange: (v: ArgValue) => void;
  walletAddress: string | null;
}) {
  const mode = inputModeFor(spec.type);
  const variants =
    typeof spec.type === "object" && "variant" in spec.type
      ? spec.type.variant
      : typeof spec.type === "object" && "enum" in spec.type
        ? spec.type.enum.map((name) => ({ name, payload: undefined }))
        : null;
  const selectedVariant = variants?.find((v) => v.name === value.raw);

  return (
    <div>
      <label className="field-label">
        {spec.name}
        {spec.autofillWallet && walletAddress && (
          <>
            {" "}
            <button
              type="button"
              className="icon-btn accent"
              style={{ fontSize: 11, fontFamily: "inherit" }}
              onClick={() => onChange({ ...value, raw: walletAddress })}
            >
              use my address
            </button>
          </>
        )}
      </label>
      {mode === "select" && variants ? (
        <>
          <select
            value={value.raw}
            onChange={(e) => onChange({ ...value, raw: e.target.value })}
          >
            <option value="">— select —</option>
            {variants.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
          {selectedVariant?.payload && (
            <input
              style={{ marginTop: 6 }}
              value={value.payload ?? ""}
              placeholder={placeholderFor(selectedVariant.payload)}
              onChange={(e) => onChange({ ...value, payload: e.target.value })}
            />
          )}
        </>
      ) : mode === "bool" ? (
        <select
          value={value.raw}
          onChange={(e) => onChange({ ...value, raw: e.target.value })}
        >
          <option value="">— select —</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          type={mode === "date" ? "date" : "text"}
          value={value.raw}
          placeholder={placeholderFor(spec.type)}
          onChange={(e) => onChange({ ...value, raw: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
      )}
      {spec.help && (
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
          {spec.help}
        </div>
      )}
    </div>
  );
}

export function FunctionForm({
  contractAddress,
  spec,
}: {
  contractAddress: string;
  spec: FunctionSpec;
}) {
  const { address, signXdr } = useWallet();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, ArgValue>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  const hint = AUTH_HINT[spec.auth];

  const encodedArgs = useMemo(() => {
    return (): xdr.ScVal[] =>
      spec.args.map((argSpec) =>
        encodeArg(argSpec.type, values[argSpec.name] ?? { raw: "" }, argSpec.name),
      );
  }, [spec.args, values]);

  const runRead = async () => {
    setBusy(true);
    setStatus({ kind: "pending", text: "Querying…" });
    try {
      const result = await simulateRead(contractAddress, spec.name, encodedArgs());
      setStatus({ kind: "ok", text: stringifyResult(result) });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runSimulate = async () => {
    if (!address) return;
    setBusy(true);
    setStatus({ kind: "pending", text: "Simulating…" });
    try {
      const result = await simulateWrite(address, contractAddress, spec.name, encodedArgs());
      setStatus({
        kind: "ok",
        text: `Simulation OK. Would return:\n${stringifyResult(result)}`,
      });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runSubmit = async () => {
    if (!address) return;
    setBusy(true);
    setStatus({ kind: "pending", text: "Simulating, then requesting a signature in your wallet…" });
    try {
      const { hash, result } = await invokeWrite(
        address,
        contractAddress,
        spec.name,
        encodedArgs(),
        signXdr,
      );
      setStatus({
        kind: "ok",
        text: `Confirmed on-chain.\nReturned: ${stringifyResult(result)}`,
        txHash: hash,
      });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fn-row">
      <div className="fn-head" onClick={() => setOpen((o) => !o)}>
        <span className="name">{spec.name}</span>
        <span className={`badge ${spec.readonly ? "read" : spec.auth}`}>
          {spec.readonly ? "read" : AUTH_LABEL[spec.auth]}
        </span>
        <span className="sum">{spec.summary}</span>
        {open ? <FaChevronUp size={12} /> : <FaChevronDown size={12} />}
      </div>
      {open && (
        <div className="fn-body">
          {hint && !spec.readonly && (
            <div className="muted" style={{ fontSize: 13, marginBottom: 12, display: "flex", gap: 8 }}>
              <FaCircleInfo style={{ marginTop: 3, flexShrink: 0 }} />
              <span>{hint}</span>
            </div>
          )}
          {spec.args.length > 0 && (
            <div className="fn-args">
              {spec.args.map((argSpec) => (
                <ArgInput
                  key={argSpec.name}
                  spec={argSpec}
                  value={values[argSpec.name] ?? { raw: "" }}
                  onChange={(v) => setValues((prev) => ({ ...prev, [argSpec.name]: v }))}
                  walletAddress={address}
                />
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {spec.readonly ? (
              <button className="btn btn-sm" onClick={() => void runRead()} disabled={busy}>
                <FaPlay size={11} /> Query
              </button>
            ) : (
              <>
                <button
                  className="btn-outline btn btn-sm"
                  onClick={() => void runSimulate()}
                  disabled={busy || !address}
                >
                  <FaPlay size={11} /> Simulate
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void runSubmit()}
                  disabled={busy || !address}
                >
                  <FaSignature size={12} /> Sign &amp; Submit
                </button>
                {!address && <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>Connect a wallet to execute</span>}
              </>
            )}
            {spec.returns && (
              <span className="muted mono" style={{ fontSize: 12, alignSelf: "center" }}>
                → {spec.returns}
              </span>
            )}
          </div>
          {status.kind !== "idle" && (
            <div
              className={`result-box ${status.kind === "error" ? "error" : status.kind === "pending" ? "pending" : ""}`}
            >
              {status.text}
              {status.kind === "ok" && status.txHash && (
                <>
                  {"\n"}
                  <a
                    href={explorerTxUrl(status.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View transaction on stellar.expert →
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
