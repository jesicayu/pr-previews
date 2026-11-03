// The instance runtime: a Namespace remote builder in the customer's tenant builds the pull
// request's image, then a new instance runs it until its deadline. Each push gets a new image and a
// new instance; the previous instance is destroyed once the new one answers.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createComputeClient } from "@namespacelabs/sdk/api/compute";
import { fromBearerToken } from "@namespacelabs/sdk/auth";
import { ContainerPort_Proto } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import { repoTarball } from "./github-app.ts";
import { partner } from "./partner.ts";
import type { PreviewConfig } from "./preview-config.ts";
import { previewLabels, tenantToken, waitForHttp, type PullRequest } from "./previews.ts";

const lifetimeHours = 24;

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: Readable } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    options.stdin?.pipe(child.stdin!);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} failed:\n${output.split("\n").slice(-25).join("\n")}`)),
    );
  });
}

async function compute(pr: PullRequest) {
  return createComputeClient({ tokenSource: fromBearerToken(await tenantToken(pr.tenantId)) });
}

async function prInstances(pr: PullRequest) {
  const labels = previewLabels(pr);
  const { instances } = await (await compute(pr)).compute.listInstances({});
  return instances.filter((i) => Object.entries(labels).every(([k, v]) => i.labels.some((l) => l.name === k && l.value === v)));
}

export async function deployInstance(pr: PullRequest, config: PreviewConfig) {
  const steps: Record<string, number> = {};
  let started = Date.now();

  // Build in the customer's tenant: nsc acts as the tenant when NSC_TOKEN_FILE holds a tenant token,
  // so the build runs on that tenant's remote builder and pushes to that tenant's registry.
  const dir = await mkdtemp(join(tmpdir(), "pr-previews-src-"));
  // The token lives outside the build context, so a Dockerfile's COPY can't put it in the image.
  const tokenDir = await mkdtemp(join(tmpdir(), "pr-previews-token-"));
  let image: string;
  try {
    await run("tar", ["xz", "--strip-components=1", "-C", dir], {
      stdin: Readable.fromWeb((await repoTarball(pr.installationId, pr.owner, pr.repo, pr.sha)) as never),
    });
    // Its own token, valid for an hour, so a long build doesn't outlive it.
    const { bearerToken } = await partner.tenants.issueTenantToken({
      tenantId: pr.tenantId,
      actorId: "pr-previews:build",
      durationSecs: 3600n,
    });
    const tokenFile = join(tokenDir, "token.json");
    await writeFile(tokenFile, JSON.stringify({ bearer_token: bearerToken }), { mode: 0o600 });
    const name = `${pr.repo.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}:${pr.sha.slice(0, 12)}`;
    const output = await run(
      "nsc",
      // Run from the checkout: the remote builder resolves --file relative to the build context.
      ["build", ".", "--file", config.dockerfile, "--name", name, "--platform", "linux/amd64", "--push"],
      { cwd: dir, env: { ...process.env, NSC_TOKEN_FILE: tokenFile } },
    );
    image = output.match(/nscr\.io\/\S+/g)!.at(-1)!;
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(tokenDir, { recursive: true, force: true });
  }
  steps.build = Date.now() - started;

  started = Date.now();
  const previous = await prInstances(pr);
  const client = await compute(pr);
  const created = await client.compute.createInstance({
    shape: { virtualCpu: 2, memoryMegabytes: 4096, machineArch: "amd64", os: "linux" },
    documentedPurpose: `Preview of ${pr.owner}/${pr.repo}#${pr.number} at ${pr.sha.slice(0, 7)}`,
    deadline: timestampFromDate(new Date(Date.now() + lifetimeHours * 3600_000)),
    labels: Object.entries(previewLabels(pr)).map(([name, value]) => ({ name, value })),
    containers: [
      {
        name: "app",
        imageRef: image,
        exportPorts: [{ name: "http", containerPort: config.port, proto: ContainerPort_Proto.HTTP }],
      },
    ],
  });
  const id = created.metadata!.instanceId;
  await client.compute.waitInstanceSync({ instanceId: id });
  await waitForHttp(`https://${created.containers[0].exportedPort[0].fqdn}`, pr.tenantId);
  steps.start = Date.now() - started;

  for (const old of previous) await client.compute.destroyInstance({ instanceId: old.instanceId });
  return { id, steps, detail: `image \`${image}\`, 2 vCPU / 4 GB, expires in ${lifetimeHours} h` };
}

export async function removeInstances(pr: PullRequest) {
  const client = await compute(pr);
  for (const instance of await prInstances(pr)) await client.compute.destroyInstance({ instanceId: instance.instanceId });
}
