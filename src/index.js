/**
 * Just a Chit-Chat
 * Cloudflare Worker backend + single-file frontend.
 *
 * KV layout (binding: CCv4_DATA)
 *   config:teacher_password        -> string
 *   config:rubric                  -> string (free-text marking rubric shown to the AI marker)
 *   config:model_groq              -> string (Groq model ID used by callGroq; defaults to DEFAULT_GROQ_MODEL if unset)
 *   session:<token>                -> { name, role, createdAt }
 *   topic:<id>                     -> { id, title, imageUrl, questions:[], tags:[], coach:[] }   (needs 3 questions; coach has one entry per question: {starters:[], resources:[{title,url,type}]})
 *   topics_index                   -> [ id, id, ... ]
 *   submission:<id>                -> { id, pupilName, topicId, topicTitle, mode:"trees"|"single",
 *                                        rounds:[ {question, answer, score, max, breakdown, feedback, suggestion, flagged}, x3 ],
 *                                        finalScore, maxScore:25, practice, createdAt }
 *   submissions_index              -> [ id, id, ... ]   (newest last)
 *   pupil:<name>                   -> { name, bestScore, totalScore, attempts }   (practice attempts are NOT added here; scores are the finalScore average, out of 25)
 *
 * Secrets / bindings
 *   env.GROQ_API_KEY        1st AI marker, wrangler secret put GROQ_API_KEY (console.groq.com)
 *   env.GEMINI_API_KEY      2nd AI marker, wrangler secret put GEMINI_API_KEY (aistudio.google.com/apikey)
 *   env.AI                  3rd AI marker, Cloudflare Workers AI (free, [ai] binding in wrangler.toml)
 *   Marking chain: Groq -> Gemini -> Workers AI -> offline rule-based scorer.
 *   Each provider is tried in order and skipped (not retried) if its key/binding
 *   is missing or the call fails, falling through to the next. If all three AI
 *   providers are unavailable, marking falls back to the offline scorer.
 */

import { VULGAR_WORDS } from "./vulgarity-list.js";
import { PAGE_HTML } from "./frontend.js";
import { SEED_TOPICS } from "./seed-topics.js";

const TEACHER_USERNAME = "palpatine"; // trigger username for hidden teacher tools

// Teacher-configurable via Settings (config:model_groq in KV); this is only
// the default used until a teacher picks something else. Kept in sync with
// Groq's currently-active model list - see console.groq.com/docs/models.
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
// Models a teacher can pick from Settings without having to know exact model
// IDs. If Groq deprecates one of these, update this list and redeploy - a
// teacher can still type any other valid Groq model ID directly, this is
// just the convenience list shown in the dropdown.
const GROQ_MODEL_OPTIONS = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (default - high reasoning, agentic)" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B (faster, lighter)" },
  { id: "qwen/qwen3.6-27b", label: "Qwen3.6 27B" },
];

const DEFAULT_RUBRIC = `TREES is marked out of 25 marks total, distributed as follows:
- T Thought: 0-2 marks
- R Reason: 0-3 marks
- E Evidence (from the picture/topic): 0-3 marks
- E Experience: 0-15 marks (the most heavily weighted part)
- S Suggestion: 0-2 marks

--- T Thought (0-2) ---
0 = no clear thought given
1 = simple or vague thought
2 = clear, relevant thought that answers the question directly

--- R Reason (0-3) ---
0 = no reason given
1 = vague or weak reason
2 = relevant reason but with limited explanation
3 = clear, relevant reason with some elaboration

--- E Evidence from picture/topic (0-3) ---
0 = no reference to the picture or topic
1 = mentions the picture vaguely
2 = identifies a relevant detail from the picture or topic
3 = uses a specific detail and explains how it supports the answer

--- E Experience (0-15) ---
This is the main focus of the rubric. Do NOT reward length alone - reward
specific, believable, relevant personal details. A long but generic or
memorised-sounding answer should score LOW. Break this into 5 sub-criteria
and sum them for the Experience total:

1. Relevance to the topic/question (0-2)
   0 = missing or unrelated, 1 = weakly related, 2 = clearly relevant

2. Specificity using 5W1H details (0-6) - award up to 1 mark each for clear:
   Who was involved / What happened / When it happened / Where it happened /
   Why it happened or why the pupil acted / How it ended or was resolved

3. Authenticity / personal voice (0-3)
   0 = no personal experience or clearly copied/generic
   1 = some personal reference but mostly generic
   2 = sounds mostly personal and believable
   3 = sounds authentic and natural, with realistic details, feelings or reactions
   Look for: first-person language (I/my/we), natural small believable details,
   realistic Singapore settings (void deck, MRT, canteen, CCA), genuine feelings.

4. Clarity and sequence (0-2)
   0 = confusing or incomplete, 1 = understandable but jumps around,
   2 = clearly sequenced with a beginning, middle and ending

5. Reflection / lesson learnt (0-2)
   0 = no reflection, 1 = simple feeling or lesson stated,
   2 = meaningful reflection that links back to the topic

--- S Suggestion (0-2) ---
0 = no suggestion given
1 = simple or vague suggestion
2 = practical, relevant suggestion (ideally: who/what should do something + why it helps)`;

function csvEscape(val) {
  const s = val === undefined || val === null ? "" : String(val);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8", "access-control-allow-origin": "*" },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

function uid() {
  return crypto.randomUUID();
}

// ---------- NPC "Coach" content (sentence starters + teacher-set resources) ----------
// One coach entry per question (3 total per topic). Resources are manually
// set by the teacher via Teacher Tools -> Topics -> Coach fields - there is
// no AI-generated link suggestion here on purpose (an LLM can hallucinate
// plausible-looking article/video links that don't actually exist).
function sanitizeCoach(raw) {
  const entries = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const e = entries[i] || {};
    const starters = Array.isArray(e.starters) ? e.starters.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6) : [];
    const resourcesRaw = Array.isArray(e.resources) ? e.resources : [];
    const resources = [];
    for (const r of resourcesRaw) {
      const url = String((r && r.url) || "").trim();
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) continue; // never store a non-http(s) "link"
      const type = r && r.type === "video" ? "video" : "article";
      const title = String((r && r.title) || url).trim().slice(0, 200);
      resources.push({ title, url, type });
      if (resources.length >= 3) break;
    }
    out.push({ starters, resources });
  }
  return out;
}

// ---------- Password comparison / hashing ----------
// Compares two strings in constant time (relative to a fixed-length buffer)
// so a failed login attempt doesn't leak how many leading characters were
// correct via response timing.
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 32);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (i < aBytes.length ? aBytes[i] : 0) ^ (i < bBytes.length ? bBytes[i] : 0);
  }
  return diff === 0;
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(salt + ":" + password));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The teacher password is stored in KV as { salt, hash } (SHA-256), never in
// plaintext. Older deployments may still have a plain string in KV from
// before this change - if a login with that plaintext value succeeds, we
// transparently upgrade the stored value to the salted-hash format so the
// plaintext isn't left sitting in KV any longer than necessary.
async function verifyTeacherPassword(env, password) {
  const stored = await env.CCv4_DATA.get("config:teacher_password");
  if (!stored) return { ok: false, unset: true };

  let record = null;
  try {
    record = JSON.parse(stored);
  } catch (e) {
    record = null;
  }

  if (record && typeof record.salt === "string" && typeof record.hash === "string") {
    const candidateHash = await hashPassword(password, record.salt);
    return { ok: timingSafeEqualStr(candidateHash, record.hash) };
  }

  // Legacy plaintext format.
  const matches = timingSafeEqualStr(password, stored);
  if (matches) {
    await setTeacherPassword(env, password); // migrate to hashed storage
  }
  return { ok: matches };
}

async function setTeacherPassword(env, newPassword) {
  const salt = uid();
  const hash = await hashPassword(newPassword, salt);
  await env.CCv4_DATA.put("config:teacher_password", JSON.stringify({ salt, hash }));
}

async function getSession(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const raw = await env.CCv4_DATA.get(`session:${token}`);
  if (!raw) return null;
  return { token, ...JSON.parse(raw) };
}

function requireTeacher(session) {
  return session && session.role === "teacher";
}

// ---------- Vulgarity filter ----------
function scanVulgarity(text) {
  if (!text) return { clean: text || "", flagged: false, hits: [] };
  const hits = [];
  let clean = text;
  for (const word of VULGAR_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (re.test(clean)) {
      hits.push(word);
      clean = clean.replace(re, (m) => "*".repeat(m.length));
    }
  }
  return { clean, flagged: hits.length > 0, hits };
}

function scanAllParts(parts) {
  const flaggedFields = [];
  const cleaned = {};
  let anyFlag = false;
  for (const [key, val] of Object.entries(parts || {})) {
    const { clean, flagged } = scanVulgarity(val);
    cleaned[key] = clean;
    if (flagged) {
      anyFlag = true;
      flaggedFields.push(key);
    }
  }
  return { cleaned, anyFlag, flaggedFields };
}

// ---------- KV list helpers ----------
async function pushIndex(env, key, id) {
  const raw = await env.CCv4_DATA.get(key);
  const arr = raw ? JSON.parse(raw) : [];
  arr.push(id);
  await env.CCv4_DATA.put(key, JSON.stringify(arr));
}

async function removeFromIndex(env, key, id) {
  const raw = await env.CCv4_DATA.get(key);
  const arr = raw ? JSON.parse(raw) : [];
  const next = arr.filter((x) => x !== id);
  await env.CCv4_DATA.put(key, JSON.stringify(next));
}

async function ensureSeeded(env) {
  const idx = await env.CCv4_DATA.get("topics_index");
  if (idx) return;
  const ids = [];
  for (const t of SEED_TOPICS) {
    await env.CCv4_DATA.put(`topic:${t.id}`, JSON.stringify(t));
    ids.push(t.id);
  }
  await env.CCv4_DATA.put("topics_index", JSON.stringify(ids));
}

// ---------- Rubric fallback (no AI key configured) ----------
const TREES_ORDER = [
  ["T", "Thought", 2],
  ["R", "Reason", 3],
  ["E1", "Evidence", 3],
  ["E2", "Experience", 15],
  ["S", "Suggestion", 2],
];
const TREES_MAX_TOTAL = TREES_ORDER.reduce((sum, [, , max]) => sum + max, 0); // 25

const EXPERIENCE_SUB = [
  ["Relevance", 2],
  ["5W1H Specificity", 6],
  ["Authenticity / Personal Voice", 3],
  ["Clarity & Sequence", 2],
  ["Reflection / Lesson Learnt", 2],
];

// crude 5W1H / authenticity heuristics used only when no AI key is configured.
// These are deliberately strict: a pupil who just writes a lot of words with
// no real content should NOT score well offline, since this scorer has no
// real language understanding and is meant to be a conservative stand-in,
// not a generous one, while a teacher fixes the AI marking setup.
const WHO_RE = /\b(i|my|me|mother|father|mum|dad|grandmother|grandfather|friend|classmate|teacher|uncle|auntie|sister|brother|we)\b/i;
const WHEN_RE = /\b(yesterday|last\s+\w+|today|during|after|before|one\s+day|morning|afternoon|evening|weekend|recess|holiday)\b/i;
const WHERE_RE = /\b(at|in|near|school|canteen|mrt|bus|void\s+deck|park|home|classroom|market|centre|center|station)\b/i;
const WHY_RE = /\b(because|so\s+that|since|as\s+a\s+result|therefore|due\s+to)\b/i;
const HOW_RE = /\b(then|after\s+that|finally|in\s+the\s+end|eventually|so\s+i|i\s+decided|i\s+helped|i\s+felt)\b/i;
// concrete action/detail words - a rough proxy for "something specific actually
// happened" rather than a vague generic sentence padded out with filler words
const WHAT_RE = /\b(\d+|played|ran|fell|helped|broke|lost|found|won|cried|laughed|shouted|forgot|dropped|caught|fixed|built|cooked|cleaned|carried|shared|apologi[sz]ed|argued|comforted)\b/i;
const REFLECT_RE = /\b(felt|learnt|learned|realised|realized|proud|happy|taught\s+me|lesson|since\s+then)\b/i;
const SEQUENCE_RE = /\b(at\s+first|then|after\s+that|in\s+the\s+end|finally|next|later\s+on|once)\b/i;

const THOUGHT_RE = /\b(i think|in my opinion|i believe|i feel that)\b/i;
const REASON_RE = /\bbecause\b/i;
const EVIDENCE_RE = /\b(in the picture|i can see|the picture shows|this shows)\b/i;
const SUGGESTION_RE = /\b(i suggest|should|could|in future|we can|in the future)\b/i;

const STOPWORDS = new Set(["this", "that", "with", "from", "about", "your", "their", "which", "there", "would", "could", "should", "picture", "topic", "image"]);

// Pulls a handful of meaningful keywords out of the topic (title + tags) so
// the offline scorer can do a rough check for on-topic content, instead of
// only ever measuring word count.
function topicKeywords(topic) {
  const raw = [topic && topic.title, ...((topic && topic.tags) || [])].filter(Boolean).join(" ");
  const words = (raw.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

function mentionsTopic(text, keywords) {
  if (!keywords.length) return false;
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function scoreExperienceFallback(text, keywords) {
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const onTopic = mentionsTopic(text, keywords);
  const sub = {};

  // Relevance now requires BOTH enough length AND an actual mention of the
  // topic/picture - a long but completely off-topic answer no longer scores here.
  sub["Relevance"] = words >= 10 && onTopic ? 2 : (words >= 10 || onTopic) && words >= 3 ? 1 : 0;

  let whCount = 0;
  if (WHO_RE.test(text)) whCount++;
  if (WHEN_RE.test(text)) whCount++;
  if (WHERE_RE.test(text)) whCount++;
  if (WHY_RE.test(text)) whCount++;
  if (HOW_RE.test(text)) whCount++;
  if (WHAT_RE.test(text)) whCount++; // requires a concrete detail, not just length
  sub["5W1H Specificity"] = Math.min(6, whCount);

  // Authenticity now needs a real spread of WH-markers, not just "I" plus enough words.
  sub["Authenticity / Personal Voice"] = WHO_RE.test(text) && whCount >= 3 && words >= 15 ? 3 : WHO_RE.test(text) && whCount >= 2 ? 2 : WHO_RE.test(text) || words >= 10 ? 1 : 0;

  // Clarity now requires actual sequencing language - length alone no longer earns a point.
  const sequenceMatches = (text.match(new RegExp(SEQUENCE_RE, "gi")) || []).length;
  sub["Clarity & Sequence"] = sequenceMatches >= 2 ? 2 : sequenceMatches === 1 ? 1 : 0;

  // Reflection now requires both the reflective language AND enough length to be a real reflection.
  sub["Reflection / Lesson Learnt"] = REFLECT_RE.test(text) && words >= 10 ? 2 : REFLECT_RE.test(text) ? 1 : 0;

  const total = Object.values(sub).reduce((a, b) => a + b, 0);
  return { total: Math.min(15, total), sub };
}

function ruleBasedScoreTrees(parts, keywords) {
  let total = 0;
  const breakdown = [];
  for (const [key, label, max] of TREES_ORDER) {
    const text = (parts[key] || "").trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

    if (key === "E2") {
      const exp = scoreExperienceFallback(text, keywords);
      total += exp.total;
      breakdown.push({
        part: label,
        points: exp.total,
        max,
        note: words === 0 ? "This part is empty." : "Estimated with simple keyword checks (who/when/where/why/how) - not full AI marking.",
        subBreakdown: EXPERIENCE_SUB.map(([subLabel, subMax]) => ({ label: subLabel, points: exp.sub[subLabel] || 0, max: subMax })),
      });
      continue;
    }

    // Each part now needs content matching what it's actually meant to contain
    // (a thought, a reason, evidence, a suggestion) - word count alone is only
    // ever enough for partial credit, never full marks.
    let pts = 0;
    if (key === "T") {
      pts = THOUGHT_RE.test(text) && words >= 5 ? max : THOUGHT_RE.test(text) || words >= 8 ? Math.min(max, 1) : 0;
    } else if (key === "R") {
      pts = REASON_RE.test(text) && words >= 8 ? max : REASON_RE.test(text) ? Math.min(max, 2) : words >= 10 ? Math.min(max, 1) : 0;
    } else if (key === "E1") {
      const onTopic = mentionsTopic(text, keywords);
      pts = EVIDENCE_RE.test(text) && onTopic ? max : EVIDENCE_RE.test(text) || onTopic ? Math.min(max, 2) : words >= 5 ? Math.min(max, 1) : 0;
    } else {
      pts = SUGGESTION_RE.test(text) && words >= 5 ? max : SUGGESTION_RE.test(text) ? Math.min(max, 1) : 0;
    }
    total += pts;
    breakdown.push({
      part: label,
      points: pts,
      max,
      note: words === 0 ? "This part is empty." : pts >= max ? "Clear, on-topic content." : "Estimated with simple keyword checks - not full AI marking.",
    });
  }
  return { total, breakdown };
}

function ruleBasedScoreSingle(text, keywords) {
  text = text || "";
  const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const onTopic = mentionsTopic(text, keywords);
  let total = 0;
  const breakdown = [];
  for (const [key, label, max] of TREES_ORDER) {
    if (key === "E2") {
      const exp = scoreExperienceFallback(text, keywords);
      total += exp.total;
      breakdown.push({
        part: label,
        points: exp.total,
        max,
        note: "Estimated from the combined answer using keyword checks - not full AI marking.",
        subBreakdown: EXPERIENCE_SUB.map(([subLabel, subMax]) => ({ label: subLabel, points: exp.sub[subLabel] || 0, max: subMax })),
      });
      continue;
    }
    const re = key === "T" ? THOUGHT_RE : key === "R" ? REASON_RE : key === "E1" ? EVIDENCE_RE : SUGGESTION_RE;
    let pts = 0;
    if (key === "E1") {
      // evidence in a combined answer should also actually reference the topic
      pts = re.test(text) && onTopic ? max : re.test(text) || onTopic ? Math.min(max, 2) : 0;
    } else if (re.test(text)) {
      pts = max;
    } else if (words >= 25) {
      // a long combined answer with no matching phrase at all gets minimal credit
      pts = Math.min(max, 1);
    }
    total += pts;
    breakdown.push({
      part: label,
      points: pts,
      max,
      note: "Estimated from the combined answer using keyword checks - not full AI marking.",
    });
  }
  return { total, breakdown };
}

function ruleBasedScore(mode, data, topic) {
  const keywords = topicKeywords(topic);
  const result = mode === "single" ? ruleBasedScoreSingle(data.text, keywords) : ruleBasedScoreTrees(data.parts, keywords);
  return {
    total: result.total,
    max: TREES_MAX_TOTAL,
    breakdown: result.breakdown,
    feedback:
      "Automatic marking (no AI marker configured): scored with simple keyword/relevance checks, not real understanding. Ask your teacher to add an AI key for accurate marking.",
    suggestion: "Try adding a specific personal experience with who, what, when, where, why and how it ended, plus how you felt.",
  };
}

// ---------- AI marking ----------
function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "");
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.breakdown)) throw new Error("bad shape");
  return parsed;
}

function clampNumber(n, min, max) {
  const num = typeof n === "number" && isFinite(n) ? n : 0;
  return Math.min(max, Math.max(min, Math.round(num)));
}

// The AI is asked to self-report a "total", but models occasionally return a
// total that doesn't match the sum of their own breakdown, or sub-scores that
// exceed their stated max. Rather than trust the model's arithmetic, we
// re-derive every number from the breakdown it gave us, clamping each part
// to its rubric max. This also normalizes shape (missing/malformed parts,
// missing notes, etc.) so a slightly-off AI response can't crash rendering
// or silently distort a pupil's score.
function normalizeAiResult(raw, markedBy) {
  const rawBreakdown = Array.isArray(raw.breakdown) ? raw.breakdown : [];
  const normalized = [];
  let total = 0;
  for (const [key, label, max] of TREES_ORDER) {
    const part = rawBreakdown.find((b) => b && b.part === label) || {};
    if (key === "E2") {
      const rawSub = Array.isArray(part.subBreakdown) ? part.subBreakdown : [];
      const subBreakdown = EXPERIENCE_SUB.map(([subLabel, subMax]) => {
        const sub = rawSub.find((s) => s && s.label === subLabel) || {};
        return { label: subLabel, points: clampNumber(sub.points, 0, subMax), max: subMax };
      });
      const subTotal = subBreakdown.reduce((sum, s) => sum + s.points, 0);
      total += subTotal;
      normalized.push({
        part: label,
        points: subTotal,
        max,
        note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
        subBreakdown,
      });
      continue;
    }
    const pts = clampNumber(part.points, 0, max);
    total += pts;
    normalized.push({
      part: label,
      points: pts,
      max,
      note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
    });
  }
  return {
    total,
    max: TREES_MAX_TOTAL,
    breakdown: normalized,
    feedback: typeof raw.feedback === "string" && raw.feedback.trim() ? raw.feedback.slice(0, 600) : "Marked - see the breakdown below for details.",
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion.slice(0, 300) : "",
    markedBy,
  };
}

function buildPrompts(topic, question, mode, data, rubricText) {
  const modeInstruction =
    mode === "single"
      ? `The pupil's answer below is ONE continuous piece of spoken text - it is NOT split into labelled parts. Read it carefully and identify each TREES component (Thought, Reason, Evidence, Experience, Suggestion) wherever it appears in the text, even if the pupil blends parts together or states them out of order, then mark each part using the same rubric. If a component is genuinely absent from their answer, score that part 0.`
      : `The pupil's answer below IS already split into 5 labelled parts. Mark each part as given.`;

  const system = `You are a supportive but honest Primary School English oral examiner in Singapore, marking a pupil's spoken response using the TREES framework (Thought, Reason, Evidence, Experience, Suggestion).

Marking rubric (set by the teacher), out of 25 marks total:
${rubricText}

${modeInstruction}

Be encouraging in tone, age-appropriate for a 9-12 year old. For the Experience part specifically, you MUST score and return the 5 sub-criteria (Relevance 0-2, 5W1H Specificity 0-6, Authenticity/Personal Voice 0-3, Clarity & Sequence 0-2, Reflection/Lesson Learnt 0-2) and their sum must equal the Experience "points" value. Do not reward length alone anywhere - reward specific, believable, relevant detail.
Give ONE concrete, actionable suggestion for improvement per weak part in that part's "note".
Also give one overall suggestion on how to make a future personal experience answer stronger.
Respond with ONLY valid JSON, no markdown fences, no preamble, no explanation before or after, matching exactly this shape:
{
  "breakdown": [
    { "part": "Thought", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Reason", "points": 0, "max": 3, "note": "short comment, max 25 words" },
    { "part": "Evidence", "points": 0, "max": 3, "note": "short comment, max 25 words" },
    { "part": "Experience", "points": 0, "max": 15, "note": "short comment, max 25 words",
      "subBreakdown": [
        { "label": "Relevance", "points": 0, "max": 2 },
        { "label": "5W1H Specificity", "points": 0, "max": 6 },
        { "label": "Authenticity / Personal Voice", "points": 0, "max": 3 },
        { "label": "Clarity & Sequence", "points": 0, "max": 2 },
        { "label": "Reflection / Lesson Learnt", "points": 0, "max": 2 }
      ]
    },
    { "part": "Suggestion", "points": 0, "max": 2, "note": "short comment, max 25 words" }
  ],
  "total": 0,
  "max": 25,
  "feedback": "2-3 encouraging sentences summarising strengths and one thing to work on, max 60 words",
  "suggestion": "one concrete practical tip to improve their next experience answer, max 30 words"
}`;

  const content =
    mode === "single"
      ? (data.text || "").trim() || "(left blank)"
      : TREES_ORDER.map(([key, label]) => `${label}: ${(data.parts[key] || "").trim() || "(left blank)"}`).join("\n");

  const user = `Topic: ${topic ? topic.title : "General"}
Examiner question: ${question || "Tell me about this topic."}

Pupil's answer (${mode === "single" ? "single combined response" : "TREES, split into parts"}):
${content}`;

  return { system, user };
}

// ---------- Provider: Groq (main marker, https://console.groq.com) ----------
async function callGroq(env, system, user, model) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + env.GROQ_API_KEY,
    },
    body: JSON.stringify({
      // Model is teacher-configurable from Settings (config:model_groq in
      // KV), defaulting to DEFAULT_GROQ_MODEL if never set. If Groq
      // deprecates the default, update DEFAULT_GROQ_MODEL / GROQ_MODEL_OPTIONS
      // above (see console.groq.com/docs/deprecations).
      model: model || DEFAULT_GROQ_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      reasoning_effort: "low", // this task doesn't need heavy reasoning - keeps latency down
      temperature: 0.4,
    }),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("Groq API error", resp.status, bodyText.slice(0, 500));
    throw new Error("Groq API error " + resp.status);
  }
  const data = await resp.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("Groq: empty response");
  return extractJson(text);
}

// ---------- Provider: Google Gemini (2nd marker, https://aistudio.google.com/apikey) ----------
async function callGemini(env, system, user) {
  const model = "gemini-2.5-flash"; // fast + cheap, generous free tier
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
        },
      }),
    }
  );
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("Gemini API error", resp.status, bodyText.slice(0, 500));
    throw new Error("Gemini API error " + resp.status);
  }
  const data = await resp.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const text = parts && parts[0] && parts[0].text;
  if (!text) throw new Error("Gemini: empty response");
  return extractJson(text);
}

// ---------- Provider: Cloudflare Workers AI (3rd marker, free, built into this Worker) ----------
async function callWorkersAI(env, system, user) {
  const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; // confirmed active, not on Cloudflare's deprecation list as of Aug 2026
  let result;
  try {
    result = await env.AI.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    });
  } catch (e) {
    console.error("Workers AI call error", e && e.message);
    throw e;
  }
  const text = typeof result === "string" ? result : result.response;
  if (!text) throw new Error("Workers AI: empty response");
  return extractJson(text);
}

// ---------- AI marking: Groq -> Gemini -> Workers AI -> rule-based (offline) ----------
async function aiScore(env, topic, question, mode, data) {
  const storedRubric = await env.CCv4_DATA.get("config:rubric");
  const rubricText = (storedRubric && storedRubric.trim()) || DEFAULT_RUBRIC;
  const storedGroqModel = await env.CCv4_DATA.get("config:model_groq");
  const groqModel = (storedGroqModel && storedGroqModel.trim()) || DEFAULT_GROQ_MODEL;
  const { system, user } = buildPrompts(topic, question, mode, data, rubricText);

  const attempts = [];
  if (env.GROQ_API_KEY) attempts.push({ name: "groq", run: () => callGroq(env, system, user, groqModel) });
  if (env.GEMINI_API_KEY) attempts.push({ name: "gemini", run: () => callGemini(env, system, user) });
  if (env.AI) attempts.push({ name: "workers-ai", run: () => callWorkersAI(env, system, user) });

  for (const attempt of attempts) {
    try {
      const raw = await attempt.run();
      return normalizeAiResult(raw, attempt.name);
    } catch (e) {
      // this provider failed or errored - try the next one in the chain
    }
  }
  return { ...ruleBasedScore(mode, data, topic), markedBy: "fallback" };
}

// ---------- Router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type,authorization",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        },
      });
    }

    await ensureSeeded(env);

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(PAGE_HTML, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    if (!pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    try {
      // ---------- AUTH ----------
      if (pathname === "/api/login" && request.method === "POST") {
        const body = await request.json();
        let name = (body.name || "").trim();
        if (!name) return badRequest("Please enter a name.");
        if (name.length > 40) name = name.slice(0, 40);
        const { clean, flagged } = scanVulgarity(name);
        name = clean;

        if (name.toLowerCase() === TEACHER_USERNAME) {
          // Teacher path requires a password on a second step; issue a "pending" marker only.
          return json({ requiresTeacherPassword: true });
        }

        const token = uid();
        await env.CCv4_DATA.put(
          `session:${token}`,
          JSON.stringify({ name, role: "pupil", createdAt: Date.now() }),
          { expirationTtl: 60 * 60 * 6 }
        );
        if (flagged) {
          // still let them in, but keep name masked
        }
        return json({ token, name, role: "pupil" });
      }

      if (pathname === "/api/teacher/login" && request.method === "POST") {
        const body = await request.json();
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";
        if (username !== TEACHER_USERNAME) return json({ error: "Not authorised." }, 403);

        const verdict = await verifyTeacherPassword(env, password);
        if (verdict.unset) {
          return json(
            { error: "No teacher password has been set up yet. Ask an admin to run: wrangler kv:key put --binding=CCv4_DATA \"config:teacher_password\" \"yourPassword\"" },
            500
          );
        }
        if (!verdict.ok) return json({ error: "Incorrect password." }, 403);

        const token = uid();
        await env.CCv4_DATA.put(
          `session:${token}`,
          JSON.stringify({ name: "Teacher", role: "teacher", createdAt: Date.now() }),
          { expirationTtl: 60 * 60 * 6 }
        );
        return json({ token, name: "Teacher", role: "teacher" });
      }

      // ---------- TOPICS ----------
      if (pathname === "/api/topics" && request.method === "GET") {
        const idx = JSON.parse((await env.CCv4_DATA.get("topics_index")) || "[]");
        const topics = [];
        for (const id of idx) {
          const raw = await env.CCv4_DATA.get(`topic:${id}`);
          if (raw) topics.push(JSON.parse(raw));
        }
        return json({ topics });
      }

      // ---------- SUBMIT ----------
      if (pathname === "/api/submit" && request.method === "POST") {
        const session = await getSession(request, env);
        if (!session || session.role !== "pupil") return json({ error: "Please log in first." }, 401);

        const body = await request.json();
        const { topicId, answers } = body;
        // Which questions the pupil opened the NPC Coach for, before
        // submitting (see /api/topics coach content). This is recorded for
        // the teacher but deliberately never told to the pupil - see
        // requireTeacher-gated endpoints for where it's surfaced.
        const coachUsedIn = Array.isArray(body.coachUsed) ? body.coachUsed : [];
        const mode = body.mode === "single" ? "single" : "trees";
        const practice = !!body.practice;
        if (!topicId || !Array.isArray(answers) || answers.length !== 3) {
          return badRequest("Expected a topic and exactly 3 answers.");
        }

        const topicRaw = await env.CCv4_DATA.get(`topic:${topicId}`);
        const topic = topicRaw ? JSON.parse(topicRaw) : null;
        const questions = (topic && topic.questions) || [];

        // Prepare all 3 rounds' cleaned input first (vulgarity scanning is
        // synchronous), then fire all 3 AI marking calls together instead of
        // one-at-a-time - this is the slow part of a submission (each call
        // can take a couple of seconds), so awaiting them in parallel cuts
        // total marking latency roughly 3x.
        const roundInputs = [];
        let anyFlagTotal = false;
        for (let i = 0; i < 3; i++) {
          const question = questions[i] || "Tell me about this topic.";
          const rawAnswer = answers[i] || {};
          let cleanedData, anyFlag, answerForRecord;

          if (mode === "single") {
            const scanResult = scanVulgarity(rawAnswer.text || "");
            cleanedData = { text: scanResult.clean };
            anyFlag = scanResult.flagged;
            answerForRecord = { text: scanResult.clean };
          } else {
            const scanResult = scanAllParts(rawAnswer.parts || {});
            cleanedData = { parts: scanResult.cleaned };
            anyFlag = scanResult.anyFlag;
            answerForRecord = { parts: scanResult.cleaned };
          }
          if (anyFlag) anyFlagTotal = true;
          roundInputs.push({ question, cleanedData, anyFlag, answerForRecord });
        }

        const results = await Promise.all(
          roundInputs.map((ri) => aiScore(env, topic, ri.question, mode, ri.cleanedData))
        );

        let scoreSum = 0;
        let anyFallback = false;
        const rounds = roundInputs.map((ri, i) => {
          const result = results[i];
          scoreSum += result.total;
          if (result.markedBy === "fallback") anyFallback = true;
          return {
            question: ri.question,
            mode,
            answer: ri.answerForRecord,
            score: result.total,
            max: result.max,
            breakdown: result.breakdown,
            feedback: result.feedback,
            suggestion: result.suggestion,
            flagged: ri.anyFlag,
            markedBy: result.markedBy,
            // teacher-only - stripped out of the response sent back to the
            // pupil below, and never mentioned in the pupil-facing UI
            coachUsed: !!coachUsedIn[i],
          };
        });

        const finalScore = Math.round((scoreSum / 3) * 10) / 10; // average, 1 decimal place

        const id = uid();
        const record = {
          id,
          pupilName: session.name,
          topicId,
          topicTitle: topic ? topic.title : "Unknown",
          mode,
          rounds,
          finalScore,
          maxScore: TREES_MAX_TOTAL,
          flagged: anyFlagTotal,
          practice,
          // true when at least one of the 3 questions fell all the way back
          // to the offline keyword scorer (all AI providers unavailable) -
          // this is much less rigorous than real AI marking, so a
          // non-practice attempt in this state is kept out of the
          // leaderboard rather than silently rewarding a marking outage.
          gradingDegraded: anyFallback,
          createdAt: Date.now(),
        };
        await env.CCv4_DATA.put(`submission:${id}`, JSON.stringify(record));
        await pushIndex(env, "submissions_index", id);

        const countsForLeaderboard = !practice && !anyFallback;
        if (countsForLeaderboard) {
          // update pupil aggregate (leaderboard) - practice attempts, and
          // attempts marked entirely offline, never count
          const pupilRaw = await env.CCv4_DATA.get(`pupil:${session.name}`);
          const pupil = pupilRaw ? JSON.parse(pupilRaw) : { name: session.name, bestScore: 0, totalScore: 0, attempts: 0 };
          pupil.attempts += 1;
          pupil.totalScore += finalScore;
          pupil.bestScore = Math.max(pupil.bestScore, finalScore);
          await env.CCv4_DATA.put(`pupil:${session.name}`, JSON.stringify(pupil));
        }

        let warning = null;
        if (anyFlagTotal && anyFallback) {
          warning = "Some words were filtered out, and AI marking wasn't available for at least one question so this attempt won't count on the leaderboard.";
        } else if (anyFlagTotal) {
          warning = "Some words were filtered out. Please keep your answers respectful.";
        } else if (anyFallback) {
          warning = "AI marking wasn't available for at least one question, so this attempt was scored with a simple offline check and won't count on the leaderboard.";
        }

        // `record` (with coachUsed per round) is what's stored in KV and
        // shown to the teacher. The pupil only ever sees `pupilRecord`,
        // which has coachUsed stripped out - pupils are not told that
        // opening the NPC Coach is tracked.
        const pupilRecord = {
          ...record,
          rounds: record.rounds.map((r) => {
            const { coachUsed, ...rest } = r;
            return rest;
          }),
        };
        return json({ record: pupilRecord, warning });
      }

      // ---------- LEADERBOARD ----------
      if (pathname === "/api/leaderboard" && request.method === "GET") {
        // Pupil names + scores are only for people who are actually in the
        // class session - this must not be reachable by anyone who just has
        // the .workers.dev URL.
        const session = await getSession(request, env);
        if (!session) return json({ error: "Please log in first." }, 401);
        const idx = JSON.parse((await env.CCv4_DATA.get("submissions_index")) || "[]");
        const pupilsSeen = new Map();
        // aggregate best score per pupil for a clean leaderboard
        const names = new Set();
        for (const id of idx) names.add(id); // noop just to keep var used
        const listKeys = idx;
        const pupilNames = new Set();
        for (const subId of listKeys) {
          const raw = await env.CCv4_DATA.get(`submission:${subId}`);
          if (!raw) continue;
          const s = JSON.parse(raw);
          pupilNames.add(s.pupilName);
        }
        const board = [];
        for (const name of pupilNames) {
          const raw = await env.CCv4_DATA.get(`pupil:${name}`);
          if (raw) board.push(JSON.parse(raw));
        }
        board.sort((a, b) => b.bestScore - a.bestScore || b.totalScore - a.totalScore);
        return json({ leaderboard: board.slice(0, 50) });
      }

      // =========== TEACHER-ONLY ROUTES BELOW ===========
      const session = await getSession(request, env);

      if (pathname === "/api/teacher/submissions" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const idx = JSON.parse((await env.CCv4_DATA.get("submissions_index")) || "[]");
        const total = idx.length;
        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        const offsetParam = parseInt(url.searchParams.get("offset"), 10);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
        const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;
        // newest-first, one page at a time - avoids loading a whole term's
        // worth of submissions into memory on every teacher page load
        const page = idx.slice().reverse().slice(offset, offset + limit);
        const items = [];
        for (const id of page) {
          const raw = await env.CCv4_DATA.get(`submission:${id}`);
          if (raw) items.push(JSON.parse(raw));
        }
        return json({ submissions: items, total, offset, limit, hasMore: offset + limit < total });
      }

      if (pathname === "/api/teacher/submissions/export" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const idx = JSON.parse((await env.CCv4_DATA.get("submissions_index")) || "[]");
        const rows = [];
        rows.push(
          [
            "id",
            "pupilName",
            "topicTitle",
            "mode",
            "practice",
            "finalScore",
            "maxScore",
            "flagged",
            "gradingDegraded",
            "createdAt",
            "Q1_question",
            "Q1_answer",
            "Q1_score",
            "Q1_coachUsed",
            "Q2_question",
            "Q2_answer",
            "Q2_score",
            "Q2_coachUsed",
            "Q3_question",
            "Q3_answer",
            "Q3_score",
            "Q3_coachUsed",
          ]
            .map(csvEscape)
            .join(",")
        );
        for (const id of idx) {
          const raw = await env.CCv4_DATA.get(`submission:${id}`);
          if (!raw) continue;
          const s = JSON.parse(raw);
          const rounds = s.rounds || [];
          const roundCols = [];
          for (let i = 0; i < 3; i++) {
            const r = rounds[i];
            if (!r) {
              roundCols.push("", "", "", "");
              continue;
            }
            const answerText =
              r.mode === "single"
                ? (r.answer && r.answer.text) || ""
                : ["T", "R", "E1", "E2", "S"]
                    .map((k) => (r.answer && r.answer.parts && r.answer.parts[k]) || "")
                    .join(" | ");
            roundCols.push(r.question || "", answerText, r.score, r.coachUsed ? "yes" : "no");
          }
          rows.push(
            [
              s.id,
              s.pupilName,
              s.topicTitle,
              s.mode,
              s.practice ? "yes" : "no",
              s.finalScore,
              s.maxScore,
              s.flagged ? "yes" : "no",
              s.gradingDegraded ? "yes" : "no",
              new Date(s.createdAt).toISOString(),
              ...roundCols,
            ]
              .map(csvEscape)
              .join(",")
          );
        }
        const csv = rows.join("\r\n");
        return new Response(csv, {
          status: 200,
          headers: {
            "content-type": "text/csv;charset=UTF-8",
            "content-disposition": 'attachment; filename="just-a-chit-chat-submissions.csv"',
            "access-control-allow-origin": "*",
          },
        });
      }

      if (pathname === "/api/teacher/rubric" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const stored = await env.CCv4_DATA.get("config:rubric");
        return json({ rubric: stored || DEFAULT_RUBRIC, isDefault: !stored });
      }

      if (pathname === "/api/teacher/rubric" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const rubric = (body.rubric || "").trim();
        if (!rubric) {
          await env.CCv4_DATA.delete("config:rubric"); // reset to default
          return json({ ok: true, rubric: DEFAULT_RUBRIC, isDefault: true });
        }
        await env.CCv4_DATA.put("config:rubric", rubric);
        return json({ ok: true, rubric, isDefault: false });
      }

      if (pathname === "/api/teacher/model-groq" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const stored = await env.CCv4_DATA.get("config:model_groq");
        return json({ model: stored || DEFAULT_GROQ_MODEL, isDefault: !stored, options: GROQ_MODEL_OPTIONS });
      }

      if (pathname === "/api/teacher/model-groq" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const model = (body.model || "").trim();
        if (!model) {
          await env.CCv4_DATA.delete("config:model_groq"); // reset to default
          return json({ ok: true, model: DEFAULT_GROQ_MODEL, isDefault: true });
        }
        await env.CCv4_DATA.put("config:model_groq", model);
        return json({ ok: true, model, isDefault: false });
      }

      if (pathname.startsWith("/api/teacher/submissions/") && request.method === "DELETE") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        await env.CCv4_DATA.delete(`submission:${id}`);
        await removeFromIndex(env, "submissions_index", id);
        return json({ ok: true });
      }

      if (pathname.startsWith("/api/teacher/submissions/") && request.method === "PUT") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        const raw = await env.CCv4_DATA.get(`submission:${id}`);
        if (!raw) return json({ error: "Not found." }, 404);
        const existing = JSON.parse(raw);
        const body = await request.json();
        const updated = { ...existing, ...body, id };
        await env.CCv4_DATA.put(`submission:${id}`, JSON.stringify(updated));
        return json({ record: updated });
      }

      if (pathname === "/api/teacher/leaderboard/reset" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json().catch(() => ({}));
        if (body.name) {
          await env.CCv4_DATA.delete(`pupil:${body.name}`);
        } else {
          const idx = JSON.parse((await env.CCv4_DATA.get("submissions_index")) || "[]");
          for (const id of idx) {
            const raw = await env.CCv4_DATA.get(`submission:${id}`);
            if (!raw) continue;
            const s = JSON.parse(raw);
            await env.CCv4_DATA.delete(`pupil:${s.pupilName}`);
          }
        }
        return json({ ok: true });
      }

      if (pathname === "/api/teacher/topics" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const id = body.id || uid();
        const topic = {
          id,
          title: (body.title || "Untitled topic").trim(),
          imageUrl: (body.imageUrl || "").trim(),
          questions: Array.isArray(body.questions) ? body.questions.filter(Boolean) : [],
          tags: Array.isArray(body.tags) ? body.tags : [],
          coach: sanitizeCoach(body.coach),
        };
        const isNew = !(await env.CCv4_DATA.get(`topic:${id}`));
        await env.CCv4_DATA.put(`topic:${id}`, JSON.stringify(topic));
        if (isNew) await pushIndex(env, "topics_index", id);
        return json({ topic });
      }

      if (pathname.startsWith("/api/teacher/topics/") && request.method === "DELETE") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        await env.CCv4_DATA.delete(`topic:${id}`);
        await removeFromIndex(env, "topics_index", id);
        return json({ ok: true });
      }

      if (pathname === "/api/teacher/password" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const newPassword = (body.newPassword || "").trim();
        if (newPassword.length < 6) return badRequest("Password should be at least 6 characters.");
        await setTeacherPassword(env, newPassword);
        return json({ ok: true });
      }

      return json({ error: "Not found." }, 404);
    } catch (err) {
      return json({ error: "Server error: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};
