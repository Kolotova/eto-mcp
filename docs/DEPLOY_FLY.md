# Fly.io Deploy Guide (Triply MCP)

## Prerequisites
- Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
- Ensure `API_KEY`, `DATA_PROVIDER`, `LLM_PROVIDER`, `GROQ_API_KEY`, `BOT_TOKEN` are available.

## Steps
1) Login
```bash
flyctl auth login
```

2) Initialize app (no deploy yet)
```bash
flyctl launch --no-deploy
```

3) Set secrets
```bash
flyctl secrets set API_KEY=... DATA_PROVIDER=mock LLM_PROVIDER=groq GROQ_API_KEY=... BOT_TOKEN=...
```

4) Deploy
```bash
flyctl deploy
```

5) Health check
```bash
curl -s https://<your-app>.fly.dev/health
```
Expected:
```json
{"status":"ok"}
```

## Troubleshooting
- App not listening:
  - Ensure `host` is `0.0.0.0` in the server listener.
- Port mismatch:
  - Check `fly.toml` `internal_port` matches the app port (3000).
- Crashes on boot:
  - Check logs: `flyctl logs`.

## Pre-deploy Checklist
- `PORT` is taken from env (no hardcoded port)
- Server binds on `0.0.0.0`
- No `localhost` hardcoding in runtime config
- No secrets logged to console
- `/health` returns `{ "status": "ok" }`
- LLM fallback is safe if keys are missing
