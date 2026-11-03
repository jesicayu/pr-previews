// The Devbox runtime: one Devbox per pull request, kept across pushes. Each push fetches the new
// commit into the same checkout, runs the build command with the previous build's files still in
// place (node_modules, build caches), and restarts the app as a service. The checkout lives under
// /workspaces, the only part of a Devbox that survives it stopping when idle.
import { fromBearerToken } from "@namespacelabs/sdk/auth";
import { createDevboxClient, type Devbox } from "@namespacelabs/sdk/devbox";
import { installationToken } from "./github-app.ts";
import type { PreviewConfig } from "./preview-config.ts";
import { previewLabels, retrying, tenantToken, waitForHttp, type PullRequest } from "./previews.ts";

const checkout = "/workspaces/app";

const devboxName = (pr: PullRequest) =>
  `pr-${pr.number}-${pr.repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);

async function devboxes(pr: PullRequest) {
  return createDevboxClient({ tokenSource: fromBearerToken(await tenantToken(pr.tenantId)) });
}

async function findDevbox(client: ReturnType<typeof createDevboxClient>, pr: PullRequest): Promise<Devbox | undefined> {
  for await (const devbox of client.devboxes.iterate()) if (devbox.name === devboxName(pr)) return devbox;
}

// Starting a command can fail with "Premature close" after the Devbox already started it, so
// before starting again, look for an execution that began after this attempt.
async function startShell(devbox: Devbox, script: string, env: Record<string, string>) {
  for (let attempt = 1; ; attempt++) {
    const since = Date.now() - 5000; // allow for clock differences
    try {
      return await devbox.executions.startShell(script, { cwd: "/workspaces", env });
    } catch (error) {
      if (attempt >= 5 || !String(error).includes("Premature close")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      for (const execution of await retrying(() => devbox.executions.list())) {
        const status = await retrying(() => execution.status());
        if (status.state !== "missing" && (status.startedAt?.getTime() ?? 0) >= since) return execution;
      }
    }
  }
}

// Runs a shell script on the Devbox and fails with the end of its output when it fails. The script
// runs as an execution on the Devbox, so a dropped connection while a long build runs only fails
// one status check, which is retried, instead of the build.
async function shell(devbox: Devbox, script: string, env: Record<string, string> = {}) {
  const execution = await startShell(devbox, `set -e\n${script}`, env);
  const deadline = Date.now() + 30 * 60_000;
  while ((await retrying(() => execution.status())).state === "running") {
    if (Date.now() > deadline) {
      await execution.stop({ mode: "force" });
      throw new Error("Command timed out after 30 minutes");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const result = await retrying(() => execution.wait());
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-25).join("\n");
    throw new Error(`Command failed (exit ${result.exitCode ?? result.error}):\n${output}`);
  }
}

export async function deployDevbox(pr: PullRequest, config: PreviewConfig) {
  const steps: Record<string, number> = {};
  const client = await devboxes(pr);
  try {
    let started = Date.now();
    let devbox = await findDevbox(client, pr);
    const reused = !!devbox;
    if (!devbox) {
      devbox = await client.devboxes.create({
        name: devboxName(pr),
        imageName: "builtin:default",
        size: "m",
        versionControl: {}, // the platform fetches the code itself, with the GitHub App's token
        labels: previewLabels(pr),
      });
    } else if (devbox.info.state !== "running") {
      await devbox.start();
    }
    // Fetch just this commit; the token is passed per command and never stored on the Devbox.
    await shell(
      devbox,
      `mkdir -p ${checkout} && cd ${checkout}
[ -d .git ] || git init -q
git fetch -q --depth 1 "https://x-access-token:$GIT_TOKEN@github.com/${pr.owner}/${pr.repo}.git" ${pr.sha}
git checkout -q -f FETCH_HEAD
git clean -fdq`,
      { GIT_TOKEN: await installationToken(pr.installationId) },
    );
    steps.checkout = Date.now() - started;

    started = Date.now();
    if (config.build) await shell(devbox, `cd ${checkout}\n${config.build}`);
    steps.build = Date.now() - started;

    started = Date.now();
    // A retried call may find its first attempt already went through.
    const ignore = (code: string) => (error: unknown) => {
      if (!String(error).includes(`[${code}]`)) throw error;
    };
    await retrying(() => devbox!.services.delete("app").catch(ignore("not_found"))); // not there on the first push
    await retrying(() => devbox!.services.create({
      name: "app",
      command: "sh",
      args: ["-c", config.start!],
      cwd: checkout,
      environment: { PORT: String(config.port), HOSTNAME: "0.0.0.0" },
    }).catch(ignore("already_exists")));
    // Creating a port can fail on the client after the port was created, so look it up first.
    let port = (await retrying(() => devbox!.exposedPorts.list())).find((p) => p.number === config.port);
    if (!port) {
      await devbox.exposedPorts.create({ name: "app", number: config.port }).catch(() => {});
      port = (await retrying(() => devbox!.exposedPorts.list())).find((p) => p.number === config.port);
    }
    if (!port) throw new Error(`Could not expose port ${config.port} on the Devbox`);
    await waitForHttp(port.url.replace(/\/$/, ""), pr.tenantId);
    steps.start = Date.now() - started;

    const { size, shape } = devbox.info;
    return {
      id: devbox.id,
      steps,
      detail: `${reused ? "same Devbox as the last push" : "new Devbox"} \`${devbox.name}\`, size ${size} (${shape?.vCPUs} vCPU / ${(shape?.memoryMB ?? 0) / 1024} GB)`,
    };
  } finally {
    client.close();
  }
}

export async function removeDevbox(pr: PullRequest) {
  const client = await devboxes(pr);
  try {
    await (await findDevbox(client, pr))?.delete();
  } finally {
    client.close();
  }
}
