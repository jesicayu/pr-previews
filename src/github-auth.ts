// "Sign in with GitHub" through the platform's GitHub App, and the check that decides who may see
// a preview: whoever can read the repository on GitHub.
import { githubApp as app } from "./github-app.ts";

const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? app.clientSecret;
if (!clientSecret) {
  throw new Error("Generate a client secret in the GitHub App's settings and save it as clientSecret in ~/.pr-previews/github-app.json");
}

export function authorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state });
  return `https://github.com/login/oauth/authorize?${params}`;
}

// Exchanges the code GitHub sends back for a user access token.
export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: app.clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const body = (await response.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(`GitHub sign-in failed: ${body.error_description ?? response.status}`);
  return body.access_token;
}

const github = (token: string, path: string) =>
  fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });

export async function githubLogin(token: string): Promise<string> {
  const response = await github(token, "/user");
  if (!response.ok) throw new Error(`GitHub /user: ${response.status}`);
  return ((await response.json()) as { login: string }).login;
}

// GitHub only returns a repository to users who can read it, so this mirrors GitHub's permissions:
// collaborators and organization members for private repositories, everyone for public ones.
export async function canReadRepo(token: string, owner: string, repo: string): Promise<boolean> {
  return (await github(token, `/repos/${owner}/${repo}`)).ok;
}
