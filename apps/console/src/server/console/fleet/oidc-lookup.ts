import type { LookupFunction } from "node:net";

/** Transport primitive only: the caller must validate every DNS answer before
 * pinning one address. Preserve Node's single-address and all-address contracts. */
export function pinnedOidcLookup(address: string): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}
