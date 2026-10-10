# 🕯️ Murder at Hollow Manor

A Halloween murder mystery where every suspect is a live LLM and every portrait is painted on demand, all served by **Runpod Public Endpoints**. There's nothing to deploy and no GPUs to manage. You pay per request.

Halloween night, 1926. Lord Silas Hollow is found poisoned in his library during a masquerade ball. Players interrogate five suspects, catch them in lies, and make one accusation.

| What | Runpod Public Endpoint |
| --- | --- |
| Suspect dialogue + final reveal | `qwen3-32b-awq` (Qwen3 32B AWQ) |
| Crime scene + suspect portraits | `black-forest-labs-flux-1-schnell` (FLUX.1 Schnell) |

## Run it

Python 3.9+ with the standard library only. There's nothing to install.

```bash
export RUNPOD_API_KEY=rpa_...      # needs access to Public Endpoints (not an endpoint-restricted key)
python3 server.py
open http://localhost:8666
```

Optional overrides: `PORT`, `RUNPOD_LLM_ENDPOINT`, `RUNPOD_IMAGE_ENDPOINT`.

## What to show on stage

- **⚡ Inference Log** (top right): every Runpod job with queue time, execution time, worker ID, and cost. Open it while you play.
- **Parallel fan-out**: clicking *Enter the Manor* fires six FLUX jobs at once. They resolve in parallel across workers.
- **Per-message stats**: every suspect reply shows the endpoint, latency, and cost underneath.
- **Secrets stay server-side**: personas and the solution live in `case.py` and never reach the browser, so nobody can solve it from devtools.

Typical costs from test runs: ~$0.003 per portrait and under $0.01 per interrogation question. A full game costs a few cents.

## Presenter cheat sheet (spoilers!) 🩸

**Rosalind Vale (the niece) did it** with aconite stolen from Dr. Crane's bag, poured into the absinthe.

The fast path to solve it in about 5 minutes live:

1. **Madame Zora**: "Did anyone leave the séance early?" → Rosalind left at 11:35 and came back with anise-smelling gloves.
2. **Finch**: "Why were you on the back stairs at 11:40?" → he confesses to stealing wine and saw a *raven mask* enter the library.
3. **Dr. Crane**: "Is anything missing from your medical bag?" → the aconite is missing, and Rosalind lay down in the study at 10:30.
4. **Lady Vivienne**: "What did Silas say about the will?" → he was cutting Rosalind out tomorrow.
5. **Rosalind**: confront her with all of it, watch her squirm, then accuse.

Red herrings: Vivienne and Crane's affair, Crane's gambling debt, Finch's wine theft, Zora's foot-pedal "spirit knocks."

Wrong accusations get a different ending where the killer escapes into the storm.

## Files

- `server.py`: tiny HTTP server that calls Runpod `/runsync` (and falls back to polling `/status`)
- `case.py`: the mystery: setting, suspect personas, solution, image prompts
- `static/`: the spooky single-page UI
