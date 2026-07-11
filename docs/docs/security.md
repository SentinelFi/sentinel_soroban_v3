---
sidebar_position: 6
title: Security
---

# Security

## Disclaimer

:::warning
While we strive to ensure this software functions as intended, it is provided "as is" with no warranties or guarantees of any kind. Smart contracts are inherently complex and may contain bugs, vulnerabilities, or unintended behaviors. By using this software, you acknowledge and agree that you use it entirely at your own risk. You should perform your own due diligence, and it is strongly recommended to consult qualified professionals (e.g., security auditors, legal advisors).
:::

## Audits

The codebase has gone through multiple internal, AI-assisted audit rounds, with per-contract reports and tracked remediations. All reports live in the repository under [`audits/`](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/audits), with fixes documented in `audits/remediations/`.

The most recent review found no high-severity issues and confirmed the core safety properties: correct authorization gates, checked arithmetic, checks-effects-interactions ordering, the forward-only oracle state machine, manipulation-resistant share pricing, and fund conservation on every money path. Remaining medium and low findings relate to Soroban storage archival edge cases and settlement barrier liveness, and are tracked in the reports.

These are not independent third-party audits. Treat testnet as a test environment.

## Trust model

- **Oracle**: trusted for flight data. A malicious oracle could report false delays. Mitigations: forward-only state machine, owner key rotation, off-chain monitoring.
- **Keeper**: trusted for liveness, not funds. It can only trigger predefined transitions and cannot pay itself.
- **Owner**: trusted. It can upgrade code, pause contracts, tune bounded parameters, and recover expired funds. This is the main centralization point, and a multisig is recommended.
- **Everyone else**: untrusted by design. Travelers and underwriters interact only through validated, pull-based flows.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/SentinelFi/sentinel_soroban_v3/security) on the repository. Responsible disclosure is appreciated. See [`SECURITY.md`](https://github.com/SentinelFi/sentinel_soroban_v3/blob/main/SECURITY.md).
