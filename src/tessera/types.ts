export interface GitHubTokenRequest {
  identity: "app" | "user";
  repo?: string;
  access: "read" | "write";
  refresh?: boolean;
  sliceId?: string;
}
export interface GitHubEntitlement {
  token: string;
  expiresAt: string | null;
  identity: string;
  commitIdentity: { name: string; email: string } | null;
  source: "tessera" | "env-fallback";
}
export interface WireEntitlement {
  token: string;
  expires_at: string | null;
  identity: string;
  commit_identity: { name: string; email: string } | null;
  access: "read" | "write";
  repo: string | null;
}
export interface TesseraStatus {
  service: "march-tessera";
  uptime_s: number;
  providers: {
    provider: "github-app" | "github-user";
    state: "ok" | "unconfigured" | "degraded" | "invalid";
    login: string | null;
    credential_expires_at: string | null;
    expiry_warning: boolean;
    last_error: string | null;
  }[];
  soonest_expiry: string | null;
  cache: { entries: number };
}
