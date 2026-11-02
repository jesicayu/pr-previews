// Registers the platform's GitHub App with GitHub's manifest flow, then saves its credentials
// outside the repository, in ~/.pr-previews. Usage: npm run register-app -- <app-name>
//
// Open http://localhost:4100 and click "Create GitHub App": GitHub creates the app from the
// manifest below and redirects back here with a code, which is exchanged for the app's ID, private
// key, and webhook secret.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const appName = process.argv[2];
if (!appName) throw new Error("Usage: npm run register-app -- <app-name>");

const dir = join(homedir(), ".pr-previews");
const configPath = join(dir, "github-app.json");
if (existsSync(configPath)) throw new Error(`${configPath} exists: the app is already registered`);

// GitHub can't reach this machine, so it sends webhooks to a smee.io channel, which relays them.
const webhookProxyUrl =
  process.env.WEBHOOK_PROXY_URL ??
  (await fetch("https://smee.io/new", { redirect: "manual" })).headers.get("location")!;

const port = 4100;
const state = randomBytes(16).toString("hex");
const manifest = {
  name: appName,
  url: "https://github.com/jesicayu/pr-previews",
  hook_attributes: { url: webhookProxyUrl },
  redirect_url: `http://localhost:${port}/callback`,
  // Any account can install it, so each customer installs it on their own account or organization.
  public: true,
  default_permissions: {
    metadata: "read",
    pull_requests: "write", // read pull requests, post the preview comment
    contents: "read", // download a pull request's code to build it
    actions: "read", // know when CI finished
  },
  // Installation events are always sent to apps.
  default_events: ["pull_request", "workflow_run"],
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html");
    res.end(`<form action="https://github.com/settings/apps/new?state=${state}" method="post">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <p>Registers <b>${escapeHtml(appName)}</b> on your GitHub account.</p>
  <button>Continue to GitHub</button>
</form>`);
    return;
  }

  if (url.pathname === "/callback" && url.searchParams.get("state") === state) {
    const code = url.searchParams.get("code");
    const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      res.statusCode = 502;
      res.end(`GitHub refused the code: ${response.status} ${await response.text()}`);
      return;
    }
    const app = (await response.json()) as {
      id: number;
      slug: string;
      client_id: string;
      webhook_secret: string;
      pem: string;
      html_url: string;
    };

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const privateKeyPath = join(dir, "github-app.private-key.pem");
    writeFileSync(privateKeyPath, app.pem, { mode: 0o600 });
    const config = {
      appId: app.id,
      slug: app.slug,
      clientId: app.client_id,
      webhookSecret: app.webhook_secret,
      webhookProxyUrl,
      privateKeyPath,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });

    const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
    res.setHeader("content-type", "text/html");
    res.end(`<p>Registered <a href="${app.html_url}">${app.slug}</a>.</p>
<p>Next: <a href="${installUrl}">install it</a> on your account.</p>`);
    console.log(`Registered ${app.slug} (app ID ${app.id}). Saved ${configPath}`);
    console.log(`Install it: ${installUrl}`);
    server.close();
    return;
  }

  res.statusCode = 404;
  res.end();
});

server.listen(port, () => {
  console.log(`Webhooks go to ${webhookProxyUrl}`);
  console.log(`Open http://localhost:${port} and click "Continue to GitHub".`);
});
