

<style>
.markdown-body table {min-width: 100%;width: 100%;display: table;}
thead {min-width: 100%;width: 100%;}
th {min-width: 60%;width: 60%;}
th:last-child {min-width: 20%;width: 20%;}
th:first-child {min-width: 20%;width: 20%;}
</style>



# Scout Report - Contracts - 2026-07-19

## Summary

| <span style="color:green">Crate</span> | <span style="color:green">Status</span> | <span style="color:green">Critical</span> | <span style="color:green">Medium</span> | <span style="color:green">Minor</span> | <span style="color:green">Enhancement</span> | 
| - | - | - | - | - | - | 
| controller | Analyzed | 0 | 14 | 0 | 3 | 
| flight_pool_manager | Analyzed | 0 | 6 | 0 | 1 | 
| governance_module | Analyzed | 0 | 5 | 0 | 3 | 
| mock_usdc | Analyzed | 0 | 0 | 0 | 1 | 
| oracle_aggregator | Analyzed | 0 | 2 | 0 | 1 | 
| risk_vault | Analyzed | 0 | 3 | 0 | 1 | 
| sentinel_types | Analyzed | 0 | 2 | 0 | 3 | 


Issues found:



- [Soroban Version](#soroban-version) (17 results) (Enhancement)

- [Dynamic Storage](#dynamic-storage) (4 results) (Enhancement)

- [Divide Before Multiply](#divide-before-multiply) (2 results) (Medium)

- [Assert Violation](#assert-violation) (22 results) (Enhancement)



## Best Practices



### Soroban Version

**Impact:** Enhancement

**Issue:** Use the latest version of Soroban

**Description:** Using a older version of Soroban can be dangerous, as it may have bugs or security issues. Use the latest version available.

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/soroban/soroban-version)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 1 | sentinel_types | [lib.rs:1:1 - 1:1](../../contracts/sentinel_types/src/lib.rs) |
| 6 | mock_usdc | [lib.rs:1:1 - 1:1](../../contracts/mock_usdc/src/lib.rs) |
| 7 | flight_pool_manager | [lib.rs:1:1 - 1:1](../../contracts/flight_pool_manager/src/lib.rs) |
| 14 | governance_module | [lib.rs:1:1 - 1:1](../../contracts/governance_module/src/lib.rs) |
| 22 | oracle_aggregator | [lib.rs:1:1 - 1:1](../../contracts/oracle_aggregator/src/lib.rs) |
| 25 | controller | [lib.rs:1:1 - 1:1](../../contracts/controller/src/lib.rs) |
| 41 | risk_vault | [lib.rs:1:1 - 1:1](../../contracts/risk_vault/src/lib.rs) |


### Ineffective Extend Ttl

**Impact:** Medium

**Issue:** extend_ttl called with identical or smaller TTL arguments keeps refreshing the entry without enforcing expiration

**Description:** Soroban's extend_ttl can only increase an entry's lifetime. When both TTL parameters refer to the same binding, or the new TTL is smaller than the threshold, the call will run on every access making it ineffective

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/soroban/ineffective-extend-ttl)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 3 | sentinel_types | [active_set.rs:139:10 - 139:48](../../contracts/sentinel_types/src/active_set.rs) |
| 9 | flight_pool_manager | [claim.rs:60:14 - 60:76](../../contracts/flight_pool_manager/src/claim.rs) |
| 13 | flight_pool_manager | [storage.rs:51:10 - 51:48](../../contracts/flight_pool_manager/src/storage.rs) |
| 15 | governance_module | [storage.rs:83:10 - 83:63](../../contracts/governance_module/src/storage.rs) |
| 16 | governance_module | [storage.rs:99:14 - 99:68](../../contracts/governance_module/src/storage.rs) |
| 23 | oracle_aggregator | [storage.rs:49:10 - 49:48](../../contracts/oracle_aggregator/src/storage.rs) |
| 24 | oracle_aggregator | [storage.rs:86:10 - 86:48](../../contracts/oracle_aggregator/src/storage.rs) |
| 38 | controller | [storage.rs:60:30 - 64:6](../../contracts/controller/src/storage.rs) |
| 39 | controller | [storage.rs:87:30 - 91:6](../../contracts/controller/src/storage.rs) |
| 40 | controller | [storage.rs:133:34 - 137:10](../../contracts/controller/src/storage.rs) |



## Resource Management



### Dynamic Storage

**Impact:** Enhancement

**Issue:** Using dynamic types in instance or persistent storage can lead to unnecessary growth or storage-related vulnerabilities.

**Description:** Using dynamic types in instance or persistent storage can lead to unnecessary growth or storage-related vulnerabilities.

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/soroban/dynamic-storage)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 2 | sentinel_types | [active_set.rs:113:5 - 113:45](../../contracts/sentinel_types/src/active_set.rs) |
| 37 | controller | [storage.rs:59:5 - 59:46](../../contracts/controller/src/storage.rs) |


### Instance Storage Per User Key

**Impact:** Enhancement

**Issue:** Instance storage keyed per user grows the always-loaded instance map without bound.

**Description:** Soroban instance storage is loaded in full into memory on every invocation and shares a single TTL. Keying it by an `Address`-bearing enum variant makes the entry count grow per user, inflating read cost and rent for every call. Store per-user data in persistent or temporary storage and reserve instance storage for a bounded set of global keys.

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/soroban/instance-storage-per-user-key)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 20 | governance_module | [auth.rs:16:26 - 19:46](../../contracts/governance_module/src/auth.rs) |
| 21 | governance_module | [queries.rs:124:9 - 126:40](../../contracts/governance_module/src/queries.rs) |



## Arithmetic



### Divide Before Multiply

**Impact:** Medium

**Issue:** Division before multiplication might result in a loss of precision

**Description:** Division before multiplication might result in a loss of precision

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/rust/divide-before-multiply)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 42 | risk_vault | [claims.rs:69:14 - 69:46](../../contracts/risk_vault/src/claims.rs) |
| 43 | risk_vault | [claims.rs:220:14 - 220:46](../../contracts/risk_vault/src/claims.rs) |



## Error Handling



### Assert Violation

**Impact:** Enhancement

**Issue:** Assert causes panic. Instead, return a proper error.

**Description:** Using assert! macro in production code can cause unexpected panics. This violates best practices for smart contract error handling.

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/rust/assert-violation)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 0 | sentinel_types | [lib.rs:125:19 - 130:6](../../contracts/sentinel_types/src/lib.rs) |
| 5 | controller | [constants.rs:122:15 - 126:2](../../contracts/controller/src/constants.rs) |


### Unsafe Unwrap

**Impact:** Medium

**Issue:** Unsafe usage of `unwrap`

**Description:** This vulnerability class pertains to the inappropriate usage of the unwrap method in Rust, which is commonly employed for error handling. The unwrap method retrieves the inner value of an Option or Result, but if an error or None occurs, it triggers a panic and crashes the program.    

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/rust/unsafe-unwrap)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 4 | sentinel_types | [active_set.rs:346:35 - 346:57](../../contracts/sentinel_types/src/active_set.rs) |
| 8 | flight_pool_manager | [claim.rs:66:35 - 66:92](../../contracts/flight_pool_manager/src/claim.rs) |
| 10 | flight_pool_manager | [queries.rs:73:9 - 73:66](../../contracts/flight_pool_manager/src/queries.rs) |
| 11 | flight_pool_manager | [queries.rs:78:9 - 78:65](../../contracts/flight_pool_manager/src/queries.rs) |
| 12 | flight_pool_manager | [settle.rs:153:35 - 153:92](../../contracts/flight_pool_manager/src/settle.rs) |
| 17 | governance_module | [storage.rs:104:25 - 108:18](../../contracts/governance_module/src/storage.rs) |
| 18 | governance_module | [storage.rs:109:24 - 109:84](../../contracts/governance_module/src/storage.rs) |
| 19 | governance_module | [storage.rs:110:28 - 114:18](../../contracts/governance_module/src/storage.rs) |
| 26 | controller | [queries.rs:46:9 - 49:22](../../contracts/controller/src/queries.rs) |
| 27 | controller | [queries.rs:54:9 - 54:69](../../contracts/controller/src/queries.rs) |
| 28 | controller | [queries.rs:59:9 - 62:22](../../contracts/controller/src/queries.rs) |
| 32 | controller | [settle.rs:293:36 - 293:89](../../contracts/controller/src/settle.rs) |
| 33 | controller | [settle.rs:294:35 - 294:91](../../contracts/controller/src/settle.rs) |
| 34 | controller | [settle.rs:295:34 - 299:22](../../contracts/controller/src/settle.rs) |
| 35 | controller | [settle.rs:304:33 - 308:22](../../contracts/controller/src/settle.rs) |
| 36 | controller | [settle.rs:334:37 - 334:60](../../contracts/controller/src/settle.rs) |
| 44 | risk_vault | [queries.rs:69:9 - 69:67](../../contracts/risk_vault/src/queries.rs) |


### Unsafe Expect

**Impact:** Medium

**Issue:** Unsafe usage of `expect`

**Description:** In Rust, the expect method is commonly used for error handling. It retrieves the value from a Result or Option and panics with a specified error message if an error occurs. However, using expect can lead to unexpected program crashes.    

[**Learn More**](https://coinfabrik.github.io/scout-audit/docs/detectors/rust/unsafe-expect)

#### Findings

| ID  | Package | File Location |
| --- | ------- | ------------- |
| 29 | controller | [settle.rs:169:50 - 171:56](../../contracts/controller/src/settle.rs) |
| 30 | controller | [settle.rs:190:34 - 193:49](../../contracts/controller/src/settle.rs) |
| 31 | controller | [settle.rs:220:32 - 222:49](../../contracts/controller/src/settle.rs) |


