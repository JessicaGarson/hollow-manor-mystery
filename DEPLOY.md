# Hosting Hollow Manor

How to put your own copy of the game on the public internet without running up a surprise bill.

## What protects you

- Your Runpod API key never reaches the browser.
- **Per-player rate limit** on questions, accusations, and Coroner jobs.
- **Daily budget** (UTC) across all players. Once it's spent, players see "the manor is closed for the night" until tomorrow.
- **Portraits are generated once** and cached, so the art costs seven images total no matter how many people visit.
- Player-facing errors are generic. Runpod error details go to the server log with a matching reference code.
- Request size limits, no directory listing, a `/healthz` endpoint, and basic security headers.

## Deploy

The repo includes a `Dockerfile`, so any host that builds one works (Render, Railway, Fly.io, a VM, or a Runpod CPU pod). On Render:

1. **New → Web Service** and connect your fork. Render detects the Dockerfile.
2. Add environment variables: `RUNPOD_API_KEY`, `DAILY_BUDGET_USD` (e.g. `5`), and `TRUST_PROXY=1`.
3. Keep it at **one instance** and deploy.

Or with Docker directly:

```bash
docker build -t hollow-manor .
docker run -p 8666:8666 -e RUNPOD_API_KEY=rpa_... -e DAILY_BUDGET_USD=5 hollow-manor
```

Serve it over HTTPS (most hosts do this for you). Set `TRUST_PROXY=1` only when a proxy or load balancer actually sets `X-Forwarded-For`. Otherwise players can spoof it to dodge the rate limit.

The guards are per process and in memory, so run a single instance. A restart resets the daily counters and the portrait cache.

**Use an API key you're willing to have spent up to the budget**, and set a spend limit on your Runpod account as an extra safeguard.

## Optional: the Coroner on his own Serverless endpoint

Without this, the Coroner uses the same public LLM as the suspects. With it, he "sleeps in the crypt" on a scale-to-zero endpoint, and players watch a GPU worker cold-start when they wake him.

1. In the Runpod console, deploy a vLLM Serverless endpoint with `Qwen/Qwen3-8B`, and set max workers ≥ 1 and active (min) workers to 0.
2. Set `RUNPOD_CORONER_ENDPOINT=<endpoint id>` and restart.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `RUNPOD_API_KEY` | (required) | Runpod API key with Public Endpoint access |
| `RUNPOD_CORONER_ENDPOINT` | (none) | Serverless endpoint ID for the Coroner |
| `RUNPOD_LLM_ENDPOINT` | `qwen3-32b-awq` | Public Endpoint for dialogue |
| `RUNPOD_IMAGE_ENDPOINT` | `black-forest-labs-flux-1-schnell` | Public Endpoint for images |
| `PORT` / `HOST` | `8666` / `0.0.0.0` | Where the server listens |
| `RATE_LIMIT_PER_MIN` | `10` | Questions per player per minute, sustained |
| `RATE_LIMIT_BURST` | `20` | Questions a player can ask back-to-back before the limit applies |
| `DAILY_BUDGET_USD` | `10` | Total reported spend per UTC day across all players (`0` = no cap) |
| `DAILY_MAX_JOBS` | `5000` | Total jobs per UTC day. This also caps the Coroner, whose cost isn't reported per job |
| `TRUST_PROXY` | off | Set to `1` to take the client IP from `X-Forwarded-For` |
| `DEBUG` | off | Set to `1` to show raw Runpod errors in the browser |
