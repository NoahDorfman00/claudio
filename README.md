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

Claudio is a full Claude chat app wearing a flat cap. He can code, write,
explain, read images and PDFs, and search the web, the same as Claude can.
The difference is the voice: Brooklyn, the kitchen, Nonna.

**The page** is plain HTML, CSS and ES modules (`app.js`, `store.js`,
`account.js`). No
framework, no build step. It looks like a normal chat app: a sidebar of past
chats, a thread, and a composer that takes attachments. Markdown is rendered
with `marked` + `DOMPurify`, code is highlighted with `highlight.js`, all
loaded from jsDelivr.

**Replies stream.** The page `POST`s the conversation to one HTTP function,
`claudioChat`, and reads back server-sent events as they arrive: thinking,
text, a line each time he searches or reads a page, and the sources he cited.
A stop button aborts the request mid-answer.

**Conversations are saved in the browser** (IndexedDB), so a refresh doesn't
wipe Claudio's memory of you, but nothing is stored on a server. Each
assistant turn is kept as the raw content blocks the API returned (thinking,
search results, citations) and sent back unchanged on the next turn. Editing
a message or regenerating an answer cuts the conversation at that point and
continues from there, so earlier turns are never rewritten.

**The function** (`functions/index.js`) is a Firebase Functions v2
`onRequest` handler on Node 22. It reads the Anthropic key from a Firebase
secret and streams one `messages.stream` call:

- model: `claude-sonnet-5-5`, `max_tokens: 32000`
- adaptive thinking with summarized thoughts, shown in a collapsible
  "Claudio's thoughts" section
- effort `low` by default; the **Think it through** toggle sends `high`
- server tools: `web_search_20260209` and `web_fetch_20260209`
- prompt caching, and server-side refusal fallback (`fallbacks: "default"`)
- `pause_turn` from long server-tool turns is resumed automatically
- CORS is limited to the live domain and `localhost`

**Who pays.** Every visitor is signed in to Firebase Auth anonymously in
the background, and that's what the free trial is counted against: $0.30
of actual API cost on my key, about ten typical messages
(`functions/access.js`). There's no counter in the UI; you just chat until
it runs out. Each network gets the same $0.30 over a rolling 30 days, so
clearing storage or signing out for a fresh guest session doesn't unlock
more. The network is the client address Google's front end appends last to
`X-Forwarded-For` (earlier entries can be spoofed), grouped by /64 for IPv6.
When the trial runs out, a "keep going?" dialog offers:

- **Bring your own API key.** Keep it in this browser for 7 days (it's sent
  along with each message and never stored server-side), or sign in and
  save it to your account, encrypted.
- **Become a regular.** $6/month through Stripe, running on my key, with a
  monthly allowance of $5 of actual API cost. Each reply's cost is worked
  out from the token and search counts the API reports (`costMicros` in
  `functions/access.js`) and added to the subscriber's current billing
  period, so it resets on their billing date rather than the 1st. The UI
  shows it as a percent-used meter. Cheap chats stretch it to several
  hundred messages; search- and PDF-heavy ones use it up faster. Every
  request also logs a `[usage]` line with its cost to Cloud Logging, which
  is the data to check the price against.

Signing in with Google *links* the anonymous account, so trial usage
carries over instead of resetting. For each message the server picks who
pays in this order: subscription, a key the browser sent, a saved key, then
the trial. Trial and subscription messages are charged at what they
actually cost, so one that fails before Claudio says anything costs
nothing.

**Saved keys** are encrypted with AES-256-GCM (`functions/keyCrypto.js`).
The data key is the `ANTHROPIC_KEY_ENCRYPTION_KEY` secret, and the user's
uid is bound in as associated data, so a ciphertext copied onto another
account won't decrypt. Keys live at `users/{uid}/private/apiKey` and never
go back to the browser; the UI only sees the last four characters.

**Billing** is Stripe Checkout for signing up and Stripe's hosted customer
portal for cancelling, card updates and invoices. `stripeWebhook` keeps
`users/{uid}.subscriptionStatus` in sync from `checkout.session.completed`
and `customer.subscription.created/updated/deleted`. Firestore rules deny
all client access; the browser gets what it needs from `GET /api/account`.

**The prompt** (`functions/prompt.js`) keeps Claudio's backstory (Sicilian
grandparents, Brooklyn, the family restaurant) and tells the model to keep
the voice in the framing: kitchen metaphors, a little Brooklyn Italian, "let
me check with a guy" before a web search. The answer itself has to be as good
as Claude's. Code stays clean, facts stay facts, and he drops the bit when
someone is going through something hard or asks him to.

## Stack

| Piece | What |
|---|---|
| Frontend | Static `index.html` + `styles.css` + `app.js` + `store.js` + `account.js`; Spectral and JetBrains Mono from Google Fonts; marked, DOMPurify and highlight.js from jsDelivr; Firebase Auth JS SDK 12 from gstatic |
| Hosting | GitHub Pages from the root of `main`, with a custom domain (`CNAME`) |
| Backend | Firebase Functions v2 (`onRequest`), Node 22: `claudioChat` (streaming SSE), `api` (account, keys, checkout, portal), `stripeWebhook` |
| Model | Claude Sonnet 5.5 with adaptive thinking, web search and web fetch |
| Auth | Firebase Auth: anonymous for guests, Google to sign in |
| Storage | Chats in the browser's IndexedDB. Firestore holds only trial usage, subscription status, encrypted keys and the day's welcome messages |
| Billing | Stripe Checkout + customer portal + webhook |
| Secrets | `ANTHROPIC_API_KEY`, `ANTHROPIC_KEY_ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` |

### Model history, per `git log`

| Commit | Model |
|---|---|
| first commit (June 2025) | `claude-sonnet-4-20250514` |
| "claude API call and parse fixes" (same day; adds web search) | `claude-3-5-sonnet-20241022` |
| "updated claude to 4.5" (Oct 2025) | `claude-sonnet-4-5` |
| the rewrite (Oct 2026) | `claude-sonnet-5-5` |

## Running it locally

You'll need the Firebase CLI and a Firebase project of your own.

1. Put your project ID in `.firebaserc`, and your web config and the two
   function URLs (they contain the project ID) at the top of `account.js`.
2. Install the function's dependencies:
   ```bash
   cd functions && npm install
   ```
3. Give the emulator its secrets in `functions/.secret.local` (gitignored).
   Stripe test-mode keys work here; with fake ones, everything except
   checkout still runs.
   ```
   ANTHROPIC_API_KEY=your_anthropic_api_key
   ANTHROPIC_KEY_ENCRYPTION_KEY=<output of: openssl rand -base64 32>
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRICE_ID=price_...
   ```
4. From the repo root, start the emulators:
   ```bash
   firebase emulators:start
   ```
   Open the page at `http://localhost:5002`. On `localhost` the page talks
   to the Functions emulator (port 5001) and the Auth emulator (port 9099).
   The emulator UI at `http://localhost:4000` shows users and Firestore
   docs, which is handy for resetting a trial.

### Deploying

One-time setup in the Firebase console:

- **Authentication:** enable the Anonymous and Google
  providers, and add `claudio.noahgdorfman.com` under Settings → Authorized
  domains.
- **Firestore:** create the database (production mode is fine; the rules
  deny all client access anyway).

One-time setup in Stripe:

- Create a product with a recurring price; its ID is `STRIPE_PRICE_ID`.
- Add a webhook endpoint pointing at the deployed `stripeWebhook` URL, sending
  `checkout.session.completed` and `customer.subscription.created`,
  `.updated` and `.deleted`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.
- Turn on the customer portal (Settings → Billing → Customer portal) and allow
  cancelling and updating payment methods.

Then set the secrets and deploy:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
openssl rand -base64 32 | firebase functions:secrets:set ANTHROPIC_KEY_ENCRYPTION_KEY --data-file -
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase functions:secrets:set STRIPE_PRICE_ID
firebase deploy --only functions,firestore:rules
```

Don't rotate `ANTHROPIC_KEY_ENCRYPTION_KEY` casually: saved keys encrypted
with the old one stop decrypting, and those users have to save their key
again.

The first deploy after the rewrite will offer to delete the old `claudioAI`
callable function. Say yes; nothing uses it anymore.

The frontend deploys when you push to `main`; GitHub Pages serves the repo
root.

## Lessons learned

From the first version, which used `<character_analysis>` and `<response>`
tags and a non-streaming callable function:

1. **Server tools change the response shape.** With web search on, the
   answer arrives as a dozen text blocks split around citations, so reading
   `content[0]` got me Claudio's private thoughts and nothing he said.
2. **Web search is paid for in input tokens.** The single chicken-parm
   question in `example.txt` ran two searches and used about 49k input
   tokens.
3. **Hidden reasoning is billed twice.** The UI hid `<character_analysis>`,
   but the full reply went back into the history, so every turn paid for
   every earlier turn's thinking again.
4. **Tag-based output needs a way out.** When the `<response>` tag went
   missing or got cut off, a fallback regex and a Retry button worked better
   than showing a blank bubble.

The rewrite drops the tags entirely. The model's own thinking does the
character work, the reply is just the reply, and streaming means you see
Claudio start talking right away instead of staring at "thinking..." for
twenty seconds.

## Repo layout

```
index.html        the chat page (static, no build step)
app.js            client: streaming, rendering, attachments, edit/regenerate
account.js        client: Firebase Auth, trial status, paywall/key/sign-in/account dialogs
store.js          saved chats in IndexedDB
styles.css        layout, light/dark themes
assets/           Claudio portrait + small avatar, logo, social card
functions/        index.js (claudioChat, api, stripeWebhook), access.js (who pays),
                  keyCrypto.js (saved-key encryption), prompt.js (Claudio)
firestore.rules   deny-all; only the functions touch Firestore
example.txt       a raw API response with web search, kept from debugging v1
firebase.json     Functions + Firestore rules config, emulator ports
CNAME             custom domain for GitHub Pages
```

## Credits

