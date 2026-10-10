# 🩸 Spoilers: solution and presenter guide

Don't read this if you want to play.

## The solution

**Rosalind Vale (the niece) did it** with aconite stolen from Dr. Crane's bag, poured into the absinthe.

The fast path to solve it in about 5 minutes live:

1. **Madame Zora**: "Did anyone leave the séance early?" → Rosalind left at 11:35 and came back with anise-smelling gloves.
2. **Finch**: "Why were you on the back stairs at 11:40?" → he confesses to stealing wine and saw a *raven mask* enter the library.
3. **Dr. Crane**: "Is anything missing from your medical bag?" → the aconite is missing, and Rosalind lay down in the study at 10:30.
4. **Lady Vivienne**: "What did Silas say about the will?" → he was cutting Rosalind out tomorrow.
5. **The Coroner**: "Examine the black feather" and "Any fingerprints on the glass?" → a costume feather and black leather gloves.
6. **Rosalind**: confront her with all of it, watch her squirm, then accuse.

Red herrings: Vivienne and Crane's affair, Crane's gambling debt, Finch's wine theft, Zora's foot-pedal "spirit knocks."

Wrong accusations get a different ending where the killer escapes into the storm.

## What to show on stage

- **⚡ Inference Log** (top right): every Runpod job with queue time, execution time, worker ID, and cost. Open it while you play.
- **Parallel fan-out**: clicking *Enter the Manor* fires seven FLUX jobs at once. They resolve in parallel across workers.
- **Scale to zero**: the Coroner's card shows live worker state. Ask him something while he's asleep and narrate the cold start, or ring the crypt bell a couple of minutes before you need him.
- **Per-message stats**: every reply shows the endpoint, latency, and cost underneath.
- **Secrets stay server-side**: personas and the solution live in `case.py` and never reach the browser, so nobody can solve it from devtools.
