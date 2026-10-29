# OAuth for /mcp

Rumbo is a **resource server** only. A client that cannot send a static header (a ChatGPT custom connector) signs in at an authorization server and sends its access token to `/mcp`. Rumbo issues no tokens.

The owner key (D5) is unchanged and checked as before: `Authorization: Bearer <key>` and `/mcp/<key>`. The scheduled runs use it. OAuth adds a second way in; it removes nothing.

## Status

The shared authorization server is the accounts hub (`Fabrique-Futur/accounts`, `docs/MCP-OAUTH.md`). That contract was not merged on 2026-10-29. Rumbo is written against standards, so it works with any server that issues JWT access tokens and publishes RFC 8414 metadata and a JWKS. When the hub's contract lands, check three things against it: the `issuer`, the `aud` it puts in tokens, and whether tokens are JWTs (otherwise add a `TokenVerifier` that introspects; see `src/server/oauth.ts`).

## What the server does

| Request | Answer |
|---|---|
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata: `resource`, `authorization_servers`, `bearer_methods_supported`. Public, holds no secret. 404 while OAuth is off. |
| `POST /mcp` with no or a wrong credential | 401 with `WWW-Authenticate: Bearer realm="rumbo", resource_metadata="<site>/.well-known/oauth-protected-resource/mcp"`, so a client finds the authorization server. |
| `POST /mcp` with a JWT access token | Signature against the issuer's JWKS (RS256 or ES256 only), then `iss`, `aud`, `exp`, `nbf` and `sub`. Refusal: 401 `invalid_token` with the reason code. |

A JWT-shaped bearer (three dot-separated segments) goes to OAuth, unless it equals the owner key, which stays on the owner-key path. A bad token does not count toward the owner-key lockout: a JWT cannot be guessed, and a connector retrying an expired one must not lock out a shared address.

## One owner

A valid signature is not enough. The token's `sub` must equal `RUMBO_OAUTH_OWNER_SUB`. Any other account at the same authorization server gets 401 `not_owner`. OAuth stays off until the owner's `sub` is set.

## Configuration

| Variable | Meaning |
|---|---|
| `RUMBO_OAUTH_ISSUER` | The authorization server's issuer (`iss`). https, or localhost. Required to turn OAuth on. |
| `RUMBO_OAUTH_OWNER_SUB` | The owner's `sub`. Required. |
| `RUMBO_PUBLIC_URL` | Required: the resource URL is `<RUMBO_PUBLIC_URL>/mcp`. Never read from request headers. |
| `RUMBO_OAUTH_AUDIENCE` | Optional, comma-separated `aud` values. Default: the resource URL and the site root. |
| `RUMBO_OAUTH_JWKS_URL` | Optional. Default: `jwks_uri` from the RFC 8414 document (`<origin>/.well-known/oauth-authorization-server<issuer path>`), else `<issuer>/.well-known/openid-configuration`. |

Keys are cached for 10 minutes. Any fetch attempt, failed or not, starts a one-minute pause before the next, so junk tokens or an issuer outage cannot make Rumbo hammer the issuer. `iss` must match `RUMBO_OAUTH_ISSUER` exactly, trailing slash included.

## Find your `sub`

Sign in once at the authorization server, decode the access token's payload (`sub`), and put it in `RUMBO_OAUTH_OWNER_SUB`.

## Not done

- A live end-to-end run with ChatGPT or Claude custom connectors: it needs the authorization server to exist and, for ChatGPT, developer mode in the owner's account.
- Scopes: none are required. Add `scopes_supported` and a check if the hub defines one.
