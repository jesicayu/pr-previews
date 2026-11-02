// Creates (or finds) the tenant for a GitHub account, then makes a call inside it with a tenant
// token. Usage: npm run ensure-tenant -- <github-login>
import { createComputeClient } from "@namespacelabs/sdk/api/compute";
import { fromBearerToken, getTenantId } from "@namespacelabs/sdk/auth";
import { ensureCustomerTenant, partner } from "./partner.ts";

const login = process.argv[2];
if (!login) throw new Error("Usage: npm run ensure-tenant -- <github-login>");

const response = await fetch(`https://api.github.com/users/${login}`);
if (!response.ok) throw new Error(`GitHub account ${login}: ${response.status}`);
const account = (await response.json()) as { id: number; login: string };

const tenant = await ensureCustomerTenant(account.id, account.login);
console.log(`Tenant: ${tenant.id}  ${tenant.externalAccountId}  ${tenant.visibleName}`);

const { bearerToken } = await partner.tenants.issueTenantToken({
  tenantId: tenant.id,
  actorId: "pr-previews:ensure-tenant",
});
console.log(`Tenant token acts in: ${getTenantId(bearerToken)}`);

const compute = createComputeClient({ tokenSource: fromBearerToken(bearerToken) });
const { instances } = await compute.compute.listInstances({});
console.log(`Instances in this tenant: ${instances.length}`);
