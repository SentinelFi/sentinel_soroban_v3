# Feedback

## Things to Fix and Improve

1. **Controller contract constructor.** 
    The `min_lead_time` and `claim_expiry_window` parameters should specify that their values are in seconds.

2. **Audit number references in comments.** 
    Remove audit number references from code comments, such as `(L-03 — audit)`.

3. **Controller contract.** 
    Controller exposes extend_ttl twice — once in admin and once in auth. Remove the duplicate.

4. **CEI pattern note.** 
    The Check-Effects-Interactions (CEI) pattern is a practice used in Solidity, primarily to prevent reentrancy attacks. Reentrancy attacks are not relevant in Soroban contracts. Update any comment references to this pattern.

5. **Audit trail.** 
    Every privileged action should emit an event to leave an audit trail. This includes actions such as upgrading, setting configuration.

6. **Instance storage TTL.** 
    Make sure the instance storage TTL is extended in all hot paths.

7. **Constants file.** 
    Each contract crate should have a separate `constants.rs` file for defining its constants.
