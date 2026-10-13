import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";

export type CompatibilityRequestAuth = {
  apiKey?: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
};

export type CompatibilityAuthResolution =
  | { ok: true; auth: CompatibilityRequestAuth }
  | { ok: false; error: string };

/**
 * External extensions receive ModelRegistry rather than the process ModelRuntime.
 * Resolve its complete public compatibility auth contract once per compaction.
 * Auth-selected endpoints are applied to a request-local model copy; credentials,
 * headers and provider-scoped env travel in request options.
 */
export async function resolveCompatibilityRequestAuth(
  registry: Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">,
  model: Model<Api>,
): Promise<CompatibilityAuthResolution> {
  const resolved = await registry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    auth: {
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      headers: resolved.headers,
      env: resolved.env,
    },
  };
}

export function buildCompatibilityCompletionOptions(
  model: Model<Api>,
  auth: CompatibilityRequestAuth,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  return {
    ...options,
    apiKey: options.apiKey ?? auth.apiKey,
    headers: auth.headers || options.headers ? { ...auth.headers, ...options.headers } : undefined,
    env: auth.env || options.env ? { ...auth.env, ...options.env } : undefined,
    ...(model.reasoning ? { reasoning: options.reasoning ?? "high" } : {}),
  };
}

export function modelWithCompatibilityAuth(model: Model<Api>, auth: CompatibilityRequestAuth): Model<Api> {
  return auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
}

export async function completeWithCompatibilityAuth(
  model: Model<Api>,
  context: Context,
  auth: CompatibilityRequestAuth,
  options: SimpleStreamOptions,
) {
  return completeSimple(modelWithCompatibilityAuth(model, auth), context, buildCompatibilityCompletionOptions(model, auth, options));
}
