import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";

// The existing issuer registry shared by source and bundled Host modules.
const issuers = resolveGlobalSingleton(
  Symbol.for("openclaw.admittedRunOperatorAuthority.issuers"),
  () => new WeakSet<object>(),
);

/** Internal issuer operation; not exported by the Plugin SDK. */
export function registerAdmittedRunOperatorAuthority(authority: AdmittedRunOperatorAuthority): void {
  issuers.add(authority);
}

export function assertAdmittedRunOperatorAuthority(
  authority: unknown,
): asserts authority is AdmittedRunOperatorAuthority {
  if (!authority || typeof authority !== "object" || !issuers.has(authority)) {
    throw new Error("operator run authority must be issued by the host");
  }
}
