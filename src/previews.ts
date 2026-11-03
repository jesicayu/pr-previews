// Finds a preview inside a customer's tenant: the repository it belongs to and its private URL.
// Everything is read from Namespace, using the labels each runtime puts on its previews.
import { createComputeClient } from "@namespacelabs/sdk/api/compute";
import { fromBearerToken } from "@namespacelabs/sdk/auth";
import { createDevboxClient } from "@namespacelabs/sdk/devbox";
import { isPlatformTenant, partner } from "./partner.ts";

export type PreviewKind = "instance" | "devbox";

export interface Preview {
  owner: string; // GitHub owner and repository the preview was built from
  repo: string;
  url: string; // the private Namespace URL, which needs x-nsc-ingress-auth
}

// Labels every preview carries, on instances and Devboxes alike.
export const previewLabels = (owner: string, repo: string) => ({
  app: "pr-previews",
  "github.owner": owner,
  "github.repo": repo,
});

// Tenant tokens are reused until fewer than five minutes of validity remain.
const tokens = new Map<string, { token: string; expiresAt: number }>();

export async function tenantToken(tenantId: string): Promise<string> {
  const cached = tokens.get(tenantId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const { bearerToken } = await partner.tenants.issueTenantToken({
    tenantId,
    actorId: "pr-previews:proxy",
    durationSecs: 15n * 60n,
  });
  tokens.set(tenantId, { token: bearerToken, expiresAt: Date.now() + 15 * 60_000 });
  return bearerToken;
}

export async function findPreview(tenantId: string, kind: PreviewKind, id: string): Promise<Preview | undefined> {
  // The partner account also holds other apps' tenants; never act in those.
  if (!(await isPlatformTenant(tenantId))) return undefined;
  const tokenSource = fromBearerToken(await tenantToken(tenantId));

  let labels: Record<string, string>;
  let url: string | undefined;
  if (kind === "instance") {
    const compute = createComputeClient({ tokenSource });
    const described = await compute.compute.describeInstance({ instanceId: id });
    labels = Object.fromEntries((described.metadata?.labels ?? []).map((l) => [l.name, l.value]));
    const fqdn = described.containers.flatMap((c) => c.exportedPort)[0]?.fqdn;
    url = fqdn && `https://${fqdn}`;
  } else {
    const client = createDevboxClient({ tokenSource });
    try {
      const devbox = await client.devboxes.get(id);
      labels = devbox.info.labels;
      // Idle Devboxes stop. Start one explicitly: the port lookup's implicit start hung in testing.
      if (devbox.info.state !== "running") await devbox.start();
      url = (await devbox.exposedPorts.list())[0]?.url.replace(/\/$/, "");
    } finally {
      client.close();
    }
  }

  if (labels.app !== "pr-previews" || !url) return undefined;
  return { owner: labels["github.owner"], repo: labels["github.repo"], url };
}
