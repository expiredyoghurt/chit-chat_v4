# Just a Chit-Chat

A Singapore-oral-conversation practice game (TREES framework, 25-mark rubric)
built as a single Cloudflare Worker: one file serves the pupil-facing game,
the leaderboard, and hidden teacher tools, backed by Workers KV.

## What's included

```
just-a-chit-chat/
  wrangler.toml          Worker + KV + AI config
  src/index.js            API routes, auth, vulgarity filter, AI marking, KV logic
  src/frontend.js         The entire pupil + teacher web app (HTML/CSS/JS), served at "/"
  src/seed-topics.js      12 starter topic/picture cards (each with 3 questions)
  src/vulgarity-list.js   Starter profanity word list used to mask pupil text
  README.md               You are here
```

## Deploying without a terminal

Everything below assumes the Wrangler CLI. If you'd rather deploy entirely
from your browser — no command prompt, no local installs — see
**[BROWSER_DEPLOY_GUIDE.md](./BROWSER_DEPLOY_GUIDE.md)** instead, which
covers the same setup (KV namespace, secrets, teacher password) using only
the Cloudflare and GitHub web dashboards.

## Deploying on Firebase instead

If you'd rather run this on Firebase (Firestore + Cloud Functions) instead
of Cloudflare — e.g. to keep it consistent with other Firebase-hosted
projects — see **[firebase-backend/FIREBASE_DEPLOY_GUIDE.md](./firebase-backend/FIREBASE_DEPLOY_GUIDE.md)**.
It's a full port exposing the identical REST API, so `frontend.js` is
shared unchanged between both deployment targets.

## 1. Prerequisites

- A Cloudflare account (free tier works)
- Node.js installed locally
- `npm install -g wrangler` (Cloudflare's CLI), then `wrangler login`
- A free Google Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  (used as the main AI marker — see step 4)
- Optionally, a free Groq API key from [console.groq.com](https://console.groq.com)
  as a second-line marker

## 2. Create the KV namespace

```bash
cd just-a-chit-chat
wrangler kv:namespace create CCv4_DATA
```

Copy the `id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## 3. Set the teacher password (stored in KV, never in code)

```bash
wrangler kv:key put --binding=CCv4_DATA "config:teacher_password" "choose-a-strong-password"
```

Only the login name **palpatine** unlocks the password prompt for Teacher Tools —
any pupil typing that name (or any other name) never sees a hint that it's special
unless they already know it. Teachers can change the password later from inside
**Teacher Tools → Settings** without redeploying.

## 4. AI marking: Gemini → Groq → Cloudflare Workers AI → offline scorer

Marking uses three AI providers, tried in order, then an offline scorer as a
last resort, so pupils are never left without feedback:

1. **Google Gemini** (1st) — the only vision-capable provider here. It's
   sent the actual topic picture (fetched and base64-encoded server-side) so
   it can verify the Evidence (E1) part against what's really in the
   picture, not just judge plausibility. Requires one API key.
2. **Groq** (2nd) — fast, free-tier Llama marking, used if Gemini's key is
   missing or a Gemini call fails/is rate-limited. Text-only — see "Picture
   Description" below for how it still marks Evidence sensibly. Requires one
   API key.
3. **Cloudflare Workers AI** (3rd) — free, built into this Worker via the
   `[ai]` binding in `wrangler.toml`, no signup needed. Also text-only. Used
   automatically if both Gemini and Groq are unavailable.
4. If all three are unavailable, marking falls back further to a simple
   offline rule-based keyword/relevance/language score, so the app never
   hard-fails — pupils just get less nuanced feedback until AI marking is
   back. This offline scorer is intentionally strict (it checks for on-topic
   content and specific keyword/grammar patterns, not just answer length),
   so it under-scores rather than over-scores while it's active — see the
   in-app AI status badge below.

Pupils and teachers can always see which mode marked a given question: a
green **"AI connected"** badge means one of the three AI providers marked it;
a red **"AI unavailable"** badge means it fell all the way through to the
offline scorer, and the score may be less accurate as a result. Non-practice
attempts that hit the offline scorer are also kept off the leaderboard.

### Picture Description (fallback for text-only providers)

Since only Gemini can actually see the picture, Groq and Workers AI need
another way to judge whether an Evidence (E1) claim is accurate. Teacher
Tools → Topics → each topic has an optional **"Picture Description"** field
— describe what's actually in the picture (not the topic in general), and
Groq/Workers AI will use that text instead of guessing. If it's left blank,
those two providers are told plainly that they can't see the picture and to
mark Evidence on plausibility/specificity only, without penalising for
accuracy they can't verify. This also matters if Gemini's own image fetch
fails (broken link, non-image response, image blocked by the host) — Gemini
falls back to the same description-based marking for that attempt.

### Set your Gemini key

```bash
wrangler secret put GEMINI_API_KEY
```

Paste your key from [Google AI Studio](https://aistudio.google.com/apikey)
when prompted. This is a real credential, so — unlike the teacher password —
it's stored as an encrypted Worker **secret**, never in KV, `wrangler.toml`,
or any source file.

### Set your Groq key (optional but recommended)

```bash
wrangler secret put GROQ_API_KEY
```

Paste your key from [console.groq.com](https://console.groq.com) when
prompted. Same rules as the Gemini key — stored as an encrypted secret,
never in source or `wrangler.toml`. This step is optional; without it,
marking just skips straight from Gemini to Workers AI. If a key was ever
pasted somewhere insecure (a chat, a doc, a screenshot), regenerate it in
the relevant console — old keys can just be revoked with no other cleanup
needed.

### Free tier notes

- **Gemini**: has a free tier (`gemini-2.5-flash` by default). Sending an
  image uses more of that quota per call than text alone. See
  [Google AI Studio's rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
  for current numbers.
- **Groq**: generous free-tier rate limits, no card required. See
  [Groq's docs](https://console.groq.com/docs/rate-limits) for current
  numbers.
- **Workers AI**: the Workers Free plan includes 10,000 "Neurons" of use per
  day, which comfortably covers normal classroom use as a fallback. See
  [Cloudflare's Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
  for current numbers.

### Changing models later

Edit the `model` string in `callGroq()`, `callGemini()`, or `callWorkersAI()`
in `src/index.js` (e.g. to a newer release) and redeploy. The Groq model can
also be changed without redeploying — see Teacher Tools → Settings.

## 4b. Language Use, filler words, and the model answer (v6)

Marking is no longer just content (TREES, 25 marks) — there's now a separate
**Language Use** score (5 marks, 30 total): Grammar Accuracy (0–2),
Vocabulary Range & Appropriateness (0–2), and Fluency & Delivery (0–1). It's
graded from the pupil's actual sentences, independently of how good their
ideas/experience are, so a pupil with a weak story but clean grammar (or
vice versa) is scored fairly on both.

- **Filler words**: the app counts filler words/phrases (um, uh, erm, like,
  you know, etc.) in the transcript and feeds that count into the Fluency
  score — either as evidence given to the AI marker, or as a direct
  deduction in the offline fallback. This is only as reliable as the
  browser's speech-to-text transcript, which is known to smooth over or drop
  disfluencies rather than transcribe them faithfully — treat it as a
  best-effort signal, not a precise measurement.
- **Model answer**: every AI-marked question now also returns a short
  rewritten version of the *pupil's own* answer — same content/experience,
  but with stronger grammar, added missing 5W1H detail, and better flow.
  Shown on the pupil's result screen and in the teacher's submission detail.
  The offline fallback can't generate this (no LLM to draw on), so it's
  simply omitted for those attempts.
- The default rubric text (Teacher Tools → Settings → AI Marking Rubric) has
  been updated to include the Language Use criteria — if you'd previously
  customised the rubric, you'll want to add a Language Use section yourself,
  since custom rubric text fully replaces the default rather than merging
  with it.

## 4c. Pupil tracking by name & class (v6)

Pupils can log in as just a name ("Ashraf"), or with a class using an `@`
sign ("Ashraf@5IG") so their teacher can track progress by class. This is
optional — a pupil who doesn't include a class is grouped under
"unassigned".

- **Teacher Tools → Pupils** — a new tab listing every pupil who's completed
  a scored attempt, each with a "View Progress" button showing their score
  trend over their last several attempts, and two auto-generated lists:
  **Strengths** and **Areas to grow**, computed by averaging each TREES/
  Language criterion across their history and flagging the highest/lowest.
  This is pure arithmetic on stored scores — no AI call involved.
  Both lists show up empty until a pupil has a few scored attempts to
  average.
- Only non-practice attempts that were fully AI-marked count toward this
  tracking (same rule as the leaderboard) — practice runs and offline-marked
  attempts aren't a reliable signal of the pupil's real ability, so they're
  excluded from both the trend and the strengths/concerns calculation.
- History is a capped rolling log (last 50 scored attempts per pupil) so a
  pupil's KV record doesn't grow without bound.
- **Breaking change for existing deployments**: pupil records used to live
  at KV key `pupil:<name>`; they now live at `pupil:<class>:<name>` (needed
  since the same name can appear in multiple classes). If you're upgrading
  an existing deployment, old pupil records won't carry over automatically —
  pupils logging in again will simply start a fresh record under the new
  key. There's no built-in migration script for this.

## 5. The NPC Coach (sentence starters + resources)

Each of the 3 questions on a topic can have its own optional "Coach": a
short list of sentence starters, plus up to 2 teacher-picked links (article
or video). Pupils see a **"Ask the Coach"** button on a question only when
that question actually has starters or resources set — tapping it reveals
them.

- **Manually set by the teacher** — Teacher Tools → Topics → edit a topic →
  each question has its own "Coach sentence starters" box and 2 resource
  slots (title + link + type). There is deliberately no AI-generated link
  suggestion here: an LLM can produce a plausible-looking article or video
  URL that doesn't actually exist, so links are always the teacher's own,
  pasted in directly.
- **Video links are locked** — a YouTube link is embedded with autoplay
  restrictions and no related-video suggestions; when it ends, pupils see a
  "Watch Again" replay rather than YouTube's normal end-screen grid of other
  videos, so they only ever have a path to the one video the teacher chose.
  A non-YouTube video link falls back to a plain "opens in new tab" link
  instead (only YouTube gets the locked embed treatment).
- **Usage is flagged for the teacher, not the pupil** — if a pupil opens the
  Coach on a question, that's recorded against their submission (visible as
  a "Coach used" tag in Teacher Tools → Submissions, and as a
  `Q1/Q2/Q3_coachUsed` column in the CSV export) but pupils are never told
  this is tracked.
- **Pre-seeded examples** — the 12 built-in topics ship with real starter
  content and links pulled from public PSLE-oral-prep blogs (Lil' but
  Mighty, AGrader, illum.education, Learning Journey, Thinking Factory,
  doappliedlearning.com.sg) so you can see the feature working immediately.
  This seed data only loads into a brand-new, empty KV namespace (see
  `ensureSeeded()` in `src/index.js`) — if you're upgrading an existing
  deployment, your current topics won't automatically pick up this coach
  content; add it via the Topics editor, or clear KV and let it reseed if
  you want a totally fresh start.

## 6. Deploy

```bash
wrangler deploy
```

Wrangler prints a `*.workers.dev` URL — that's the whole app. Share it with pupils.

## 7. Using it

**Pupils:** open the URL → type their name → pick a topic card. Each topic
has **3 questions** — pupils answer all 3 in one sitting, and each answer is
marked out of 25 by the AI. Before starting, they choose a response mode:
- **Separated TREES branches** — 5 labelled boxes per question (Thought,
  Reason, Evidence, Experience, Suggestion), with a tree that grows a leaf
  as each branch is filled in.
- **Single response box** — one free-text box per question, just like the
  real spoken exam. The AI still identifies and marks each TREES component
  within the continuous answer, using the same rubric.

After submitting all 3, pupils see their **final score** (the average of
the 3 question scores, out of 25) plus each individual question's score,
breakdown, and feedback — then check the leaderboard.

**Teacher:** open the URL → type `palpatine` as the name → enter the password
from step 3 → five tabs appear:
- **Leaderboard** — view and reset scores (per pupil or all). Scores shown
  are each pupil's average-of-3 session score, out of 25.
- **Submissions** — read every pupil's full session (all 3 questions, their
  answers, and per-question breakdowns), see anything the vulgarity filter
  caught, see which attempts were practice-only, delete entries, and
  **export everything as a CSV** (one click download — columns: pupil,
  topic, mode, practice yes/no, final score, flagged, timestamp, then each
  of the 3 questions/answers/scores)
- **Topics** — add new picture/topic cards (title, image URL, **3** examiner
  questions, tags) or edit/delete existing ones. All 3 question fields are
  used as the 3 graded rounds, so fill in all of them.
- **Settings** — change the teacher password, edit the **AI marking
  rubric**, and choose the **Groq marking model** (both below)

### Where to edit the rubric

Teacher Tools → **Settings** → "AI Marking Rubric" box. Whatever you type
there is sent to the AI marker for every question in every submission from
that point on — it's the actual scoring guidance the model follows. It's
stored in KV (`config:rubric`), so no redeploy needed, and it applies
immediately to the next submission. Leave it blank and hit Save to fall back
to the built-in default rubric (also visible in `src/index.js` as
`DEFAULT_RUBRIC`). This only affects **AI marking** — if none of Groq,
Gemini, or Workers AI is reachable, scoring uses the offline keyword-based
fallback instead, which doesn't read the rubric.

### Where to change the Groq model

Teacher Tools → **Settings** → "Groq Marking Model" dropdown. Pick one of the
known models, or choose "Other" to type any valid Groq model ID directly (see
[console.groq.com/docs/models](https://console.groq.com/docs/models) for the
current list). This only changes which model **Groq** uses — Gemini and
Workers AI keep their own fixed models, changeable only by editing
`src/index.js`. Stored in KV (`config:model_groq`), applies immediately, no
redeploy needed. Leave it on the default and hit Save (or hit Reset to
Default) to go back to the built-in default (`openai/gpt-oss-120b`).

### Marking scheme (TREES only — PEEL has been removed)

The game only teaches and marks **TREES**, each question out of **25 marks**,
weighted so Experience matters most:

| Part | Marks |
|---|---:|
| T — Thought | 2 |
| R — Reason | 3 |
| E — Evidence (picture/topic) | 3 |
| E — Experience | **15** |
| S — Suggestion | 2 |

The Experience part is itself broken into 5 sub-criteria that the AI marker
scores and sums (shown to pupils and teachers as a nested breakdown):
Relevance (2), 5W1H Specificity (6), Authenticity/Personal Voice (3),
Clarity & Sequence (2), Reflection/Lesson Learnt (2). The default rubric
instructs the AI not to reward length alone — a long but generic answer
should score low, while a short but specific, believable one scores well.

A pupil's **final score** for the practice session is the average of their
3 question scores (each out of 25), rounded to 1 decimal place.

If neither Groq nor Workers AI is reachable, the built-in offline fallback
approximates this with simple keyword checks (pronouns, time/place words,
"because", sequence words like "then"/"in the end", reflection words like
"felt"/"learnt") — it's a rough stand-in, not real understanding, and the
app tells pupils that in the feedback text.

### Response modes: separated TREES vs single response box

Both modes are marked against the exact same 25-mark rubric:
- In **separated** mode, the AI marks each of the 5 labelled boxes directly.
- In **single response box** mode, the pupil writes one continuous answer
  (closer to a real spoken response), and the AI is instructed to read the
  whole thing and identify/mark each TREES component wherever it appears,
  scoring any genuinely missing component as 0.

This is a session-wide choice made once before starting (applies to all 3
questions in that sitting), not a per-question toggle.

### Practice mode

Pupils see a "Practice mode" checkbox above the Submit button. When ticked,
they still get full AI-marked scores and feedback for all 3 questions, and
the teacher can still see the attempt in Submissions (tagged "practice"),
but it is **not** added to their leaderboard total or best score. Useful for
warm-ups or re-tries before a graded attempt.

## Notes & things worth knowing

- **Vulgarity filter**: `src/vulgarity-list.js` is a starter list of common
  swear words (no slurs). Matches get masked with asterisks before being
  scored or stored, and the submission is flagged for the teacher. Extend
  the list by editing that file and redeploying.
- **Pictures**: the Topics tab takes a direct image URL (e.g. an Unsplash
  link, or an image uploaded to Cloudflare Images / Imgur / your school
  drive with a public link). This build doesn't do file uploads — pasting a
  URL keeps the Worker simple and free-tier friendly.
- **Data**: everything lives in the `CCv4_DATA` KV namespace. There's no
  separate database to manage. To wipe all data, delete and recreate the KV
  namespace (and re-run steps 2–3).
- **Latency**: each submission now makes 3 sequential AI marking calls (one
  per question) before returning the final score, so expect a few seconds
  of "Marking all 3 answers..." — this is normal.
- **Cost**: with Groq's free tier and Workers AI as fallback, this whole app
  runs on free tiers for a single class — Workers, KV, Groq, and Workers AI
  all have free daily allowances. The only way you'd pay anything is if you
  exceed Groq's free-tier rate limits on a very large or very active class,
  in which case Workers AI (also free, just a lower-throughput fallback)
  picks up the slack automatically.
