import { assertAdmittedRunOperatorAuthority } from "../../agents/operator-authority-issuer.js";
import { registerBeforeDispatchOperatorSource } from "../../plugins/before-dispatch-operator.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { PluginHookAuthenticatedOperator } from "../../plugins/hook-types.js";
import type { GatewayClient } from "./client-types.js";

/** Only the admitted external chat.send path constructs this non-persisted source. */
export function captureChatSendOperatorContext(params: {
  client: GatewayClient | null;
  authority: AdmittedRunOperatorAuthority | undefined;
  sessionKey: string;
  messageId: string;
  assertRequestCurrent: () => void;
}): PluginHookAuthenticatedOperator | undefined {
  const { client, authority, sessionKey, messageId, assertRequestCurrent } = params;
  if (!client || !authority) {
    return undefined;
  }
  const connectionId = client.connId;
  const connectionSignal = client.connectionSignal;
  const connect = client.connect;
  const internal = client.internal;
  const authenticatedUserId = client.authenticatedUserId;
  const profileId = client.authenticatedUserProfile?.profileId;
  const scopes = [...(connect.scopes ?? [])];
  let revoked = false;
  const current = () => {
    try {
      if (
        revoked ||
        !connectionId ||
        !connectionSignal ||
        connectionSignal.aborted ||
        client.connectionSignal !== connectionSignal ||
        client.connId !== connectionId ||
        client.connect !== connect ||
        client.internal !== internal ||
        client.invalidated ||
        connect.role !== "operator" ||
        internal?.authenticatedOperator !== true ||
        internal.syntheticClient ||
        internal.agentRuntimeIdentity ||
        internal.agentToolCaller ||
        client.authenticatedUserId !== authenticatedUserId ||
        !profileId ||
        client.authenticatedUserProfile?.profileId !== profileId ||
        authority.profileId !== profileId ||
        scopes.some((scope) => !connect.scopes?.includes(scope))
      ) {
        throw new Error("OPERATOR_CONTEXT_DENIED");
      }
      assertAdmittedRunOperatorAuthority(authority);
      authority.assertCurrent();
      assertRequestCurrent();
      connectionSignal.throwIfAborted();
    } catch {
      revoked = true;
      throw new Error("OPERATOR_CONTEXT_DENIED");
    }
  };
  try {
    current();
  } catch {
    return undefined;
  }
  if (!profileId) { return undefined; }
  const principal = Object.freeze({
    principalType: "authenticated_operator" as const,
    operatorId: profileId,
  });
  const source = Object.freeze({
    assertCurrent(binding: { sessionKey: string; messageId: string }) {
      if (binding?.sessionKey !== sessionKey || binding?.messageId !== messageId) {
        throw new Error("OPERATOR_CONTEXT_DENIED");
      }
      current();
      return principal;
    },
  });
  registerBeforeDispatchOperatorSource(source);
  return source;
}
