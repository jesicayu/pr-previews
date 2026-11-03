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

## GitHub App

Customers connect their GitHub account or organization by installing the platform's GitHub App.
The app's webhooks go to a [smee.io](https://smee.io) channel, which relays them to the backend on
this machine.

```bash
npm run register-app -- <app-name>   # once: open http://localhost:4100 and create the app
```

The app's ID, private key, and webhook secret are saved outside the repository, in
`~/.pr-previews/`.

## Viewing previews

Previews are private: Namespace only admits tenant members, and tenants created by the partner
account have none. The server ([src/server.ts](src/server.ts)) lets people in instead. A preview's
link is `/_pr-previews/open/<tenant>/<instance|devbox>/<id>`. The viewer signs in with GitHub through
the GitHub App, the server checks that they can read the preview's repository, and then forwards
their requests to the private preview, adding the tenant token in `x-nsc-ingress-auth`.

Previews are found by their labels (`app=pr-previews`, `github.owner`, `github.repo`), and only in
tenants labelled `app=pr-previews` ([src/previews.ts](src/previews.ts)).

One-time setup: on the GitHub App's **Credentials** page, create a client secret and save it as
`clientSecret` in `~/.pr-previews/github-app.json`.

To run it, expose the server with a [Cloudflare quick tunnel](https://try.cloudflare.com) (no
account needed) and add the tunnel's callback URL to the GitHub App's redirect URIs:

```bash
cloudflared tunnel --url http://localhost:4200    # prints https://<random>.trycloudflare.com
PUBLIC_URL=https://<random>.trycloudflare.com npm start
# GitHub App → General → Redirect URI: https://<random>.trycloudflare.com/_pr-previews/auth/callback
```

A quick tunnel's address changes every time it starts, so the redirect URI has to be updated each
time. Sessions are kept in memory, so restarting the server signs everyone out.
