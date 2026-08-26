# Lookup chunking for AVM 13

`sdk.lookup` used to split its addresses into `getList` calls of 63 and simulate them in groups of
128. AVM 13 raised the app argument budget, so the calls are now 127 addresses each and a group is
one whole call.

## What set the old 63

Every byte of an app call's arguments had to fit in 2048: `4` for the selector plus `2 + 32N` for the
`address[]`, so `N ≤ 63`. AVM 13 raised that budget to 16KB, but the **per-argument** cap is 4096
bytes and unchanged, so a single `address[]` tops out at 127 — 128 encodes to 4098:

```
n=127: OK
n=128: tx.ApplicationArgs[1] length is too long. 4098 > 4096
```

127 is also where the return runs out of room. The ARC-4 return value goes out as a log, logs are
capped at 1024 bytes, and `uint64[]` of 127 is `6 + 8 * 127 = 1022`. Both limits land on the same
number, so 127 per call is the ceiling until the contract's method signature changes.

## Group size is a constructor option now

```ts
new EscregSDK({ addressesPerGroup: 256 })   // the default
```

256 addresses per simulate group, 1 to 256. Past 128 the group has to name every box it reads in an
AVM 13 access list, which is what lifts the ceiling — see below — and costs transactions. At or below
128 the group leaves the boxes to `allowUnnamedResources`, which is cheaper per round trip, so
`lookup` picks the path per group rather than per SDK: a lookup of 50 addresses still goes out as one
call with no access lists.

Set it to 127 or lower for one `getList` call per round trip and no access lists at all.

## What still sets the group size

A simulate group may reference at most **128 boxes** when the boxes are left unnamed, and every
address costs one, so the box budget — not the argument budget — is what caps a round trip. Measured
on fnet against app 16954321:

| group | result |
|---|---|
| `[127]`, `[127,1]`, `[64,64]`, `[43,43,42]` | OK |
| `[65,65]`, `[127,2]`, `[127,1,1]` | `invalid Box reference` |

It is a group-wide ceiling, not per transaction: 128 total passes however it is split, 129 never
does. An unnamed group is therefore sized to the last whole call that fits the budget —
`unnamedAddressesPerGroup()` — which is 127 for a full-size call and 126 (`[63,63]`) on the fallback
path. The leftover address the ceiling allows is not worth the transaction it would cost to resolve.

Naming the boxes instead raises the ceiling to **256**. An access list carries 16 references, a group
carries 16 transactions, and the pool is shared — a call can read a box another transaction in the
group named. So a full group is two whole 127-address calls, a third holding the two addresses left
over, and thirteen carriers: transactions that name 16 boxes each and look nothing up. Filling the
group to 256 costs no extra transaction - all 16 slots are already spoken for by the references, so
the third call takes a slot that would otherwise carry nothing, which is why 254 and 256 measure the
same.

That is where the default comes from. It is worth what it costs when the round trip is expensive: on
a public endpoint at concurrency 1 it resolves a third more addresses per second, while against a
local node the carriers make it slower. See `experiments/FINDINGS.md` on the `worktree-access-lists`
branch for the full measurements.

## Fees

fnet prices transactions by usage, and a 4KB argument list costs more than the 1000 microAlgo
minimum, so a full-size group is underfunded at the default fee:

```
txgroup with 2mA fees is less than 2.203mA (usage=2.202200 * base=1mA)
```

The `getList` calls now carry an explicit 5000 microAlgo fee. They only ever run through simulate, so
it is never actually paid.

## Older nodes

`lookup` steps down on its own, once per SDK instance, and warns each time it does. A node that will
not honour access lists loses the named path; a node predating AVM 13 rejects a 127-address call
outright and loses the full-size call too:

```
escreg: node did not honour access lists, falling back to unnamed box references
escreg: node rejected a 127-address call, falling back to 63
```

That leaves the pre-AVM-13 shape: 63 per call, 126 per group, boxes unnamed. `addressesPerCall` and
`addressesPerGroup` are both public if you would rather pin them.

LocalNet has since been upgraded to AVM 13, so the suite there now takes the access-list path and no
longer covers this. The chain above was driven against mainnet's node instead, which is pre-AVM-13
and rejects the oversized argument at transaction validation, before it even looks at whether the app
exists.

## Performance

1016 addresses against a local fnet node, 15 interleaved reps, median:

| group shape | conc | groups | txns | median | addr/s |
|---|---|---|---|---|---|
| `[63,63,2]` (old) | 1 | 8 | 23 | 106.9ms | 9,508 |
| `[127,1]` | 1 | 8 | 15 | 91.9ms | 11,055 |
| `[127]` (new) | 1 | 8 | 8 | 94.3ms | 10,778 |
| `[63,63,2]` (old) | 4 | 8 | 23 | 48.6ms | 20,893 |
| `[127,1]` | 4 | 8 | 15 | 43.3ms | 23,486 |
| `[127]` (new) | 4 | 8 | 8 | 41.4ms | 24,542 |

13-17% faster for a third of the transactions. The gain is small because round trips did not change:
the box ceiling still put ~128 addresses in a group either way, so all that was saved is two app
calls' worth of setup and execution per group, plus 186 bytes on the wire.

Group count is the only thing a remote caller feels, which is what the default is for. The same 1016
addresses over the public endpoint, 9 interleaved reps, median:

| group shape | conc | groups | txns | median | addr/s | vs 127/grp |
|---|---|---|---|---|---|---|
| `[63,63,2]`, 128/grp (old) | 1 | 8 | 23 | 414.8ms | 2,450 | -0.2% |
| `[127]`, 127/grp | 1 | 8 | 8 | 415.7ms | 2,444 | - |
| `[127,127]`, 254/grp | 1 | 4 | 64 | 295.6ms | 3,437 | -28.9% |
| `[127,127,2]`, 256/grp (default) | 1 | 4 | 64 | 282.1ms | 3,601 | -32.1% |
| `[63,63,2]`, 128/grp (old) | 4 | 8 | 23 | 130.4ms | 7,791 | -4.2% |
| `[127]`, 127/grp | 4 | 8 | 8 | 136.2ms | 7,462 | - |
| `[127,127]`, 254/grp | 4 | 4 | 64 | 117.6ms | 8,639 | -13.6% |
| `[127,127,2]`, 256/grp (default) | 4 | 4 | 64 | 119.7ms | 8,488 | -12.1% |

Over a WAN link the 63-to-127 change is a wash — both make the same eight round trips — while the
access-list groups, which make four, are a third faster at concurrency 1. 254 and 256 are a coin flip
(paired over 15 reps: -0.3% at concurrency 1, -2.6% at concurrency 4) because they cost the same 16
transactions, so the default takes the two extra addresses.

The trade runs the other way against a node with no latency to hide: 13 of every 16 transactions in a
named group are carriers, and a local node is 25-35% slower for them. Callers in that position should
set `addressesPerGroup: 127`.

## Verified

- fnet, app 16954321: 256 in one group, and 100 / 300 / 1000 across groups — every address resolved,
  no mismatches, on both the named and unnamed paths.
- The option: 256 (default), 254, 127 and 50 all resolve correctly and group as expected; 0, 257 and
  12.5 are refused by the constructor.
- Both step-downs, driven against mainnet's pre-AVM-13 node, ending on 63 per call.
- LocalNet (now AVM 13): full contract suite green.
