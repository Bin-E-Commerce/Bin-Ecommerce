# Auth Service - Social Authentication

## Source Files

- `services/auth-service/src/modules/auth/controllers/auth.controller.ts`
- `services/auth-service/src/modules/auth/services/auth.service.ts`
- `services/auth-service/src/modules/auth/services/token.service.ts`
- `services/auth-service/src/modules/auth/services/keycloak-admin.service.ts`
- `services/auth-service/src/modules/auth/dto/social-callback.dto.ts`

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/auth/social/start/:provider` | Generate Keycloak social authorization URL |
| `POST` | `/api/v1/auth/social/callback/:provider` | Exchange code, upsert/link local user, issue session |

Both routes are public at the API Gateway.

## Start Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller as AuthController
  participant Auth as AuthService

  Client->>Controller: GET /auth/social/start/google
  Controller->>Auth: getSocialAuthUrl("google")
  Auth->>Auth: randomUUID() for state
  Auth->>Auth: store { provider, expiresAt } in in-memory Map
  Auth->>Auth: delete expired states
  Auth-->>Controller: { authUrl, state }
  Controller-->>Client: Social auth URL
```

## Generated Auth URL

The URL is built from:

| Config | Use |
| --- | --- |
| `KEYCLOAK_URL` | Keycloak base |
| `KEYCLOAK_REALM` | Realm |
| `KEYCLOAK_WEB_CLIENT_ID` | OAuth client id, default `web-client` |
| `FRONTEND_URL` | Callback base, default `http://localhost:5173` |
| `provider` path param | `kc_idp_hint` |

Query params include:

- `client_id`
- `response_type=code`
- `scope=openid email profile`
- `redirect_uri=${FRONTEND_URL}/auth/callback`
- `state`
- `kc_idp_hint=${provider}`

## Callback Request

```json
{
  "code": "authorization-code-from-keycloak",
  "state": "state-returned-from-start"
}
```

Validation:

- `code` is required string.
- `state` is required string.

## Callback Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller
  participant Auth as AuthService
  participant Token as TokenService
  participant Keycloak
  participant DB as PostgreSQL

  Client->>Controller: POST /auth/social/callback/google
  Controller->>Auth: socialCallback(provider, dto, ip, userAgent)
  Auth->>Auth: read state from in-memory Map
  alt missing/provider mismatch/expired
    Auth-->>Controller: UnauthorizedException("Invalid or expired state parameter")
  else valid state
    Auth->>Auth: delete state
    Auth->>Token: exchangeCode(code, redirectUri)
    Token->>Keycloak: authorization_code grant
    Keycloak-->>Token: accessToken, refreshToken, idToken
    Auth->>Auth: decode id_token without verification
    Auth->>DB: find user by keycloakId
    alt not found by keycloakId
      Auth->>DB: find user by email
      alt existing local email
        Auth->>DB: update user.keycloakId
      else new social user
        Auth->>DB: create user CUSTOMER ACTIVE
        Auth->>Keycloak: assignRealmRole(CUSTOMER)
      end
    end
    Auth->>DB: ensure user status ACTIVE
    Auth->>DB: update lastLoginAt
    Auth->>DB: save refresh token hash
    Controller->>Controller: set refresh_token cookie
    Controller-->>Client: access token + safe user
  end
```

## Current Implementation Details

- State storage is an in-memory `Map`; restarting the service clears pending states.
- State expiry is 10 minutes.
- `id_token` is decoded with `jwt.decode()` because Keycloak has already returned it from the code exchange. The code does not perform separate signature verification at this step.
- If `email` is missing from the provider, the service returns `UnauthorizedException("Email not provided by identity provider")`.
- New social users receive role `CUSTOMER` and status `ACTIVE`.
- There is a TODO comment for publishing `user.registered` event, but it is not implemented in current code.
