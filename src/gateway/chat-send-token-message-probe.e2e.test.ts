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
import * as agentDispatch from "./server-methods/chat-send-agent-dispatch.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

// Identical Base/PR probe of real token, profile, admission and message-id composition.
// Deliberately independent of the PR-only capability issuer helper.
it(
  "carries real Token Operator profile and request message id through before_dispatch",
  { timeout: 90_000 },
  async ({ signal }) => {
    const guarded = <T>(work: PromiseLike<T>) => {
      const p = withinTest(work, signal);
      void p.catch(() => {});
      return p;
    };
    await withOpenClawTestState(
      {
        label: "token-message-probe",
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
        let captured: Parameters<typeof agentDispatch.startChatDispatch>[0] | undefined;
        const dispatchOriginal = agentDispatch.startChatDispatch;
        const dispatchObserver = vi
          .spyOn(agentDispatch, "startChatDispatch")
          .mockImplementation((params) => {
            captured = params;
            dispatchOriginal(params);
          });
        let modelFallthroughs = 0;
        const modelGuard = vi.spyOn(getReply, "getReplyFromConfig").mockImplementation(async () => {
          modelFallthroughs++;
          throw new Error("UNEXPECTED_HOST_MODEL_FALLTHROUGH");
        });
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        let resolveHook!: (context: PluginHookBeforeDispatchContext) => void;
        let rejectHook!: (error: unknown) => void;
        const entered = guarded(
          new Promise<PluginHookBeforeDispatchContext>((resolve, reject) => {
            resolveHook = resolve;
            rejectHook = reject;
          }),
        );
        let resolveTerminal!: () => void;
        const ended = guarded(
          new Promise<void>((resolve) => {
            resolveTerminal = resolve;
          }),
        );
        const id = randomUUID();
        await runQaGatewayFixture(
          async () => {
            const token = "synthetic-token-message-probe";
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
              onEvent: (event) => {
                const payload = event.payload as { runId?: string; state?: string } | undefined;
                if (
                  event.event === "chat" &&
                  payload?.runId === id &&
                  ["final", "aborted", "error"].includes(payload.state ?? "")
                )
                  resolveTerminal();
              },
            });
            expect([18789, 18889, 18890]).not.toContain(gateway.port);
            const self = await guarded(gateway.client.request<UsersSelfResult>("users.self", {}));
            const registry = createEmptyPluginRegistry();
            registry.typedHooks.push({
              pluginId: "token-message-probe",
              source: "test",
              hookName: "before_dispatch",
              conversationAccessAllowed: true,
              handler: (
                event: PluginHookBeforeDispatchEvent,
                context: PluginHookBeforeDispatchContext,
              ) => {
                try {
                  expect(captured?.client?.internal?.authenticatedOperator).toBe(true);
                  expect(captured?.client?.connect.role).toBe("operator");
                  expect(captured?.client?.authenticatedUserProfile?.profileId).toBe(
                    self.profile.id,
                  );
                  expect(self.profile.id).toBeTruthy();
                  expect(captured?.admission.operatorAuthority?.profileId).toBe(self.profile.id);
                  expect(captured?.session.clientRunId).toBe(id);
                  expect(captured?.turn.ctx.MessageSid).toBe(id);
                  expect(context.messageId).toBe(id);
                  expect(event.messageId).toBe(id);
                  expect(context.sessionKey).toBe(captured?.session.sessionKey);
                  resolveHook(context);
                } catch (error) {
                  rejectHook(error);
                }
                return { handled: true, text: "isolated-token-message-proof" };
              },
            });
            setActivePluginRegistry(registry);
            const session = await guarded(
              gateway.client.request<{ key: string }>("sessions.create", {
                agentId: "main",
                label: "Token message proof",
              }),
            );
            await guarded(
              gateway.client.request("chat.send", {
                sessionKey: session.key,
                message: "Token message proof",
                idempotencyKey: id,
              }),
            );
            await entered;
            await ended;
            expect(modelGuard).not.toHaveBeenCalled();
          },
          () => (gateway ? disconnectGatewayClient(gateway.client) : undefined),
          () => gateway?.server.close({ reason: "isolated token message proof complete" }),
          () => dispatchObserver.mockRestore(),
          () => modelGuard.mockRestore(),
          () => resetGlobalHookRunner(),
        );
        expect(modelFallthroughs).toBe(0);
      },
    );
  },
);
