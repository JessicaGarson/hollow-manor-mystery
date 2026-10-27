"""Murder at Hollow Manor: a Halloween murder mystery running on Runpod Public Endpoints.

Standard library only, so it runs anywhere with Python 3.9+:

    export RUNPOD_API_KEY=rpa_...
    export RUNPOD_CORONER_ENDPOINT=<your serverless endpoint id>   # optional, see README
    python3 server.py
    open http://localhost:8666

Safe to put on the public internet: your API key never leaves the server, every player is
rate limited, and a daily budget stops all inference once it's spent. See README for the knobs.
"""

import json
import os
import secrets
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import case

API_ROOT = "https://api.runpod.ai/v2"
LLM_ENDPOINT = os.environ.get("RUNPOD_LLM_ENDPOINT", "qwen3-32b-awq")
IMAGE_ENDPOINT = os.environ.get("RUNPOD_IMAGE_ENDPOINT", "black-forest-labs-flux-1-schnell")
# Your own Serverless endpoint (vLLM worker). Without it, the Coroner falls back to the public LLM.
CORONER_ENDPOINT = os.environ.get("RUNPOD_CORONER_ENDPOINT", "")
PORT = int(os.environ.get("PORT", "8666"))
HOST = os.environ.get("HOST", "0.0.0.0")
STATIC_DIR = Path(__file__).parent / "static"

# Public-hosting guards. The defaults are roomy enough that a local game never notices them.
RATE_LIMIT_PER_MIN = float(os.environ.get("RATE_LIMIT_PER_MIN", "10"))  # questions per player per minute
RATE_LIMIT_BURST = int(os.environ.get("RATE_LIMIT_BURST", "20"))
DAILY_BUDGET_USD = float(os.environ.get("DAILY_BUDGET_USD", "10"))  # 0 disables the cap
DAILY_MAX_JOBS = int(os.environ.get("DAILY_MAX_JOBS", "5000"))  # covers jobs that don't report a cost
TRUST_PROXY = os.environ.get("TRUST_PROXY", "") == "1"  # read the client IP from X-Forwarded-For
DEBUG = os.environ.get("DEBUG", "") == "1"  # show raw Runpod errors to players
MAX_BODY_BYTES = 32 * 1024

# Portraits are cached so a room full of players doesn't regenerate the same seven images.
_image_cache = {}
_image_locks = {}
_image_lock = threading.Lock()


class RunpodError(Exception):
    pass


class Closed(Exception):
    """A guard said no. The message is shown to the player as-is."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class RateLimiter:
    """Token bucket per client IP."""

    def __init__(self, per_min, burst):
        self.rate = per_min / 60
        self.burst = burst
        self.buckets = {}
        self.lock = threading.Lock()

    def take(self, key):
        now = time.time()
        with self.lock:
            if len(self.buckets) > 10000:  # forget players who left
                self.buckets = {k: v for k, v in self.buckets.items() if now - v[1] < 600}
            tokens, last = self.buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens < 1:
                self.buckets[key] = (tokens, now)
                return False
            self.buckets[key] = (tokens - 1, now)
            return True


class Budget:
    """Daily (UTC) cap on spend and job count across all players."""

    def __init__(self, usd, jobs):
        self.usd, self.jobs = usd, jobs
        self.day, self.spent, self.count = None, 0.0, 0
        self.lock = threading.Lock()

    def _roll(self):
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if today != self.day:
            self.day, self.spent, self.count = today, 0.0, 0

    def check(self):
        with self.lock:
            self._roll()
            if (self.usd and self.spent >= self.usd) or (self.jobs and self.count >= self.jobs):
                raise Closed(503, "The manor is closed for the night. Tonight's investigations are all used up. Come back tomorrow.")
            self.count += 1

    def charge(self, cost):
        with self.lock:
            self._roll()
            self.spent += cost or 0

    def snapshot(self):
        with self.lock:
            self._roll()
            return {"day": self.day, "spentUsd": round(self.spent, 4), "jobs": self.count}


limiter = RateLimiter(RATE_LIMIT_PER_MIN, RATE_LIMIT_BURST)
budget = Budget(DAILY_BUDGET_USD, DAILY_MAX_JOBS)

# Only jobs this server submitted can be polled, so the status route isn't an open proxy.
_jobs = {}  # job id -> (endpoint id, submitted at)
_jobs_lock = threading.Lock()
_health_cache = {"at": 0, "value": None}


def _request(method, url, body=None, timeout=120):
    api_key = os.environ.get("RUNPOD_API_KEY")
    if not api_key:
        raise RunpodError("RUNPOD_API_KEY is not set. Export it and restart the server.")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RunpodError(f"Runpod returned HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
    except urllib.error.URLError as e:
        raise RunpodError(f"Could not reach Runpod: {e.reason}")


def run_job(endpoint_id, payload, deadline_s=180):
    """Submit with /runsync; if the job outlives the sync window, poll /status until it finishes."""
    budget.check()
    started = time.time()
    job = _request("POST", f"{API_ROOT}/{endpoint_id}/runsync", {"input": payload})
    while job.get("status") in ("IN_QUEUE", "IN_PROGRESS"):
        if time.time() - started > deadline_s:
            raise RunpodError(f"Job {job.get('id')} still {job.get('status')} after {deadline_s}s")
        time.sleep(1.5)
        job = _request("GET", f"{API_ROOT}/{endpoint_id}/status/{job['id']}")
    if job.get("status") != "COMPLETED":
        raise RunpodError(f"Job {job.get('id')} ended {job.get('status')}: {job.get('error')}")

    stats = job_stats(endpoint_id, job, started)
    budget.charge(stats["cost"])
    return job.get("output"), stats


def job_stats(endpoint_id, job, started=None):
    output = job.get("output")
    cost = None
    if isinstance(output, list) and output and isinstance(output[0], dict):
        cost = output[0].get("cost")
    elif isinstance(output, dict):
        cost = output.get("cost")
    stats = {
        "endpoint": endpoint_id,
        "jobId": job.get("id"),
        "workerId": job.get("workerId"),
        "delayMs": job.get("delayTime"),
        "executionMs": job.get("executionTime"),
        "roundTripMs": int((time.time() - started) * 1000) if started else None,
        "cost": cost,
    }
    return stats


def chat(messages, max_tokens=300, temperature=0.8):
    output, stats = run_job(LLM_ENDPOINT, chat_input(messages, max_tokens, temperature))
    return chat_text(output), stats


def chat_input(messages, max_tokens=300, temperature=0.8):
    # Sampling options must be nested; top-level max_tokens is silently ignored (replies cap at 100 tokens).
    return {"messages": messages, "sampling_params": {"max_tokens": max_tokens, "temperature": temperature}}


def chat_text(output):
    # Public Endpoints return {"tokens": [...]}; worker-vllm (RAW_OPENAI_OUTPUT) returns an OpenAI message.
    try:
        choice = output[0]["choices"][0]
        text = choice["message"]["content"] if "message" in choice else "".join(choice["tokens"])
    except (KeyError, IndexError, TypeError):
        raise RunpodError(f"Unexpected LLM output shape: {str(output)[:300]}")
    # Qwen3 emits an (empty, with /no_think) reasoning block before the answer.
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def image(prompt, cache_key):
    with _image_lock:
        if cache_key in _image_cache:
            return _image_cache[cache_key], None
        key_lock = _image_locks.setdefault(cache_key, threading.Lock())
    # One generation per image even if a crowd arrives at once; latecomers wait and get the cached URL.
    with key_lock:
        if cache_key in _image_cache:
            return _image_cache[cache_key], None
        output, stats = run_job(
            IMAGE_ENDPOINT,
            {"prompt": prompt, "width": 768, "height": 768, "num_inference_steps": 4, "seed": 1031},
        )
        url = output.get("result") if isinstance(output, dict) else None
        if not url:
            raise RunpodError(f"Unexpected image output shape: {str(output)[:300]}")
        with _image_lock:
            _image_cache[cache_key] = url
        return url, stats


# ---- game logic ----------------------------------------------------------------


def public_case():
    return {
        "setting": case.SETTING,
        "models": {"llm": LLM_ENDPOINT, "image": IMAGE_ENDPOINT, "coroner": CORONER_ENDPOINT or LLM_ENDPOINT},
        "coroner": {
            k: case.CORONER[k] for k in ("id", "name", "title", "costume", "public")
        },
        "serverless": bool(CORONER_ENDPOINT),
        "suspects": [
            {"id": sid, "name": s["name"], "title": s["title"], "costume": s["costume"], "public": s["public"]}
            for sid, s in case.SUSPECTS.items()
        ],
    }


def interrogate(body):
    suspect = case.SUSPECTS.get(body.get("suspect"))
    messages = build_messages(suspect, body)
    if not messages:
        return 400, {"error": "Need a valid suspect and a question."}
    answer, stats = chat(messages)
    return 200, {"answer": answer, "stats": stats}


def build_messages(character, body):
    question = body.get("question")
    question = question.strip()[:500] if isinstance(question, str) else ""
    if not character or not question:
        return None
    system = "/no_think\n" + case.INTERROGATION_RULES.format(
        setting=case.SETTING, timeline=case.TIMELINE, persona=character["persona"]
    )
    messages = [{"role": "system", "content": system}]
    # Keep the last few exchanges so suspects remember what they've already said (or lied about).
    history = body.get("history")
    for turn in (history if isinstance(history, list) else [])[-12:]:
        if isinstance(turn, dict) and turn.get("role") in ("user", "assistant") and isinstance(turn.get("content"), str):
            messages.append({"role": turn["role"], "content": turn["content"][:1000]})
    messages.append({"role": "user", "content": question})
    return messages


def accuse(body):
    sid = body.get("suspect")
    suspect = case.SUSPECTS.get(sid)
    if not suspect:
        return 400, {"error": "Accuse a valid suspect."}
    reasoning = body.get("reasoning")
    reasoning = (reasoning if isinstance(reasoning, str) else "").strip()[:800] or "(the detective gave no reasoning)"
    correct = sid == case.KILLER

    if correct:
        guidance = (
            "The detective is RIGHT. Have the detective lay out the evidence, then have Rosalind's mask slip, "
            "literally and figuratively, as she gives a chilling, defiant confession. Mention which parts of the "
            "detective's reasoning were spot-on and gently note any key clue they missed."
        )
    else:
        guidance = (
            f"The detective is WRONG. {suspect['name']} is innocent and indignantly reveals their own petty secret instead. "
            "In the confusion, a figure in a black raven mask slips out into the storm and escapes. "
            "End with a haunting hint that the true killer wore feathers, without naming them outright."
        )
    prompt = case.REVEAL_PROMPT.format(
        solution=case.SOLUTION,
        accused=suspect["name"],
        reasoning=reasoning.replace('"', "'"),
        verdict="CORRECT" if correct else "WRONG",
        guidance=guidance,
    )
    # The verdict is instant; the story can take a minute, so the browser polls for it.
    messages = [{"role": "user", "content": "/no_think\n" + prompt}]
    job_id = submit_job(LLM_ENDPOINT, chat_input(messages, max_tokens=600, temperature=0.9))
    return 200, {"correct": correct, "killer": case.SUSPECTS[case.KILLER]["name"], "jobId": job_id}


def portrait(body):
    key = body.get("id")
    if key == "scene":
        prompt = case.SCENE_PROMPT
    elif key in case.SUSPECTS:
        prompt = case.SUSPECTS[key]["portrait_prompt"]
    elif key == "coroner":
        prompt = case.CORONER["portrait_prompt"]
    else:
        return 400, {"error": "Unknown image id."}
    url, stats = image(prompt, key)
    return 200, {"url": url, "stats": stats, "cached": stats is None}


# ---- the Coroner: a scale-to-zero Runpod Serverless endpoint ----------------------
# Async on purpose: a cold start (worker boots, vLLM loads Qwen3-8B) takes minutes, longer than
# /runsync holds. The browser polls job status and worker health so players can watch him rise.


def coroner_endpoint():
    return CORONER_ENDPOINT or LLM_ENDPOINT


def coroner_ask(body):
    if body.get("warmup"):
        messages = [{"role": "user", "content": "/no_think\nSay only: I have risen."}]
        payload = chat_input(messages, max_tokens=10)
    else:
        messages = build_messages(case.CORONER, body)
        if not messages:
            return 400, {"error": "Ask the coroner a question."}
        payload = chat_input(messages)
    return 200, {"jobId": submit_job(coroner_endpoint(), payload)}


def submit_job(endpoint_id, payload):
    budget.check()
    job = _request("POST", f"{API_ROOT}/{endpoint_id}/run", {"input": payload})
    if not job.get("id"):
        raise RunpodError(f"No job id from /run: {str(job)[:300]}")
    now = time.time()
    with _jobs_lock:
        for jid, (_, at) in list(_jobs.items()):
            if now - at > 3600:
                del _jobs[jid]
        _jobs[job["id"]] = (endpoint_id, now)
    return job["id"]


def job_status(job_id):
    with _jobs_lock:
        entry = _jobs.get(job_id)
    if not entry:
        return 404, {"error": "No such job."}
    endpoint_id = entry[0]
    job = _request("GET", f"{API_ROOT}/{endpoint_id}/status/{job_id}")
    status = job.get("status")
    result = {"status": status}
    if status == "COMPLETED":
        with _jobs_lock:
            if _jobs.pop(job_id, None) is None:
                return 404, {"error": "No such job."}  # another poll already collected (and charged) it
        result["answer"] = chat_text(job.get("output"))
        result["stats"] = job_stats(endpoint_id, job)
        budget.charge(result["stats"]["cost"])
    elif status in ("FAILED", "CANCELLED", "TIMED_OUT"):
        result["error"] = str(job.get("error") or status)
    return 200, result


def coroner_health():
    if not CORONER_ENDPOINT:
        return 200, {"serverless": False}
    # Every open tab polls this; share one Runpod call across all of them.
    if time.time() - _health_cache["at"] > 4:
        health = _request("GET", f"{API_ROOT}/{CORONER_ENDPOINT}/health", timeout=15)
        _health_cache.update(at=time.time(), value=health)
    return 200, {"serverless": True, "endpoint": CORONER_ENDPOINT, **_health_cache["value"]}


# Routes that spend money count against the player's rate limit. Portraits don't: the prompts are
# fixed and cached, so the whole manor costs seven images no matter how many people visit.
ROUTES = {
    "/api/interrogate": (interrogate, True),
    "/api/accuse": (accuse, True),
    "/api/image": (portrait, False),
    "/api/coroner": (coroner_ask, True),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For") if TRUST_PROXY else None
        return forwarded.split(",")[0].strip() if forwarded else self.client_address[0]

    def _send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _guarded(self, fn):
        """Run a route, turning failures into player-friendly JSON. Details stay in the server log."""
        try:
            return self._send_json(*fn())
        except Closed as e:
            return self._send_json(e.status, {"error": str(e)})
        except RunpodError as e:
            ref = secrets.token_hex(3)
            self.log_error("Runpod error [%s]: %s", ref, e)
            msg = str(e) if DEBUG else f"The spirits aren't answering right now. Try again in a moment. (ref {ref})"
            return self._send_json(502, {"error": msg})
        except (ValueError, TypeError, AttributeError) as e:
            return self._send_json(400, {"error": f"Bad request: {e}" if DEBUG else "Bad request."})
        except Exception as e:  # noqa: BLE001 - never leak a traceback to a player
            ref = secrets.token_hex(3)
            self.log_error("Unhandled error [%s]: %r", ref, e)
            return self._send_json(500, {"error": f"Something went bump in the night. (ref {ref})"})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._send_json(200, {"ok": True, "budget": budget.snapshot()})
        if path == "/api/case":
            return self._send_json(200, public_case())
        if path == "/api/coroner/health":
            return self._guarded(coroner_health)
        if path.startswith(("/api/coroner/status/", "/api/accuse/status/")):
            job_id = path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job_id):
                return self._send_json(400, {"error": "Bad job id"})
            return self._guarded(lambda: job_status(job_id))
        if path.startswith("/api/"):
            return self._send_json(404, {"error": "Not found"})
        return super().do_GET()

    def do_POST(self):
        route = ROUTES.get(self.path)
        if not route:
            return self._send_json(404, {"error": "Not found"})
        handler, limited = route

        def run():
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                raise Closed(413, "That's a long speech, detective. Keep it shorter.")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("expected a JSON object")
            if limited and not limiter.take(self.client_ip()):
                raise Closed(429, "Slow down, detective. The suspects need a moment to collect themselves. Try again in a few seconds.")
            return handler(body)

        self._guarded(run)

    def log_request(self, code="-", size="-"):
        # Access log for API calls only; static files are noise. Errors always go through log_error.
        if "/api/" in self.path:
            super().log_request(code, size)


if __name__ == "__main__":
    if not os.environ.get("RUNPOD_API_KEY"):
        print("⚠️  RUNPOD_API_KEY is not set; the manor will stay dark until you export it.")
    print(f"🕯️  Murder at Hollow Manor is open at http://localhost:{PORT}")
    print(f"    LLM: {LLM_ENDPOINT}   Images: {IMAGE_ENDPOINT}")
    if CORONER_ENDPOINT:
        print(f"    Coroner (Serverless endpoint): {CORONER_ENDPOINT}")
    else:
        print("    Coroner: no RUNPOD_CORONER_ENDPOINT set, falling back to the public LLM")
    cap = f"${DAILY_BUDGET_USD:g}/day" if DAILY_BUDGET_USD else "no $ cap"
    print(f"    Guards: {RATE_LIMIT_PER_MIN:g} questions/min per player (burst {RATE_LIMIT_BURST}), {cap}, {DAILY_MAX_JOBS} jobs/day")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
