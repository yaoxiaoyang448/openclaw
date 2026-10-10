import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import * as getReply from "../auto-reply/reply/get-reply.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type {
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
} from "../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import * as agentDispatch from "./server-methods/chat-send-agent-dispatch.js";
import * as operatorContext from "./server-methods/chat-send-operator-context.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

// Actual isolated Gateway, token handshake, admission, dispatch, and hook runner.
// No model provider or MUSE runtime is installed: the hook handles every admitted turn.
it(
  "binds real Token Operator chat.send authority to the current hook request",
  { timeout: 90_000 },
  async ({ signal }) => {
    await withOpenClawTestState(
      {
        label: "operator-bridge",
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.path("no-plugins");
        state.applyEnv();
        const originalCapture = operatorContext.captureChatSendOperatorContext;
        const admitted = new Map<string, Parameters<typeof originalCapture>[0]>();
        const observer = vi
          .spyOn(operatorContext, "captureChatSendOperatorContext")
          .mockImplementation((params) => {
            admitted.set(params.messageId, params);
            return originalCapture(params);
          });
        const dispatches = new Map<string, Parameters<typeof agentDispatch.startChatDispatch>[0]>();
        const dispatchOriginal = agentDispatch.startChatDispatch;
        const dispatchObserver = vi
          .spyOn(agentDispatch, "startChatDispatch")
          .mockImplementation((params) => {
            dispatches.set(params.session.clientRunId, params);
            dispatchOriginal(params);
          });
        let modelFallthroughs = 0;
        const modelGuard = vi.spyOn(getReply, "getReplyFromConfig").mockImplementation(async () => {
          modelFallthroughs += 1;
          throw new Error("UNEXPECTED_HOST_MODEL_FALLTHROUGH");
        });
        let expectedProfile: string;
        // Attach a rejection observer immediately; tests join each guarded promise later.
        const guarded = <T>(work: PromiseLike<T>) => {
          const joined = withinTest(work, signal);
          void joined.catch(() => {});
          return joined;
        };
        const releases = new Map<string, () => void>();
        const terminalWaiters = new Map<string, () => void>();
        const terminalSeen = new Set<string>();
        const onEvent = (evt: { event?: string; payload?: unknown }) => {
          const p = evt.payload as { runId?: string; state?: string } | undefined;
          if (
            evt.event === "chat" &&
            p?.runId &&
            ["final", "error", "aborted"].includes(p.state ?? "")
          ) {
            terminalSeen.add(p.runId);
            terminalWaiters.get(p.runId)?.();
          }
        };
        const terminal = (id: string) =>
          guarded(
            terminalSeen.has(id)
              ? Promise.resolve()
              : new Promise<void>((resolve) => terminalWaiters.set(id, resolve)),
          );
        const signalAborted = (target: AbortSignal) =>
          guarded(
            target.aborted
              ? Promise.resolve()
              : new Promise<void>((resolve) =>
                  target.addEventListener("abort", () => resolve(), { once: true }),
                ),
          );
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        let second: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
        const hooks = new Map<string, PluginHookBeforeDispatchContext>();
        const internalRequests = new Set<string>();
        const pending = new Map<
          string,
          {
            resolve: (ctx: PluginHookBeforeDispatchContext) => void;
            reject: (error: unknown) => void;
          }
        >();
        const awaitHook = (id: string) =>
          guarded(
            new Promise<PluginHookBeforeDispatchContext>((resolve, reject) =>
              pending.set(id, { resolve, reject }),
            ),
          );
        await runQaGatewayFixture(
          async () => {
            const token = "synthetic-operator-bridge-token";
            gateway = await startGatewayWithClient({
              cfg: {
                agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
                gateway: {
                  auth: { mode: "token", token },
                  controlUi: { allowedOrigins: ["http://localhost"] },
                },
                plugins: { slots: { memory: "none" } },
                tools: { profile: "minimal" },
              },
              configPath: state.configPath,
              token,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              origin: "http://localhost",
              scopes: ["operator.admin", "operator.read", "operator.write"],
              onEvent,
            });
            expect([18789, 18889, 18890]).not.toContain(gateway.port);
            const registry = createEmptyPluginRegistry();
            registry.typedHooks.push({
              pluginId: "operator-bridge-proof",
              source: "test",
              hookName: "before_dispatch",
              conversationAccessAllowed: true,
              handler: async (
                event: PluginHookBeforeDispatchEvent,
                ctx: PluginHookBeforeDispatchContext,
              ) => {
                const held = new Promise<void>((resolve) => releases.set(ctx.messageId!, resolve));
                const id = ctx.messageId!;
                try {
                  if (internalRequests.has(id)) {
                    expect(admitted.has(id)).toBe(false);
                    expect(dispatches.get(id)?.request.systemInputProvenance?.kind).toBe(
                      "internal_system",
                    );
                    expect(ctx.authenticatedOperator).toBeUndefined();
                    hooks.set(id, ctx);
                    pending.get(id)?.resolve(ctx);
                  } else {
                    const observation = admitted.get(id)!;
                    expect(observation).toBeDefined();
                    expect(observation.client?.internal?.authenticatedOperator).toBe(true);
                    expect(observation.client?.connect.role).toBe("operator");
                    const profile = observation.client?.authenticatedUserProfile?.profileId;
                    expect(profile).toBe(expectedProfile);
                    expect(dispatches.get(id)?.turn.ctx.MessageSid).toBe(id);
                    expect(dispatches.get(id)?.session.clientRunId).toBe(id);
                    expect(observation.authority?.profileId).toBe(profile);
                    expect(event.messageId).toBe(id);
                    expect(observation.messageId).toBe(id);
                    expect(observation.sessionKey).toBe(ctx.sessionKey);
                    expect(
                      ctx.authenticatedOperator?.assertCurrent({
                        sessionKey: ctx.sessionKey!,
                        messageId: id,
                      }),
                    ).toEqual({
                      principalType: "authenticated_operator",
                      operatorId: profile,
                    });
                    hooks.set(id, ctx);
                    pending.get(id)?.resolve(ctx);
                  }
                } catch (error) {
                  pending.get(id)?.reject(error);
                }
                await held;
                return { handled: true, text: "isolated-operator-bridge-proof" };
              },
            });
            setActivePluginRegistry(registry);
            const self = await gateway.client.request<UsersSelfResult>("users.self", {});
            expectedProfile = self.profile.id;
            expect(expectedProfile).toBeTruthy();
            second = await connectGatewayClient({
              url: `ws://127.0.0.1:${gateway.port}`,
              token,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              origin: "http://localhost",
              scopes: ["operator.admin", "operator.read", "operator.write"],
              onEvent,
            });
            const sessions = await Promise.all(
              [gateway.client, second].map((client, index) =>
                client.request<{ key: string }>("sessions.create", {
                  agentId: "main",
                  label: `Operator bridge proof ${index}`,
                }),
              ),
            );
            const ids = [randomUUID(), randomUUID()];
            const awaited = ids.map(awaitHook);
            await Promise.all(
              [gateway.client, second].map((client, index) =>
                client.request("chat.send", {
                  sessionKey: sessions[index]!.key,
                  message: "operator bridge proof",
                  idempotencyKey: ids[index],
                }),
              ),
            );
            await guarded(Promise.all(awaited));
            const firstSource = admitted.get(ids[0]!)!,
              secondSource = admitted.get(ids[1]!)!;
            expect(firstSource.client?.connId).not.toBe(secondSource.client?.connId);
            expect(firstSource.authority).not.toBe(secondSource.authority);
            expect(() =>
              hooks.get(ids[0]!)!.authenticatedOperator!.assertCurrent({
                sessionKey: sessions[1]!.key,
                messageId: ids[1]!,
              }),
            ).toThrow();
            // Cross-binding rejection must not retire its own correctly bound capability.
            expect(
              hooks.get(ids[0]!)!.authenticatedOperator!.assertCurrent({
                sessionKey: sessions[0]!.key,
                messageId: ids[0]!,
              }).operatorId,
            ).toBe(expectedProfile);
            ids.forEach((id) => releases.get(id)?.());
            await guarded(Promise.all(ids.map(terminal)));
            expect(() =>
              hooks.get(ids[0]!)!.authenticatedOperator!.assertCurrent({
                sessionKey: sessions[0]!.key,
                messageId: ids[0]!,
              }),
            ).toThrow();
            const heldTurn = async (client: NonNullable<typeof gateway>["client"], key: string) => {
              const id = randomUUID();
              const entered = awaitHook(id);
              await client.request("chat.send", {
                sessionKey: key,
                message: "held authority proof",
                idempotencyKey: id,
              });
              const ctx = await entered;
              return { id, ctx, binding: { sessionKey: key, messageId: id } };
            };
            const disconnected = await heldTurn(gateway.client, sessions[0]!.key);
            const disconnectSignal = admitted.get(disconnected.id)!.client!.connectionSignal!;
            const disconnectedEvent = signalAborted(disconnectSignal);
            await disconnectGatewayClient(gateway.client);
            await disconnectedEvent;
            expect(() =>
              disconnected.ctx.authenticatedOperator!.assertCurrent(disconnected.binding),
            ).toThrow();
            releases.get(disconnected.id)?.();
            const resetTurn = await heldTurn(second, sessions[1]!.key);
            const resetAborted = signalAborted(
              dispatches.get(resetTurn.id)!.admission.activeRunAbort.controller.signal,
            );
            const resetting = guarded(second.request("sessions.reset", { key: sessions[1]!.key }));
            void resetting.catch(() => {});
            await resetAborted;
            expect(() =>
              resetTurn.ctx.authenticatedOperator!.assertCurrent(resetTurn.binding),
            ).toThrow();
            releases.get(resetTurn.id)?.();
            await resetting;
            await expect(
              connectGatewayClient({
                url: `ws://127.0.0.1:${gateway.port}`,
                token: "synthetic-wrong-token",
                clientName: "openclaw-control-ui",
                mode: "webchat",
                origin: "http://localhost",
                scopes: ["operator.admin", "operator.read", "operator.write"],
                timeoutMs: 2_000,
              }),
            ).rejects.toThrow();
            // Closed RPC schema rejects the client-supplied Operator capability before dispatch.
            for (const forged of [{ authenticatedOperator: { operatorId: "gateway-owner" } }]) {
              await expect(
                second.request("chat.send", {
                  sessionKey: sessions[1]!.key,
                  message: "forged bridge proof",
                  idempotencyKey: randomUUID(),
                  ...forged,
                }),
              ).rejects.toThrow();
            }
            // Existing Host admin permission permits system provenance, but it cannot grant this external-user capability.
            const internalId = randomUUID();
            internalRequests.add(internalId);
            const internalEntered = awaitHook(internalId);
            await second.request("chat.send", {
              sessionKey: sessions[1]!.key,
              message: "isolated internal provenance proof",
              idempotencyKey: internalId,
              systemInputProvenance: { kind: "internal_system", sourceTool: "isolated-test" },
            });
            await internalEntered;
            releases.get(internalId)?.();
            await terminal(internalId);
            // Invalidation through the actual Host policy owner; this is not an admin role-assignment RPC.
            const revoked = await heldTurn(second, sessions[1]!.key);
            invalidateOperatorRolePolicy(expectedProfile);
            expect(() =>
              revoked.ctx.authenticatedOperator!.assertCurrent(revoked.binding),
            ).toThrow();
            releases.get(revoked.id)?.();
            expect(hooks.size).toBe(6);
            expect(modelFallthroughs).toBe(0);
          },
          () => {
            releases.forEach((release) => release());
          },
          () => (second ? disconnectGatewayClient(second) : undefined),
          () => (gateway ? disconnectGatewayClient(gateway.client) : undefined),
          () => gateway?.server.close({ reason: "isolated operator bridge proof complete" }),
          () => observer.mockRestore(),
          () => dispatchObserver.mockRestore(),
          () => modelGuard.mockRestore(),
          () => resetGlobalHookRunner(),
        );
        expect(modelFallthroughs).toBe(0);
      },
    );
  },
);
