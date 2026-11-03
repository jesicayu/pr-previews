# Findings: instances vs Devboxes in a partner tenant

Hands-on results from running both runtimes inside a customer's tenant, created with partner
credentials and accessed with a tenant token. Each section says when and how it was tested.

## 1. Both runtimes run in a customer's tenant (2026-11-02)

A tenant token for `tenant_s31fs8uii62oc` created an nginx instance (`createInstance`) and a small
Linux Devbox (`createDevboxClient`, `builtin:default`, size `s`, ephemeral) that ran
`python3 -m http.server 3000` as a service with port 3000 exposed.

| | Instance | Devbox |
|---|---|---|
| Created with a tenant token | Yes, ready in 3.6 s | Yes, created in 0.6 s, commands ran after about 3 s |
| Where the server came from | An image (`nginx`), declared in `createInstance` | A command run as a `service` on the Devbox |
| Machine | The exact shape requested (2 vCPU, 4 GB) | Size `s`: 4 vCPU, 8 GB |
| Preview URL | `http-<instance>.iad3-a.namespaced.app` | `dbx<devbox>-p3000.devbox.so` |

- The Platform docs list Compute, Builds, Registry, Vault, and IAM as what a tenant token can use,
  but not Devboxes. Devboxes work with a tenant token anyway.
- A Devbox runs on an instance: its backing instance appears in the tenant's `listInstances`,
  labelled `devbox.id=<devbox>` and `nsc.purpose=devbox`.
- A Devbox created by the platform has the partner ID as its `creator`, so the platform, not the
  customer, is its owner.
- `exposedPorts.create` failed on the client with `Premature close` although the port was created;
  retrying failed with `already_exists`. Look up existing ports (`exposedPorts.list`) before creating
  one.

## 2. Private previews: who can open them (2026-11-02)

Both URLs were requested with no credentials, with `x-nsc-ingress-auth: Bearer <tenant token>`, and
with `Authorization: Bearer <tenant token>`, then opened in a browser by a logged-in Namespace user.

| Request | Instance | Devbox |
|---|---|---|
| No credentials, from code | 401 | 401 |
| `x-nsc-ingress-auth: Bearer <tenant token>` | 200 | 200 |
| `Authorization: Bearer <tenant token>` | 401 (ignored) | 401 (ignored) |
| Browser, not logged in | Redirect to Namespace login for this tenant | Same |
| Browser, logged in to Namespace (member of another workspace) | Permission denied | Permission denied |

- The tenant token itself is the ingress key for both runtimes; no separate ingress token is
  needed. The platform can check any preview with the token it already uses.
- Private previews admit only members of the tenant that owns them. Tenants created by a partner
  have no members, and the SDK has no call to add any (the membership service only lists members).
  So in a customer's tenant, private previews are reachable only from code that holds a tenant
  token.
- To let people view previews, the options are public routes (instances: `httpMatchRule` with
  `doesNotRequireAuth`; Devbox URLs document only `private` and `workspace` access) or a proxy in the
  platform that checks the viewer's GitHub access and adds the token. We built the proxy (section 3).

## 3. Viewing previews through the platform (2026-11-03)

The platform's server, behind a Cloudflare quick tunnel, signed a viewer in with GitHub, checked
they could read the repository, and forwarded to an nginx instance and to a Devbox in the customer's
tenant. Both loaded in the browser of a viewer with no access to the tenant.

- The same proxy works for both runtimes: both accept the tenant token in `x-nsc-ingress-auth`.
- Devboxes stop when idle. A stopped Devbox started in about 4 seconds and its service restarted on
  its own, but files outside `/workspaces` were gone: a page served from `/tmp` returned 404 after
  the restart. Checkouts and build output must live under `/workspaces`.
- Waking a stopped Devbox implicitly, through `exposedPorts.list`, hung for over three minutes in
  one attempt; an explicit `devbox.start()` worked. The proxy starts stopped Devboxes explicitly.
- `exposedPorts.list` failed once with `Premature close` right after a Devbox was created, then
  worked on retry.
- Serving every preview from one address and choosing it by cookie needs `Vary: Cookie`. nginx sends
  `Last-Modified` without `Cache-Control`, so a browser reused one preview's cached page for
  another until the proxy added it.
- A quick tunnel's address changes on every start, and GitHub only redirects sign-ins to registered
  URIs, so each restart means updating the GitHub App's redirect URI.

## 4. Deploying tendu with each runtime (2026-11-03)

The platform deployed tendu (`main` at `9e2a572`) in the `jesicayu` tenant with each runtime, using
the GitHub App's installation token to fetch the code.

| | Instance | Devbox |
|---|---|---|
| Build | `nsc build --push` on the remote builder: 62 s cold, 6 s with the builder's cache | `npm ci && npm run db:setup && npm run build` on the Devbox: 51 s first time, 29 s on a later push |
| Start to a working URL | 6.5 s (instance created, image pulled, app answering) | 3 s (service restarted) |
| Total, first deploy | about 70 s cold, 12 s warm | 61 s (checkout 7 s) |
| Total, a later push | a new instance each time: same as above | 33 s, same Devbox |

- `nsc build` acts as the tenant when `NSC_TOKEN_FILE` points to a file holding a tenant token. The
  image goes to the tenant's registry (`nscr.io/<tenant registry>/…`), and the tenant's instances
  pull it with no extra credentials. Keep the token file outside the build context.
- `nsc build --file` with an absolute path failed on the remote builder; run it from the source
  folder with a relative path.
- A reused Devbox keeps ignored files between pushes. tendu's SQLite database (`data/tendu.db`)
  survived, and `npm run db:setup` failed the second time (`index steps_slug_unique already
  exists`) because it is not safe to run twice. The fix is in the customer's build command
  (`rm -rf data && …`), not the platform. This is the cost of reuse: faster rebuilds, but leftover
  state that a fresh instance never has.
