// The platform's web server. Viewers open a preview through it: they sign in with GitHub, the server
// checks they can read the preview's repository, then forwards their requests to the private preview
// on Namespace, adding the tenant token that Namespace's ingress accepts.
//
// PUBLIC_URL is the address viewers use, such as a Cloudflare tunnel; it must also be a callback URL
// of the GitHub App, followed by /_pr-previews/auth/callback.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { authorizeUrl, canReadRepo, exchangeCode, githubLogin } from "./github-auth.ts";
import { findPreview, tenantToken, type Preview, type PreviewKind } from "./previews.ts";

const port = Number(process.env.PORT ?? 4200);
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const callbackUrl = `${publicUrl}/_pr-previews/auth/callback`;
const secureCookies = publicUrl.startsWith("https://");

// Signed-in viewers, by session cookie. In memory: restarting the server signs everyone out.
interface Session {
  login: string;
  token: string; // the viewer's GitHub user token
  allowed: Map<string, number>; // "owner/repo" → until when access was confirmed
}
const sessions = new Map<string, Session>();

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "").split(";").flatMap((part) => {
      const i = part.indexOf("=");
      return i < 0 ? [] : [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]];
    }),
  );
}

function setCookie(res: ServerResponse, name: string, value: string, maxAgeSeconds = 7 * 24 * 3600) {
  const attributes = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookies ? "; Secure" : ""}`;
  const existing = res.getHeader("set-cookie") as string[] | undefined;
  res.setHeader("set-cookie", [...(existing ?? []), `${name}=${encodeURIComponent(value)}; ${attributes}`]);
}

function send(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location }).end();
}

// The preview a cookie or link points at: "<tenant>/<instance|devbox>/<id>".
function parsePreviewRef(ref: string | undefined) {
  const [tenantId, kind, id] = (ref ?? "").split("/");
  if (!tenantId || (kind !== "instance" && kind !== "devbox") || !id) return undefined;
  return { tenantId, kind: kind as PreviewKind, id };
}

// Finds the preview and checks the viewer may see it. Access is rechecked every five minutes.
async function authorize(session: Session, ref: string): Promise<Preview | undefined> {
  const parsed = parsePreviewRef(ref);
  const preview = parsed && (await findPreview(parsed.tenantId, parsed.kind, parsed.id));
  if (!preview) return undefined;
  const key = `${preview.owner}/${preview.repo}`;
  if ((session.allowed.get(key) ?? 0) < Date.now()) {
    if (!(await canReadRepo(session.token, preview.owner, preview.repo))) return undefined;
    session.allowed.set(key, Date.now() + 5 * 60_000);
  }
  return preview;
}

const hopByHop = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);

async function forward(req: IncomingMessage, res: ServerResponse, preview: Preview, tenantId: string) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || hopByHop.has(name) || name === "cookie") continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  // Pass on the app's own cookies, not the platform's session cookies.
  const appCookies = Object.entries(cookies(req)).filter(([name]) => !name.startsWith("pr_"));
  if (appCookies.length) headers.set("cookie", appCookies.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; "));
  headers.set("x-nsc-ingress-auth", `Bearer ${await tenantToken(tenantId)}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(`${preview.url}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    redirect: "manual",
    ...(hasBody && { duplex: "half" }),
  });

  const responseHeaders: Record<string, string | string[]> = {};
  upstream.headers.forEach((value, name) => {
    // fetch has already decompressed the body.
    if (hopByHop.has(name) || name === "content-encoding" || name === "set-cookie") return;
    responseHeaders[name] = name === "location" ? value.replace(preview.url, "") : value;
  });
  const setCookies = upstream.headers.getSetCookie();
  if (setCookies.length) responseHeaders["set-cookie"] = setCookies;
  // Every preview is served at the same address and the pr_preview cookie picks which one, so a
  // browser must not reuse one preview's cached response for another.
  responseHeaders.vary = [upstream.headers.get("vary"), "Cookie"].filter(Boolean).join(", ");
  res.writeHead(upstream.status, responseHeaders);
  if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
  else res.end();
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", publicUrl);
  const jar = cookies(req);
  const session = sessions.get(jar.pr_session ?? "");

  // The link posted on a pull request: /_pr-previews/open/<tenant>/<kind>/<id>
  if (url.pathname.startsWith("/_pr-previews/open/")) {
    const ref = url.pathname.slice("/_pr-previews/open/".length);
    if (!session) {
      const state = randomBytes(16).toString("hex");
      setCookie(res, "pr_state", state, 600);
      setCookie(res, "pr_return", url.pathname, 600);
      return redirect(res, authorizeUrl(callbackUrl, state));
    }
    if (!(await authorize(session, ref))) {
      return send(res, 403, `${session.login} can't see this preview, or it no longer exists.`);
    }
    // A preview is a whole site that expects to be served at /, so the cookie selects which one.
    setCookie(res, "pr_preview", ref);
    return redirect(res, "/");
  }

  if (url.pathname === "/_pr-previews/auth/callback") {
    const code = url.searchParams.get("code");
    if (!code || !jar.pr_state || url.searchParams.get("state") !== jar.pr_state) {
      return send(res, 400, "Sign-in expired. Open the preview link again.");
    }
    const token = await exchangeCode(code, callbackUrl);
    const id = randomBytes(24).toString("hex");
    sessions.set(id, { login: await githubLogin(token), token, allowed: new Map() });
    setCookie(res, "pr_session", id);
    setCookie(res, "pr_state", "", 0);
    return redirect(res, jar.pr_return?.startsWith("/_pr-previews/open/") ? jar.pr_return : "/");
  }

  if (!session || !jar.pr_preview) return send(res, 401, "Open a preview from the link on its pull request.");
  const preview = await authorize(session, jar.pr_preview);
  if (!preview) return send(res, 403, `${session.login} can't see this preview, or it no longer exists.`);
  await forward(req, res, preview, parsePreviewRef(jar.pr_preview)!.tenantId);
  console.log(`${session.login} ${jar.pr_preview} ${req.method} ${req.url} → ${res.statusCode}`);
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    // Not 502: Cloudflare replaces 502 responses with its own "Bad gateway" page.
    if (!res.headersSent) send(res, 500, `pr-previews error: ${error.message}`);
    else res.destroy();
  });
}).listen(port, () => {
  console.log(`pr-previews listening on http://localhost:${port}, public at ${publicUrl}`);
  console.log(`GitHub App callback URL must include ${callbackUrl}`);
});
