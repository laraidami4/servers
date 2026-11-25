# apple-music-catalog

Server-side Express proxy for the Song Tournament's Apple Music catalogue
requests.

> **Do not commit the `.p8` file.** Add `AuthKey_*.p8` to `.gitignore` (or keep
> the key outside the repo) and set `APPLE_PRIVATE_KEY` from your platform's
> secret store in production. The key in this directory exists only for local
> development.

## Required environment variables

- `APPLE_TEAM_ID` — Apple Developer Team ID
- `APPLE_KEY_ID` — Apple Music key ID
- `APPLE_PRIVATE_KEY_FILE` — absolute or relative path to the `.p8` private key

`APPLE_PRIVATE_KEY` can be used instead of a key file. Keep the private key out
of browser code and source control.

Local defaults include `QN6DJ39GCZ`, `FM4R5UXR97`, and
`AuthKey_FM4R5UXR97.p8` in this directory.

## Run locally

```bash
cd spotify-proxy
npm install
npm start
```

The health endpoint is `http://localhost:3000/health`.
