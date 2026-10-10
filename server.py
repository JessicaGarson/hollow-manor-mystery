"""Murder at Hollow Manor: a Halloween murder mystery running on Runpod Public Endpoints.

Standard library only, so it runs anywhere with Python 3.9+:

    export RUNPOD_API_KEY=rpa_...
    python3 server.py
    open http://localhost:8666
"""

import json
import os
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
PORT = int(os.environ.get("PORT", "8666"))
STATIC_DIR = Path(__file__).parent / "static"

# Portraits are cached so a room full of players doesn't regenerate the same six images.
_image_cache = {}
_image_lock = threading.Lock()


class RunpodError(Exception):
    pass


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
    started = time.time()
    job = _request("POST", f"{API_ROOT}/{endpoint_id}/runsync", {"input": payload})
    while job.get("status") in ("IN_QUEUE", "IN_PROGRESS"):
        if time.time() - started > deadline_s:
            raise RunpodError(f"Job {job.get('id')} still {job.get('status')} after {deadline_s}s")
        time.sleep(1.5)
        job = _request("GET", f"{API_ROOT}/{endpoint_id}/status/{job['id']}")
    if job.get("status") != "COMPLETED":
        raise RunpodError(f"Job {job.get('id')} ended {job.get('status')}: {job.get('error')}")

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
        "roundTripMs": int((time.time() - started) * 1000),
        "cost": cost,
    }
    return output, stats


def chat(messages, max_tokens=300, temperature=0.8):
    output, stats = run_job(
        LLM_ENDPOINT,
        {"messages": messages, "max_tokens": max_tokens, "temperature": temperature},
    )
    try:
        text = "".join(output[0]["choices"][0]["tokens"])
    except (KeyError, IndexError, TypeError):
        raise RunpodError(f"Unexpected LLM output shape: {str(output)[:300]}")
    # Qwen3 emits an (empty, with /no_think) reasoning block before the answer.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    return text, stats


def image(prompt, cache_key):
    with _image_lock:
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
        "models": {"llm": LLM_ENDPOINT, "image": IMAGE_ENDPOINT},
        "suspects": [
            {"id": sid, "name": s["name"], "title": s["title"], "costume": s["costume"], "public": s["public"]}
            for sid, s in case.SUSPECTS.items()
        ],
    }


def interrogate(body):
    suspect = case.SUSPECTS.get(body.get("suspect"))
    question = (body.get("question") or "").strip()[:500]
    if not suspect or not question:
        return 400, {"error": "Need a valid suspect and a question."}

    system = "/no_think\n" + case.INTERROGATION_RULES.format(
        setting=case.SETTING, timeline=case.TIMELINE, persona=suspect["persona"]
    )
    messages = [{"role": "system", "content": system}]
    # Keep the last few exchanges so suspects remember what they've already said (or lied about).
    for turn in (body.get("history") or [])[-12:]:
        if turn.get("role") in ("user", "assistant") and isinstance(turn.get("content"), str):
            messages.append({"role": turn["role"], "content": turn["content"][:1000]})
    messages.append({"role": "user", "content": question})

    answer, stats = chat(messages)
    return 200, {"answer": answer, "stats": stats}


def accuse(body):
    sid = body.get("suspect")
    suspect = case.SUSPECTS.get(sid)
    if not suspect:
        return 400, {"error": "Accuse a valid suspect."}
    reasoning = (body.get("reasoning") or "").strip()[:800] or "(the detective gave no reasoning)"
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
    story, stats = chat([{"role": "user", "content": "/no_think\n" + prompt}], max_tokens=600, temperature=0.9)
    return 200, {"correct": correct, "story": story, "killer": case.SUSPECTS[case.KILLER]["name"], "stats": stats}


def portrait(body):
    key = body.get("id")
    if key == "scene":
        prompt = case.SCENE_PROMPT
    elif key in case.SUSPECTS:
        prompt = case.SUSPECTS[key]["portrait_prompt"]
    else:
        return 400, {"error": "Unknown image id."}
    url, stats = image(prompt, key)
    return 200, {"url": url, "stats": stats, "cached": stats is None}


ROUTES = {"/api/interrogate": interrogate, "/api/accuse": accuse, "/api/image": portrait}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def _send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/case":
            return self._send_json(200, public_case())
        return super().do_GET()

    def do_POST(self):
        handler = ROUTES.get(self.path)
        if not handler:
            return self._send_json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            status, payload = handler(body)
        except RunpodError as e:
            status, payload = 502, {"error": str(e)}
        except (ValueError, TypeError) as e:
            status, payload = 400, {"error": f"Bad request: {e}"}
        self._send_json(status, payload)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if not os.environ.get("RUNPOD_API_KEY"):
        print("⚠️  RUNPOD_API_KEY is not set; the manor will stay dark until you export it.")
    print(f"🕯️  Murder at Hollow Manor is open at http://localhost:{PORT}")
    print(f"    LLM: {LLM_ENDPOINT}   Images: {IMAGE_ENDPOINT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
