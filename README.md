# 🕯️ Murder at Hollow Manor

**A Halloween murder mystery where every suspect is an AI, and every one of them is hiding something.**

*Halloween night, 1926.* The masquerade ball at Hollow Manor ends with a scream at 11:58 PM. Lord Silas Hollow lies dead in his library, poisoned, a glass of green absinthe at his side and a single black feather on the carpet. The storm has washed out the only road. The killer is still in the house.

You're the detective. Question the guests, consult the Coroner, catch them in their lies, and name the killer. You only get one accusation. Get it wrong, and they slip away into the storm.

## Meet the suspects

Five guests, each in costume, and each with a secret. Some of those secrets have nothing to do with the murder, and they'll lie to protect them anyway.

- **Lady Vivienne Hollow**, the widow. His much younger wife: composed, icy, and not visibly grieving.
- **Dr. Ambrose Crane**, the physician. The family doctor for twenty years, twitchy and sweating.
- **Edgar Finch**, the butler. Forty years of service, and the one who found the body.
- **Miss Rosalind Vale**, the niece. Charming, and the presumed heir.
- **Madame Zora**, the medium. Hired to hold a midnight séance, and claims the dead speak to her.

And in the crypt below, **Dr. Mortimer Graves**, the Coroner. He only talks about the evidence, and he doesn't like being woken.

## Why it's different

- **Nothing is scripted.** Every suspect is a live language model playing a character. Ask anything, in your own words. Press them, bluff, play them against each other.
- **They remember.** Suspects keep track of what they've told you, so contradictions are clues.
- **The art is painted on demand.** The crime scene and every portrait are generated fresh by an image model when you walk in.
- **You can't cheat.** The solution never reaches your browser, so devtools won't help you.
- **See how it's made.** Open the **⚡ Inference Log** to watch every AI call as it happens: which GPU ran it, how long it took, and what it cost (usually a fraction of a cent).

## How it's built

The whole game runs on [Runpod](https://www.runpod.io), with no GPUs to rent or manage:

| Part of the game | Model | Runs on |
| --- | --- | --- |
| Suspects and the final reveal | Qwen3 32B | Runpod Public Endpoint |
| Crime scene and portraits | FLUX.1 Schnell | Runpod Public Endpoint |
| The Coroner | Qwen3 8B | Runpod Serverless, scaled to zero until someone rings the crypt bell |

The server is a single Python file with no dependencies. It keeps the characters' secrets server-side and passes each question to the model.

## Play it yourself

All you need is Python 3.9+ and a [Runpod API key](https://www.runpod.io/console/user/settings).

```bash
git clone https://github.com/JessicaGarson/hollow-manor-mystery.git
cd hollow-manor-mystery
export RUNPOD_API_KEY=rpa_...
python3 server.py
```

Then open http://localhost:8666. A full game costs a few cents in Runpod usage.

Want to host it for other people to play? See **[DEPLOY.md](DEPLOY.md)** for public hosting, spending limits, and the optional Coroner setup.

## Stuck?

The solution and a 5-minute walkthrough are in **[SPOILERS.md](SPOILERS.md)**. Don't peek until you've made your accusation. 🩸

## Make your own mystery

The whole case lives in [`case.py`](case.py): the setting, the timeline, each suspect's personality and secrets, the solution, and the image prompts. Swap them out and you have a new mystery.
