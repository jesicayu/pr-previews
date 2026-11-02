// Makes one read-only call to check that the partner credentials work.
import { partner } from "./partner.ts";

const { tenants } = await partner.tenants.listTenants({ limit: 100 });

console.log(`Partner credentials work. Tenants: ${tenants.length}`);
for (const t of tenants) {
  console.log(`  ${t.id}  ${t.externalAccountId}  ${t.visibleName}`);
}
