# Claudio

A chatbot that role-plays Claudio: second-generation Italian-American, late
40s, owns a family restaurant in Brooklyn, has opinions about your chicken
parm. One static page, one Firebase Function, one very long system prompt.
Live at [claudio.noahgdorfman.com](https://claudio.noahgdorfman.com/).

<p align="center">
  <img src="assets/social.png" alt="Illustrated portrait of Claudio in a flat cap, with the title 'Claudio: Artificial Italian'" width="560">
</p>

## Why

This was my first time playing with prompt building. I'm Italian-American,
wrapping an LLM in that heritage sounded like fun, and Claude → Claudio was
too on the nose not to do.

The site's tagline is "Artificial Italian," and that is the whole pitch.

## How it works

**The page** is plain HTML, CSS and an ES module (`app.js`). No framework, no
build step. It loads the Firebase JS SDK from Google's CDN and calls a single
callable function, `claudioAI`. When it's served from `localhost`, it points
at the Functions emulator instead.

**The conversation lives in the browser.** `app.js` keeps a `conversation`
array of `{role, content}` messages and sends the whole thing on every turn.
The backend is stateless and nothing goes into a database, so a refresh wipes
Claudio's memory of you. (The function does log each conversation and reply
to Cloud Logging, which is where the debugging happened.)

**The function** (`functions/index.js`) is a Firebase Functions v2 `onCall`
handler. It reads the Anthropic key from a Firebase secret
(`defineSecret('ANTHROPIC_API_KEY')`) and makes one `messages.create` call:

- model: `claude-sonnet-4-5`
- `max_tokens: 1024`
- one server-side tool: `web_search` (`web_search_20250305`) with `max_uses: 1`

**The prompt** gives Claudio a backstory: grandparents who came from Sicily
to New York in the 1930s, US-born parents, a Brooklyn childhood, and some
Italian that's mostly about family, food and feelings. It also lists his
values (family, elders, shared meals) and his personality ("warm,
expressive, and passionate... direct... but always good-natured"). Then it
asks the model to work in two steps:

1. Think in `<character_analysis>` tags: which expressions fit the message,
   how a restaurant owner would see it, which family story he might tell.
   The prompt says this part can be "quite long."
2. Answer in `<response>` tags. Use Italian only where Italian-Americans
   actually would, and "avoid exaggerated stereotypes or caricatures."

**Hiding the backstage.** The function joins every `text` block in the
response and returns the whole thing as `fullReply`. The client pulls out
whatever is inside `<response>...</response>` and shows only that. If the
closing tag never arrives (1024 tokens goes fast after a long character
analysis), it falls back to everything after `<response>`. If there's no
`<response>` tag at all, you get an apology and a **Retry** button, which
resends the conversation as it was before that turn.

**Web search** lets Claudio look things up, like where to get chicken parm
in Delco. `example.txt` is a raw API response saved while I was wiring this
up: Claudio's private analysis, a search, a pile of results, and an answer
split into text blocks around the citations.

## Stack

| Piece | What |
|---|---|
| Frontend | Static `index.html` + `styles.css` + `app.js`, Spectral from Google Fonts, Firebase JS SDK 9.22 from CDN |
| Hosting | GitHub Pages from the root of `main`, with a custom domain (`CNAME`) |
| Backend | One Firebase Function (v2 `onCall`), Node 18, `@anthropic-ai/sdk` |
| Model | Claude Sonnet 4.5 with the Anthropic web search tool |
| Secrets | Firebase secret `ANTHROPIC_API_KEY` |

`firebase.json` also has a Firebase Hosting config with a `/claudio-ai`
rewrite to the function. The live site doesn't use it: the page is served
from GitHub Pages and calls the function directly through the callable SDK.

### Model history, per `git log`

| Commit | Model |
|---|---|
| first commit (June 2025) | `claude-sonnet-4-20250514` |
| "claude API call and parse fixes" (same day; adds web search) | `claude-3-5-sonnet-20241022` |
| "updated claude to 4.5" (Oct 2025) | `claude-sonnet-4-5` |

## Running it locally

You'll need the Firebase CLI and a Firebase project of your own.

1. Put your own project's web config in the `firebaseConfig` object at the
   top of `app.js`, and your project ID in `.firebaserc`.
2. Install the function's dependencies:
   ```bash
   cd functions && npm install
   ```
3. Give the emulator an Anthropic key by creating `functions/.secret.local`:
   ```
   ANTHROPIC_API_KEY=your_anthropic_api_key
   ```
4. From the repo root, start the emulators:
   ```bash
   firebase emulators:start
   ```
   Open the page on `localhost`. `app.js` detects that and sends calls to
   the Functions emulator on port 5001.

To deploy the function:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase deploy --only functions
```

The frontend deploys when you push to `main`; GitHub Pages serves the repo
root.

## Lessons learned

1. **Server tools change the response shape.** With web search on, the
   answer arrives as a dozen text blocks split around citations, so reading
   `content[0]` got me Claudio's private thoughts and nothing he said.
2. **Web search is paid for in input tokens.** The single chicken-parm
   question in `example.txt` ran two searches and used about 49k input
   tokens, so `max_uses` is now 1.
3. **Hidden reasoning is billed twice.** The UI hides `<character_analysis>`,
   but the full reply goes back into the history, so every turn pays for
   every earlier turn's thinking again.
4. **Tag-based output needs a way out.** When the `<response>` tag goes
   missing or gets cut off, a fallback regex and a Retry button work better
   than showing a blank bubble.

## Repo layout

```
index.html        the chat page (static, no build step)
app.js            client: conversation state, callable function, <response> extraction
styles.css        chat bubbles, header portrait, retry button
assets/           Claudio portrait, logo, social card
functions/        Firebase Function `claudioAI` (prompt + Anthropic call)
example.txt       a raw API response with web search, kept from debugging
firebase.json     Functions config (+ an unused Hosting rewrite)
CNAME             custom domain for GitHub Pages
```

## Credits

