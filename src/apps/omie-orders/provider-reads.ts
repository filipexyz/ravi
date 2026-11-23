import { registerProviderReadOnlyActions } from "../../credentials/broker.js";
import { catalogue } from "./catalogue.js";

/** The broker asks a human for any provider action it does not know as a read. The packaged catalogue is the only
 * source of this executor's reads, declared for this provider only. Idempotent; composition calls it at boot so the
 * broker classifies these reads correctly before any query has run in the process. */
export function registerOmieProviderReads(): void {
  registerProviderReadOnlyActions(
    "omie",
    catalogue.filter((op) => op.classification === "read").map((op) => op.id),
  );
}
