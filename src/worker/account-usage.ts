import type { Env } from "./env";
import { quotaDayStart } from "../shared/neurons";

/**
 * Optional account-wide figures from the Cloudflare GraphQL analytics API.
 * They need CF_ACCOUNT_ID and a CF_ANALYTICS_TOKEN with "Account Analytics:
 * Read"; without them, or when the API fails, every lookup returns null and
 * the app falls back to its own measurements.
 */

const NEURON_QUERY = `
query ($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aiInferenceAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { totalNeurons }
      }
    }
  }
}`;

const KV_QUERY = `
query ($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvStorageAdaptiveGroups(limit: 1000, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_DESC]) {
        max { byteCount }
        dimensions { date namespaceId }
      }
    }
  }
}`;

function credentials(env: Env): { accountId: string; token: string } | null {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  return accountId && token ? { accountId, token } : null;
}

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) {
      console.warn("Cloudflare analytics query failed", json.errors);
      return null;
    }
    return json.data ?? null;
  } catch {
    return null;
  }
}

let neuronCache: { key: string; value: { neurons: number; fetchedAt: number } } | null = null;

/**
 * Account-wide Neurons used since the last 00:00 UTC reset. This includes
 * other Workers on the same account, which the app's own token log cannot see.
 */
export async function getAccountNeurons(
  env: Env,
  now = Date.now(),
): Promise<{ neurons: number; fetchedAt: number } | null> {
  const auth = credentials(env);
  if (!auth) return null;

  const start = quotaDayStart(now);
  const key = `${auth.accountId}:${start}`;
  if (neuronCache && neuronCache.key === key && now - neuronCache.value.fetchedAt < 60_000) {
    return neuronCache.value;
  }

  const data = await graphql<{
    viewer?: { accounts?: Array<{ aiInferenceAdaptiveGroups?: Array<{ sum?: { totalNeurons?: number } }> }> };
  }>(auth.token, NEURON_QUERY, {
    accountTag: auth.accountId,
    start: new Date(start).toISOString(),
    end: new Date(now).toISOString(),
  });
  if (!data) return null;
  const groups = data.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
  const neurons = groups.reduce((sum, group) => sum + (Number(group.sum?.totalNeurons) || 0), 0);
  const value = { neurons, fetchedAt: now };
  neuronCache = { key, value };
  return value;
}

let kvCache: { value: number; fetchedAt: number } | null = null;

/**
 * Account-wide KV storage in bytes (the free plan's 1 GB is per account),
 * summing each namespace's latest daily figure. Storage analytics update
 * about daily, so the result is cached for ten minutes.
 */
export async function getAccountKvBytes(env: Env, now = Date.now()): Promise<number | null> {
  const auth = credentials(env);
  if (!auth) return null;
  if (kvCache && now - kvCache.fetchedAt < 10 * 60_000) return kvCache.value;

  const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
  const data = await graphql<{
    viewer?: {
      accounts?: Array<{
        kvStorageAdaptiveGroups?: Array<{
          max?: { byteCount?: number };
          dimensions?: { date?: string; namespaceId?: string };
        }>;
      }>;
    };
  }>(auth.token, KV_QUERY, { accountTag: auth.accountId, start: day(3), end: day(0) });
  if (!data) return null;

  const latest = new Map<string, number>();
  // Rows arrive newest first; keep the first one seen per namespace.
  for (const row of data.viewer?.accounts?.[0]?.kvStorageAdaptiveGroups ?? []) {
    const id = row.dimensions?.namespaceId;
    if (!id || latest.has(id)) continue;
    latest.set(id, Number(row.max?.byteCount) || 0);
  }
  if (!latest.size) return null;
  const value = [...latest.values()].reduce((a, b) => a + b, 0);
  kvCache = { value, fetchedAt: now };
  return value;
}
