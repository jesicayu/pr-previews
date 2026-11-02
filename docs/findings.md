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
  platform that checks the viewer's GitHub access and adds the token. Neither is built yet.
