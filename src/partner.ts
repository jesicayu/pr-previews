// The platform's own Namespace identity: a partner client that manages customers' tenants, and
// tenant clients that act inside one of them.
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createIAMClient } from "@namespacelabs/sdk/api/iam";
import type { TokenSource } from "@namespacelabs/sdk/auth";

interface PartnerConfig {
  partnerId: string;
  issuer: string;
  keyId: string;
  privateKeyPath: string;
}

// Kept outside the repository, next to the private key. PARTNER_CONFIG points elsewhere.
const configPath = expandHome(process.env.PARTNER_CONFIG ?? "~/.namespace-partner/partner.json");
const config: PartnerConfig = JSON.parse(readFileSync(configPath, "utf8"));
const privateKey = readFileSync(expandHome(config.privateKeyPath));

function expandHome(path: string): string {
  return path.replace(/^~(?=\/)/, homedir());
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Signs a short-lived ES256 partner token. The SDK caches it and asks again when fewer than five
// minutes of validity remain.
const partnerTokenSource: TokenSource = {
  async issueToken() {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url({ alg: "ES256", typ: "JWT", kid: config.keyId });
    const claims = base64url({
      iss: config.issuer,
      sub: config.partnerId,
      aud: "namespace.so",
      iat: now,
      exp: now + 20 * 60,
    });
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `oidc_${header}.${claims}.${signature.toString("base64url")}`;
  },
};

export const partner = createIAMClient({ tokenSource: partnerTokenSource });

// Marks the tenants this platform owns: the partner account also holds other tenants.
const platformLabel = { name: "app", value: "pr-previews" };

// A customer's tenant, keyed by their GitHub account's numeric ID, which never changes even when
// the account is renamed. Returns the existing tenant when there is one.
export async function ensureCustomerTenant(githubAccountId: number, githubLogin: string) {
  const { tenant } = await partner.tenants.ensureTenantForExternalAccount({
    externalAccountId: `github:${githubAccountId}`,
    visibleName: githubLogin,
    labels: [platformLabel],
  });
  return tenant!;
}
