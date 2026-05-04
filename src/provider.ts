// Provider barrel + env-driven factory.
//
// Use `resolveProviderFromEnv` from the CLI; tests can construct a specific
// provider directly via the named factories.

import {
  createAnthropicProvider,
  type AnthropicProviderOpts,
} from "./provider-anthropic.js";
import {
  createCloudflareProvider,
  type CloudflareProviderOpts,
} from "./provider-cloudflare.js";
import type { Provider } from "./types.js";

export {
  createAnthropicProvider,
  createCloudflareProvider,
};
export type { AnthropicProviderOpts, CloudflareProviderOpts, Provider };

export interface ResolveProviderOpts {
  /** Optional model override (CLI --model flag). */
  model?: string;
  /** Optional max-tokens override. Default 8000. */
  maxTokens?: number;
  /** Snapshot of env vars. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Force a specific provider (overrides env auto-detect). */
  force?: "anthropic" | "cloudflare";
}

/**
 * Pick a provider from env vars.
 *
 * Priority:
 *   1. `opts.force` if set.
 *   2. `HARNESS_PROVIDER` env var (`anthropic` | `cloudflare`).
 *   3. Auto-detect:
 *        a. CF_ACCOUNT_ID + CF_API_TOKEN → cloudflare.
 *        b. ANTHROPIC_API_KEY → anthropic.
 *   4. Throw.
 */
export const resolveProviderFromEnv = (
  opts: ResolveProviderOpts = {},
): { provider: Provider; choice: "anthropic" | "cloudflare"; model: string } => {
  const env = opts.env ?? process.env;
  const explicit = opts.force ?? (env["HARNESS_PROVIDER"] as ResolveProviderOpts["force"] | undefined);
  const maxTokens = opts.maxTokens ?? 8000;

  const cfAccount = env["CF_ACCOUNT_ID"];
  const cfToken = env["CF_API_TOKEN"];
  const anthropicKey = env["ANTHROPIC_API_KEY"];

  const useCloudflare = (): { provider: Provider; choice: "cloudflare"; model: string } => {
    if (!cfAccount || !cfToken) {
      throw new Error(
        "cloudflare provider requires CF_ACCOUNT_ID and CF_API_TOKEN env vars",
      );
    }
    const model =
      opts.model ?? env["CF_LLM_MODEL"] ?? "@cf/google/gemma-4-26b-a4b-it";
    const cloudflareOpts: CloudflareProviderOpts = {
      accountId: cfAccount,
      apiToken: cfToken,
      model,
      maxTokens,
    };
    return {
      provider: createCloudflareProvider(cloudflareOpts),
      choice: "cloudflare",
      model,
    };
  };

  const useAnthropic = (): { provider: Provider; choice: "anthropic"; model: string } => {
    if (!anthropicKey) {
      throw new Error("anthropic provider requires ANTHROPIC_API_KEY env var");
    }
    const model =
      opts.model ?? env["HARNESS_DEFAULT_MODEL"] ?? "claude-opus-4-7";
    const anthropicOpts: AnthropicProviderOpts = {
      apiKey: anthropicKey,
      model,
      maxTokens,
    };
    return {
      provider: createAnthropicProvider(anthropicOpts),
      choice: "anthropic",
      model,
    };
  };

  if (explicit === "cloudflare") return useCloudflare();
  if (explicit === "anthropic") return useAnthropic();

  // Auto-detect: prefer Cloudflare (the user adopted it explicitly per the
  // co-evolution; Anthropic is the fallback baseline).
  if (cfAccount && cfToken) return useCloudflare();
  if (anthropicKey) return useAnthropic();

  throw new Error(
    "no LLM provider configured: set CF_ACCOUNT_ID+CF_API_TOKEN (cloudflare) or ANTHROPIC_API_KEY (anthropic)",
  );
};
