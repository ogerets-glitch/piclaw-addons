/** This milestone defines a wire profile; it does not enable an A2A service. */
export const A2A_PROFILE = Object.freeze({
  specification: "1.0.1",
  specificationCommit: "3303592588e388e62e0f69f701af531d2f4e3991",
  wireVersion: "1.0",
  sdk: "@a2a-js/sdk",
  sdkVersion: "1.3.0",
  binding: "JSONRPC",
  cardPath: "/api/addons/a2a/agent-card.json",
  rpcPath: "/api/addons/a2a/rpc",
  methods: [
    "SendMessage",
    "SendStreamingMessage",
    "GetTask",
    "ListTasks",
    "CancelTask",
    "SubscribeToTask",
  ] as const,
  optInPushMethods: [
    "CreateTaskPushNotificationConfig",
    "GetTaskPushNotificationConfig",
    "ListTaskPushNotificationConfigs",
    "DeleteTaskPushNotificationConfig",
  ] as const,
  unsupportedMethods: ["GetExtendedAgentCard"] as const,
  maxRequestBytes: 32 * 1024,
  maxResponseBytes: 256 * 1024,
  maxStreamFrameBytes: 256 * 1024,
  maxStreamBytes: 2 * 1024 * 1024,
});

export function profileStatus() {
  return {
    enabled: false as const,
    stage: "profile-validation" as const,
    networkActive: false as const,
    profile: A2A_PROFILE,
    blockedBy: [
      "principal-policy",
      "durable-admission",
      "operation-results",
      "task-store",
      "operator-enable",
    ],
  };
}
