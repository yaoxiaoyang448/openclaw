import assert from "node:assert/strict";
import { it } from "vitest";
import { registerAdmittedRunOperatorAuthority } from "../../agents/operator-authority-issuer.js";
import { openBeforeDispatchOperatorContext } from "../../plugins/before-dispatch-operator.js";
import { captureChatSendOperatorContext } from "./chat-send-operator-context.js";
import type { GatewayClient } from "./client-types.js";

function fixture(profileId = "fixture-owner") {
  const connection = new AbortController();
  let authorized = true;
  let requestCurrent = true;
  const client = {
    connId: "fixture-connection",
    connectionSignal: connection.signal,
    connect: { role: "operator", scopes: ["operator.admin"] },
    internal: { authenticatedOperator: true },
    authenticatedUserProfile: { profileId },
  } as GatewayClient;
  const binding = { sessionKey: "agent:fixture", messageId: "fixture-message" };
  const authority = {
    profileId,
    scopes: ["operator.admin"],
    assertCurrent() {
      if (!authorized) {
        throw new Error("private-authorization-error");
      }
    },
  };
  registerAdmittedRunOperatorAuthority(authority);
  const capture = () =>
    captureChatSendOperatorContext({
      client,
      authority,
      ...binding,
      assertRequestCurrent() {
        if (!requestCurrent) {
          throw new Error("private-session-error");
        }
      },
    });
  return {
    client,
    capture,
    connection,
    binding,
    revoke() {
      authorized = false;
    },
    restore() {
      authorized = true;
    },
    switchSession() {
      requestCurrent = false;
    },
  };
}

it("projects the admitted operator profile without inventing a named user", () => {
  const f = fixture();
  assert.equal(f.client.authenticatedUserId, undefined);
  const source = f.capture();
  assert(source);
  assert.deepEqual(source.assertCurrent(f.binding), {
    principalType: "authenticated_operator",
    operatorId: "fixture-owner",
  });
});
for (const mode of [
  "unauthenticated",
  "node",
  "synthetic",
  "invalidated",
  "disconnected",
] as const) {
  it(`omits operator context for ${mode} input`, () => {
    const f = fixture();
    if (mode === "unauthenticated") {
      delete f.client.internal?.authenticatedOperator;
    }
    if (mode === "node") {
      f.client.connect.role = "node";
    }
    if (mode === "synthetic") {
      f.client.internal!.syntheticClient = true;
    }
    if (mode === "invalidated") {
      f.client.invalidated = true;
    }
    if (mode === "disconnected") {
      f.connection.abort();
    }
    assert.equal(f.capture(), undefined);
  });
}
it("token-shaped params cannot replace admitted authority", () => {
  const f = fixture();
  assert.equal(
    captureChatSendOperatorContext({
      client: f.client,
      authority: undefined,
      ...f.binding,
      assertRequestCurrent() {},
    }),
    undefined,
  );
});
it("revocation is terminal even if a fixture later restores authorization", () => {
  const f = fixture(),
    source = f.capture();
  assert(source);
  f.revoke();
  assert.throws(() => source.assertCurrent(f.binding), /^Error: OPERATOR_CONTEXT_DENIED$/);
  f.restore();
  assert.throws(() => source.assertCurrent(f.binding), /OPERATOR_CONTEXT_DENIED/);
});
it("a captured source cannot survive disconnection or invalidation", () => {
  for (const mode of ["abort", "invalidate"]) {
    const f = fixture(),
      source = f.capture();
    assert(source);
    if (mode === "abort") {
      f.connection.abort();
    } else {
      f.client.invalidated = true;
    }
    assert.throws(() => source.assertCurrent(f.binding), /OPERATOR_CONTEXT_DENIED/);
  }
});
it("session/message switching refuses and never borrows another connection", async () => {
  const a = fixture("fixture-owner-a"),
    b = fixture("fixture-owner-b");
  const sa = a.capture(),
    sb = b.capture();
  assert(sa && sb);
  const [pa, pb] = await Promise.all([
    Promise.resolve().then(() => sa.assertCurrent(a.binding)),
    Promise.resolve().then(() => sb.assertCurrent(b.binding)),
  ]);
  assert.equal(pa.operatorId, "fixture-owner-a");
  assert.equal(pb.operatorId, "fixture-owner-b");
  assert.throws(
    () => sa.assertCurrent({ ...a.binding, sessionKey: "agent:other" }),
    /OPERATOR_CONTEXT_DENIED/,
  );
  assert.throws(
    () => sa.assertCurrent({ ...a.binding, messageId: "other-message" }),
    /OPERATOR_CONTEXT_DENIED/,
  );
  a.switchSession();
  assert.throws(() => sa.assertCurrent(a.binding), /OPERATOR_CONTEXT_DENIED/);
  assert.equal(sb.assertCurrent(b.binding).operatorId, "fixture-owner-b");
});
it("dispatch-scoped context closes on hook settlement and rechecks cancellation", () => {
  const f = fixture(),
    source = f.capture();
  assert(source);
  let current = true;
  const scope = openBeforeDispatchOperatorContext(source, f.binding, () => {
    if (!current) {
      throw new Error("OPERATOR_CONTEXT_DENIED");
    }
  });
  assert(scope.context);
  assert.equal(scope.context.assertCurrent(f.binding).principalType, "authenticated_operator");
  current = false;
  assert.throws(() => scope.context!.assertCurrent(f.binding), /OPERATOR_CONTEXT_DENIED/);
  current = true;
  scope.close();
  assert.throws(() => scope.context!.assertCurrent(f.binding), /OPERATOR_CONTEXT_DENIED/);
});
it("unbound and revoked dispatches expose no context", () => {
  const f = fixture(),
    source = f.capture();
  assert(source);
  assert.equal(
    openBeforeDispatchOperatorContext(source, { ...f.binding, sessionKey: undefined }, () => {})
      .context,
    undefined,
  );
  assert.equal(
    openBeforeDispatchOperatorContext(source, { ...f.binding, messageId: undefined }, () => {})
      .context,
    undefined,
  );
  f.revoke();
  assert.equal(openBeforeDispatchOperatorContext(source, f.binding, () => {}).context, undefined);
});

it("manufactured capabilities and unissued run authorities fail closed", () => {
  const f = fixture();
  assert.equal(
    captureChatSendOperatorContext({
      client: f.client,
      authority: { profileId: "fixture-owner", scopes: ["operator.admin"], assertCurrent() {} },
      ...f.binding,
      assertRequestCurrent() {},
    }),
    undefined,
  );
  assert.equal(
    openBeforeDispatchOperatorContext(
      {
        assertCurrent() {
          return { principalType: "authenticated_operator", operatorId: "fixture-owner" };
        },
      },
      f.binding,
      () => {},
    ).context,
    undefined,
  );
});
