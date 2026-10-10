# 🕯️ Murder at Hollow Manor

A Halloween murder mystery where every suspect is a live LLM and every portrait is painted on demand, all served by **Runpod**.

Halloween night, 1926. Lord Silas Hollow is found poisoned in his library during a masquerade ball. Interrogate five suspects, consult the Coroner about the evidence, catch the liars, and make one accusation. Get it wrong and the killer escapes into the storm.

> Stuck, or presenting it live? The solution and a 5-minute walkthrough are in [SPOILERS.md](SPOILERS.md).

## How it works

| What | Runs on |
| --- | --- |
| Suspect dialogue + final reveal | Runpod Public Endpoint `qwen3-32b-awq` (Qwen3 32B AWQ) |
| Crime scene + portraits | Runpod Public Endpoint `black-forest-labs-flux-1-schnell` (FLUX.1 Schnell) |
| The Coroner (optional) | Your own Runpod Serverless endpoint that scales to zero |

Public Endpoints mean there's nothing to deploy and no GPUs to manage. You pay per request: about $0.003 per portrait and under $0.01 per question, so a full game costs a few cents. Open the **⚡ Inference Log** in the game to see every job's latency, GPU worker, and cost.

The suspects' secrets and the solution live only on the server (`case.py`), so nobody can solve the case from devtools.

## Run it locally

Python 3.9+ with the standard library only. There's nothing to install.

```bash
export RUNPOD_API_KEY=rpa_...      # needs access to Public Endpoints (not an endpoint-restricted key)
python3 server.py
open http://localhost:8666
```

### Optional: put the Coroner on your own Serverless endpoint

Without this, the Coroner uses the same public LLM as the suspects. With it, he "sleeps in the crypt" on a scale-to-zero endpoint, and players watch the GPU worker cold-start when they wake him.

1. In the Runpod console, deploy a vLLM Serverless endpoint with `Qwen/Qwen3-8B`, and set max workers ≥ 1 and active (min) workers to 0.
2. `export RUNPOD_CORONER_ENDPOINT=<endpoint id>` and restart the server.

## Host it publicly

The server is built to sit on the open internet. The API key never reaches the browser, and spending is capped:

- **Per-player rate limit** on questions, accusations, and Coroner jobs.
- **Daily budget** (UTC) across all players. Once it's spent, players see "the manor is closed for the night" until tomorrow.
- **Portraits are generated once** and cached, so the art costs seven images total no matter how many people visit.
- Player-facing errors are generic. Runpod error details go to the server log with a matching reference code.
- Request size limits, no directory listing, a `/healthz` endpoint, and basic security headers.

Deploy with Docker on any host (Fly.io, Render, Railway, a VM, or a Runpod CPU pod):

```bash
docker build -t hollow-manor .
docker run -p 8666:8666 -e RUNPOD_API_KEY=rpa_... -e DAILY_BUDGET_USD=5 hollow-manor
```

Put it behind HTTPS (most hosts do this for you). If a proxy or load balancer sits in front, set `TRUST_PROXY=1` so rate limits apply per player instead of per proxy. Only do this when a proxy actually sets `X-Forwarded-For`, because otherwise players can spoof it.

The guards are per process and in memory, so run a single instance. A restart resets the daily counters and the portrait cache.

**Use an API key you're willing to have spent up to the budget.** As an extra backstop, set a spend limit on your Runpod account.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `RUNPOD_API_KEY` | (required) | Runpod API key with Public Endpoint access |
| `RUNPOD_CORONER_ENDPOINT` | (none) | Your Serverless endpoint ID for the Coroner |
| `RUNPOD_LLM_ENDPOINT` | `qwen3-32b-awq` | Public Endpoint for dialogue |
| `RUNPOD_IMAGE_ENDPOINT` | `black-forest-labs-flux-1-schnell` | Public Endpoint for images |
| `PORT` / `HOST` | `8666` / `0.0.0.0` | Where the server listens |
| `RATE_LIMIT_PER_MIN` | `10` | Questions per player per minute, sustained |
| `RATE_LIMIT_BURST` | `20` | Questions a player can ask back-to-back before the limit applies |
| `DAILY_BUDGET_USD` | `10` | Total reported spend per UTC day across all players (`0` = no cap) |
| `DAILY_MAX_JOBS` | `5000` | Total jobs per UTC day. This also caps the Coroner, whose cost isn't reported per job |
| `TRUST_PROXY` | off | Set to `1` to take the client IP from `X-Forwarded-For` |
| `DEBUG` | off | Set to `1` to show raw Runpod errors in the browser |

## Files

- `server.py`: small HTTP server that calls Runpod `/runsync` (falling back to polling `/status`), plus the public-hosting guards
- `case.py`: the mystery itself: setting, suspect personas, solution, image prompts (spoilers!)
- `static/`: the spooky single-page UI
- `Dockerfile`: container for public hosting
