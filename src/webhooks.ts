// What the platform does when GitHub tells it something happened:
// - the app is installed or uninstalled: create or remove the customer's tenant
// - a pull request is opened or pushed to: build and run its preview with the runtime the
//   repository's .pr-previews.yml chooses, then comment the link on the pull request
// - a pull request is closed: delete its preview
import { deployDevbox, removeDevbox } from "./devbox-runtime.ts";
import { readRepoFile, upsertComment } from "./github-app.ts";
import { deployInstance, removeInstances } from "./instance-runtime.ts";
import { ensureCustomerTenant, removeCustomerTenant } from "./partner.ts";
import { configPath, parseConfig } from "./preview-config.ts";
import type { PullRequest } from "./previews.ts";

// Work on one pull request runs one step at a time, in the order events arrived.
const queues = new Map<string, Promise<void>>();

function enqueue(pr: PullRequest, work: () => Promise<void>) {
  const key = `${pr.owner}/${pr.repo}#${pr.number}`;
  const next = (queues.get(key) ?? Promise.resolve()).then(work).catch((error) => console.error(key, error));
  queues.set(key, next);
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const runtimeName = { instance: "Namespace instance", devbox: "Namespace Devbox" };

async function deploy(pr: PullRequest, publicUrl: string) {
  const comment = (body: string) => upsertComment(pr.installationId, pr.owner, pr.repo, pr.number, body);
  const commit = pr.sha.slice(0, 7);

  const text = await readRepoFile(pr.installationId, pr.owner, pr.repo, configPath, pr.sha);
  if (text === undefined) return console.log(`${pr.owner}/${pr.repo}#${pr.number}: no ${configPath}, no preview`);
  let config;
  try {
    config = parseConfig(text);
  } catch (error) {
    return comment(`**Preview not built:** ${(error as Error).message}`);
  }

  await comment(`⏳ Building a preview of ${commit} on a ${runtimeName[config.runtime]}…`);
  const started = Date.now();
  try {
    const result = config.runtime === "instance" ? await deployInstance(pr, config) : await deployDevbox(pr, config);
    // If the repository switched runtimes, the other runtime's preview is now stale.
    await (config.runtime === "instance" ? removeDevbox(pr) : removeInstances(pr));
    const link = `${publicUrl}/_pr-previews/open/${pr.tenantId}/${config.runtime}/${result.id}`;
    const steps = Object.entries(result.steps).map(([name, ms]) => `${name} ${seconds(ms)}`).join(", ");
    await comment(
      [
        `✅ **[Open the preview](${link})** of ${commit}, on a ${runtimeName[config.runtime]}.`,
        "",
        `Ready ${seconds(Date.now() - started)} after the push was picked up (${steps}); ${result.detail}.`,
        "",
        "Sign in with GitHub to view it. Anyone who can read this repository can.",
      ].join("\n"),
    );
  } catch (error) {
    await comment(`❌ **Preview of ${commit} failed** on a ${runtimeName[config.runtime]}:\n\n\`\`\`\n${(error as Error).message}\n\`\`\``);
    throw error;
  }
}

async function teardown(pr: PullRequest) {
  await removeInstances(pr);
  await removeDevbox(pr);
  await upsertComment(pr.installationId, pr.owner, pr.repo, pr.number, "The preview was deleted when the pull request closed.");
}

export async function handleWebhook(event: string, payload: any, publicUrl: string) {
  if (event === "installation") {
    const account = payload.installation.account;
    if (payload.action === "created") {
      const tenant = await ensureCustomerTenant(account.id, account.login);
      console.log(`installed on ${account.login}: tenant ${tenant.id}`);
    } else if (payload.action === "deleted") {
      await removeCustomerTenant(account.id);
      console.log(`uninstalled from ${account.login}: tenant removed`);
    }
    return;
  }

  if (event !== "pull_request") return;
  const { pull_request: pull, repository } = payload;
  // Pull requests from forks run code from outside the customer's account; don't build them.
  if (pull.head.repo?.full_name !== repository.full_name) return console.log(`skipped fork PR ${repository.full_name}#${pull.number}`);

  const tenant = await ensureCustomerTenant(repository.owner.id, repository.owner.login);
  const pr: PullRequest = {
    installationId: payload.installation.id,
    tenantId: tenant.id,
    owner: repository.owner.login,
    repo: repository.name,
    number: pull.number,
    sha: pull.head.sha,
  };
  if (["opened", "reopened", "synchronize"].includes(payload.action)) enqueue(pr, () => deploy(pr, publicUrl));
  else if (payload.action === "closed") enqueue(pr, () => teardown(pr));
}
