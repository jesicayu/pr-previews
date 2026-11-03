// The platform acting on GitHub as its GitHub App: verifying webhooks, reading customers'
// repositories, and commenting on their pull requests.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const githubApp: {
  appId: number;
  clientId: string;
  clientSecret?: string;
  webhookSecret: string;
  webhookProxyUrl: string;
  privateKeyPath: string;
} = JSON.parse(readFileSync(join(homedir(), ".pr-previews", "github-app.json"), "utf8"));
const privateKey = readFileSync(githubApp.privateKeyPath);

export function verifyWebhook(body: string, signature: string | undefined): boolean {
  const expected = `sha256=${createHmac("sha256", githubApp.webhookSecret).update(body).digest("hex")}`;
  return !!signature && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// A short-lived JWT that authenticates as the app itself.
function appJwt(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: githubApp.appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

async function request(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...init.headers },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  }
  return response;
}

export async function listInstallations(): Promise<{ id: number; account: { id: number; login: string } }[]> {
  return (await request(appJwt(), "/app/installations")).json() as never;
}

// Installation tokens act on the repositories one customer chose. They last an hour; reuse them
// until ten minutes are left.
const installationTokens = new Map<number, { token: string; expiresAt: number }>();

export async function installationToken(installationId: number): Promise<string> {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 10 * 60_000) return cached.token;
  const response = await request(appJwt(), `/app/installations/${installationId}/access_tokens`, { method: "POST" });
  const { token, expires_at } = (await response.json()) as { token: string; expires_at: string };
  installationTokens.set(installationId, { token, expiresAt: Date.parse(expires_at) });
  return token;
}

// A file from the repository at a commit, or undefined when it doesn't exist.
export async function readRepoFile(installationId: number, owner: string, repo: string, path: string, ref: string) {
  const token = await installationToken(installationId);
  const response = await request(token, `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, {
    headers: { accept: "application/vnd.github.raw+json" },
  });
  return response.status === 404 ? undefined : response.text();
}

// The repository's files at a commit, as a gzipped tarball.
export async function repoTarball(installationId: number, owner: string, repo: string, ref: string) {
  const token = await installationToken(installationId);
  return (await request(token, `/repos/${owner}/${repo}/tarball/${ref}`)).body!;
}

// The platform keeps one comment per pull request, found by this marker, and updates it in place.
const marker = "<!-- pr-previews -->";

export async function upsertComment(installationId: number, owner: string, repo: string, pr: number, body: string) {
  const token = await installationToken(installationId);
  const comments = (await (await request(token, `/repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`)).json()) as {
    id: number;
    body: string;
  }[];
  const existing = comments.find((c) => c.body.startsWith(marker));
  const init = { method: existing ? "PATCH" : "POST", body: JSON.stringify({ body: `${marker}\n${body}` }) };
  const path = existing ? `/repos/${owner}/${repo}/issues/comments/${existing.id}` : `/repos/${owner}/${repo}/issues/${pr}/comments`;
  await request(token, path, init);
}
