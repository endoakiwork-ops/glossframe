export interface Env {
  DB: D1Database;
  IMAGES: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  DEFAULT_MODEL?: string;
  WORD_MODEL?: string;
  FALLBACK_MODEL?: string;
  SESSION_DAYS?: string;
  APP_NAME?: string;
  OWNER_SETUP_DISABLED?: string;
  INITIAL_OWNER_PASSWORD?: string;
  OWNER_RECOVERY_TOKEN?: string;
  /** Optional: lets the usage sheet show account-wide Neurons from Cloudflare analytics. */
  CF_ACCOUNT_ID?: string;
  /** Secret API token with "Account Analytics: Read". */
  CF_ANALYTICS_TOKEN?: string;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface AppVariables {
  session: SessionRecord;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
