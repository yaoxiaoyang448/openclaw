import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginHookAuthenticatedOperator } from "./hook-types.js";


const sources = resolveGlobalSingleton(
  Symbol.for("openclaw.beforeDispatchOperatorSources"),
  () => new WeakSet<object>(),
);

/** Internal chat.send producer only; not exported by the Plugin SDK. */
export function registerBeforeDispatchOperatorSource(source: PluginHookAuthenticatedOperator): void {
  sources.add(source);
}

/** Dispatch-owned scope: a retained capability stops working when hooks settle. */
export function openBeforeDispatchOperatorContext(
  source: PluginHookAuthenticatedOperator | undefined,
  binding: { sessionKey: string; messageId: string | undefined },
  assertDispatchCurrent: () => void,
): { context: PluginHookAuthenticatedOperator | undefined; close: () => void } {
  let active = true;
  const close = () => { active = false; };
  if (!source || !sources.has(source) || !binding.messageId) {
    return { context: undefined, close };
  }
  const original = { sessionKey: binding.sessionKey, messageId: binding.messageId };
  const assertCurrent = (requested: { sessionKey: string; messageId: string }) => {
    if (!active || requested?.sessionKey !== original.sessionKey || requested?.messageId !== original.messageId) {
      throw new Error("OPERATOR_CONTEXT_DENIED");
    }
    assertDispatchCurrent();
    const principal = source.assertCurrent(original);
    if (!active) {
      throw new Error("OPERATOR_CONTEXT_DENIED");
    }
    return principal;
  };
  try {
    assertCurrent(original);
  } catch {
    close();
    return { context: undefined, close };
  }
  return { context: Object.freeze({ assertCurrent }), close };
}
