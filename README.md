# pr-previews

A multi-tenant platform that gives every pull request its own private, self-expiring preview
environment on [Namespace](https://namespace.so/docs/platform). Each customer gets a Namespace
tenant, and each preview runs on either a Namespace instance or a Devbox.

Its first customer is [tendu](https://github.com/jesicayu/namespace-onboard-project-01).

## Development

Requires Node.js 24 or later, which runs the TypeScript sources directly, and the `nsc` CLI.

```bash
npm install
nsc login            # pick the workspace the service acts in
npm run check-auth   # one read-only call to Namespace
npm run typecheck
```

## Authentication

### Partner credentials: managing customers' tenants

[src/partner.ts](src/partner.ts) signs partner tokens with the platform's ES256 key and creates
the partner client. Its configuration is kept outside the repository, in
`~/.namespace-partner/partner.json` (or the file `PARTNER_CONFIG` names):

```json
{
  "partnerId": "user_…",
  "issuer": "https://…",
  "keyId": "…",
  "privateKeyPath": "~/.namespace-partner/private_key.pem"
}
```

Each customer is a GitHub account or organization and gets one tenant, keyed by the account's
numeric ID (`pr-previews:github:<id>`) and labelled `app=pr-previews`.

```bash
npm run check-partner                 # list the partner account's tenants (read-only)
npm run ensure-tenant -- <github-login>  # create or find that account's tenant, then call inside it
```

### Your own workspace: development without tenants

For work in your own workspace, the service chooses its Namespace credential from the environment
([src/namespace.ts](src/namespace.ts)):

- `NAMESPACE_TOKEN` set: uses that token, such as one from `nsc auth generate-dev-token`. Works on
  any machine, but development tokens expire after about an hour and are not renewed.
- Otherwise: uses this machine's `nsc login`, which the SDK renews automatically.
