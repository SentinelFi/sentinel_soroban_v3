# Frontend Feedback To-Do List

## Legal & Compliance

- [ ] **Add Legal Disclaimer Notice**  
  Add a footer notice:  
  _“This is independent software, not affiliated with, sponsored, or endorsed by the Stellar Development Foundation.”_

- [ ] **Add Terms Acknowledgement (Buy & Vault Pages)**  
  On the Buy Insurance and Underwriter Vault pages, display a clear notice stating that by performing the action, the user agrees to the protocol’s Terms & Conditions. Include a link to read the full details.

- [ ] **Add Legal Pages Links**  
  Include links to Terms of Service and Privacy Policy in the homepage footer. Create these pages if they do not exist.

- [ ] **Add Early-Stage Disclaimer**  
  Inform users that the app is in early stages, may contain bugs, encourage reporting issues via GitHub.

---

## Home Page

- [ ] **Remove Hardcoded Delay Threshold**  
  Home page states 45 minutes, while Buy Insurance page uses 3 hours. Remove hardcoded values from Home page, use dynamic configuration.

- [ ] **Fix Hero Title Text Cutoff**  
  Resolve style issue where the H1 spans `# Flight Delay Insurance` cuts off the last letters (“y” in Delay and “e” in Insurance).

- [ ] **Add External Links to USDC and Stellar**  
  In the text:  
  _“Pay a small premium…”_  
  Link **USDC** to https://www.circle.com/multi-chain-usdc/stellar and **Stellar** to https://stellar.org/.

- [ ] **Ensure Pointer Cursor on Buttons**  
  All buttons should display `cursor: pointer` on hover.

- [ ] **Refine Border Styling (Optional)**  
  Consider applying `border: none;` globally except for tables and hover states.

- [ ] **Fix Dropdown Styling Consistency**  
  Style `<select>` elements to match the design system instead of default browser styles.

- [ ] **Use Distinct Navigation Icons**  
  Flights and Vaults currently use the same icon. Replace with distinct icons.

- [ ] **Add Contact / Support Section**  
  Include a “Contact Us” or support email section for user assistance.

- [ ] **Add Social Media Links**  
  Add links to X, GitHub, Discord somewhere in the homepage.

- [ ] **Add Email Updates Signup (Optional)**  
  Optionally include a users email subscription link for product updates.

- [ ] **Add Faucet / Token Mint**  
  Add a link to a Faucet page where users can mint mock USDC (testnet), since users cannot interact with the platform without tokens. For mainnet, it could link to a website to a real USDC token.

---

## Flights Page

- [ ] **Enhance Flights Table**  
  Add:  
  - Route (e.g., ABC → DEF)  
  - Total flights  
  - Search and sorting capabilities  
  - “Don’t see your flight?” request link/form  

- [ ] **Link Flight Numbers to External Info**  
  Each flight number should link to some free external flight information website.

---

## Buy Insurance Page

- [ ] **Fix Contract Call Error**  
  Investigate and resolve:  
  `HostError: Error(WasmVm, InvalidAction)`  
  Contract call failing on `buy_insurance`.

- [ ] **Improve Error Messaging**  
  Replace raw technical errors (e.g., “Transaction simulation failed HostError…”) with user-friendly messages, optionally expandable to full technical details for debugging.

---

## My Policies Page

- [ ] **Clarify Demo Policies**  
  Clearly indicate that 2 demo policies are loaded by default.

- [ ] **Group Policies & Show Total Count**  
  Display demo and real policies in a dedicated containers and show total number of policies for the user.

- [ ] **Fix Loading Text**  
  Replace loading text (“Loading pools…”) with appropriate wording.

- [ ] **Make Pool Address Clickable**  
  Link pool addresses to the relevant Stellar Expert page.

---

## Vault Page

- [ ] **Display Vault Errors in UI**  
  Deposit/withdraw errors are currently only logged in browser's console. Display user-visible, user-friendly error messages.

- [ ] **Separate Deposit & Withdraw Button States**  
  Deposit and Withdraw buttons should not share state (confirming, success).

- [ ] **Your Position Updates**  
  Successful deposit/withdraw actions should update “Your Position” automatically or provide a refresh icon.

- [ ] **Explain Vault Metrics**  
  Add explanations for:  
  - TVL  
  - APY  
  - Locked Capital  
  - Free Capital  
  - Vault Health  
  Include collateralization details and investment risk considerations.

- [ ] **Clarify Withdraw Input Type**  
  Clarify whether users input shares or USDC amount. Show total shares or assets available to deposit or withdraw. Add Stellar Expert link to vault smart contract.

---

## Build Issues

- [ ] **Fix Vite ESM Export Warning**  
  Resolve warning regarding:  
  `export * from "@stellar/stellar-sdk"`  
  Use proper ESM or named exports.

- [ ] **Fix PostCSS (font) @import Order Warning**  
  Ensure `@import` statements appear before all other CSS rules (except `@charset`).