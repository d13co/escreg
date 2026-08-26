/** The Escreg deployment the SDK talks to when the caller does not name one. */
export const DEFAULT_APP_ID = 16954321n;

/** Algod the SDK falls back to: the public fnet endpoint the default deployment lives on. */
export const FNET_ALGOD_SERVER = "https://fnet-api.4160.nodely.dev";

/** Port of the default algod endpoint. */
export const FNET_ALGOD_PORT = 443;

/** Sender for read-only simulate calls: the fee sink, which is funded on mostly every network. */
export const DEFAULT_READER_ACCOUNT = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";

/**
 * Addresses per `getList` call. The `address[]` arg encodes to 2 + 32N bytes and a single app arg is
 * capped at 4096 bytes, so 127 is the ceiling - 128 needs 4098. The ARC-4 return is logged, and the
 * 1024-byte log cap puts the same 127 ceiling on the `uint64[]` coming back (6 + 8 * 127 = 1022).
 *
 * AVM 13 raised the total app arg budget to 16KB, which is what lifted this from 63: before it, the
 * whole arg list - selector included - had to fit in 2048 bytes.
 */
export const ADDRESSES_PER_CALL = 127;

/** Addresses per `getList` call on nodes predating AVM 13, where all args had to fit in 2048 bytes. */
export const ADDRESSES_PER_CALL_LEGACY = 63;

/**
 * Boxes a simulate group may reference when it leaves them to `allowUnnamedResources`. Every address
 * in a lookup costs one, so this - not the arg limit - is what caps such a round trip.
 */
export const MAX_BOXES_PER_GROUP_UNNAMED = 128;

/** References an AVM 13 access list carries. Boxes, accounts, apps and assets share the one list. */
export const REFS_PER_ACCESS_LIST = 16;

/** Transactions an atomic group carries. */
export const TXNS_PER_GROUP = 16;

/**
 * Boxes a group can reference when every one is named in a transaction's access list. The pool is
 * shared across the group, so a call can read a box another transaction in the group named.
 */
export const MAX_BOXES_PER_GROUP_NAMED = REFS_PER_ACCESS_LIST * TXNS_PER_GROUP;

/**
 * Addresses per simulate group by default: everything a group's references can cover. Filling it
 * costs no extra transaction - the sixteen slots are already spoken for by the references, so the
 * two addresses past the second whole call land in a slot that would otherwise be a carrier.
 */
export const DEFAULT_ADDRESSES_PER_GROUP = MAX_BOXES_PER_GROUP_NAMED;

/**
 * Addresses per simulate group when the boxes are left unnamed: as many whole `getList` calls as the
 * box budget covers. The leftover the ceiling allows is not worth a call of its own - a one-address
 * call costs a whole extra transaction to resolve a single box - so a group stops at its last whole
 * call.
 *
 * @param perCall - Addresses each call in the group carries.
 * @returns Addresses the group as a whole carries.
 */
export const unnamedAddressesPerGroup = (perCall: number) => perCall * Math.floor(MAX_BOXES_PER_GROUP_UNNAMED / perCall);

/**
 * Fee for the read-only `getList` calls. Never actually paid - they only ever run through simulate -
 * but fnet prices transactions by usage, and a full 4KB arg list costs more than the 1000 microAlgo
 * minimum, so the group would be underfunded at the default fee.
 */
export const LOOKUP_CALL_FEE = 5_000;

/** Opcode budget handed to a lookup group. A full 254-address group burns about a sixth of it. */
export const LOOKUP_OPCODE_BUDGET = 170_000;

/** How long suggested params are reused for. Every lookup group needs them and they only set the validity window. */
export const SUGGESTED_PARAMS_CACHE_MS = 3 * 60 * 1000;

/** Rounds a write transaction stays valid for. */
export const DEFAULT_VALIDITY_WINDOW = 1000;
