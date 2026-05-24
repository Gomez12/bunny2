# Working with chat

bunny2's per-layer chat is an assistant that answers questions
about **your own data**: the companies, contacts, calendar events,
and todos you have access to inside the current layer. This guide
explains how to open a conversation, how feedback works, and what
the chat board shows.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/chat-pipeline.md` and the retrieval
> contract in `docs/dev/architecture/retrieval.md`.

---

## 1. What the chat does

When you ask a question, bunny2:

1. Figures out what kind of information you're asking about
   (a meeting? a contact? a todo?).
2. Pulls the matching rows from the entities you can see in this
   layer — never anything from a layer you don't have access to.
3. Streams an answer based **only** on those rows. If nothing
   matched, the assistant will say so rather than make something
   up.

Three LLM calls happen per question (router, resolver, answerer);
retrieval itself is a plain database lookup and costs no LLM
tokens. The board (see §5) shows each step as it runs.

---

## 2. Opening a conversation

The chat lives **inside** a layer. Open it from the layer's
navigation:

1. Switch to the layer where your data lives (the layer switcher
   in the app header).
2. Click **Chat** in the layer navigation. The path is
   `/l/<your-layer-slug>/chat`.
3. The page has three areas:
   - **Left**: your existing conversations in this layer, newest
     first.
   - **Center**: the active thread.
   - **Bottom**: the composer where you type the next message.

Click **New conversation** in the conversation list to start a
fresh thread. The title is set from the first 60 characters of
your first message; you can soft-delete a conversation from the
trash icon in the list (the underlying data stays in the database
so a site administrator can recover it).

### Switching layers switches conversations

A conversation belongs to **one layer**. If you switch to a
different layer, you'll see that layer's conversations — not the
ones from the layer you left. There is no cross-layer thread, by
design: the assistant should never accidentally answer a question
in one layer with data from another.

If you bookmark a chat URL and later lose access to that layer,
bunny2 routes you back to your personal layer with a brief notice.

---

## 3. Asking a question

Type into the composer at the bottom of the thread and press
**Enter** to send. **Shift+Enter** adds a newline. The send
button works the same.

Examples that work well in v1:

- "When is my Acme strategy meeting?"
- "Who do I know at AMI?"
- "What todos are due this week?"
- "Did I save a phone number for John?"

What you'll see while the assistant works:

1. Your message appears immediately, on the right.
2. A new assistant bubble appears on the left with a small status
   line ("thinking…", "looking up entities…", "writing…").
3. Tokens stream into the bubble as the assistant writes the
   answer.
4. When the answer is complete, the status disappears and the
   thumbs up / down buttons appear underneath.

If the connection drops mid-answer, the partial answer is saved
and the bubble shows a localized error message. Re-ask the
question.

### What the assistant won't do (yet)

Phase 6 chat **reads** your data. It does not yet **change** your
data — a question like "schedule a meeting with AMI next Tuesday"
will be recognized but answered with a polite "not yet supported".
The recognition is recorded so future phases can mine those gaps;
your data is unaffected.

---

## 4. Thumbs up and thumbs down

Under every assistant message, two buttons:

- **Thumbs up** — the answer was useful. One click; click again to
  remove the rating.
- **Thumbs down** — the answer was wrong, incomplete, or
  unhelpful. A short dialog asks for an optional reason — one or
  two sentences is plenty. You can save it without a reason if you
  prefer.

A message can have **one** rating per user. Re-rating overwrites
the previous one (up replaces down, or vice versa). Ratings
persist across reloads and across layer switches.

The reason text on thumbs-down is stored alongside the rating and
shown to administrators / site owners to improve the assistant.
Don't put sensitive personal data into the reason — short notes
like "wrong date" or "missed the AMI contact" are exactly the
right shape.

---

## 5. The chat board

Open `/l/<your-layer-slug>/chat/board` to see a **Kanban view** of
recent messages. Each card is one assistant message, moving
through the columns as the pipeline runs:

```
queued → intent → entities → retrieval → answering → done
                                                      └── failed
```

What the columns mean (using a single question as the example):

- **queued** — the message landed; the pipeline hasn't started.
- **intent** — the router is figuring out what kind of question
  this is.
- **entities** — the resolver is picking which entity kinds to
  look in.
- **retrieval** — the lookup is running. No LLM call happens here;
  this column is usually fast.
- **answering** — the assistant is writing the response.
- **done** — the answer is complete.
- **failed** — something went wrong. The card carries an error
  hint.

Click a card to jump back to the conversation thread for that
message.

Why this exists: the chat assistant is doing several things per
question, and the board makes the working state visible. If a
particular kind of question keeps landing in **failed**, the
board is the fastest way to spot the pattern.

---

## 6. Recent conversations widget

On the layer dashboard, the **Recent chats** widget shows up to
five of your most recent conversations in the current layer, each
with a small thumbs-up / thumbs-down ratio. Click any row to open
that conversation.

The widget is per-layer and per-user, mirroring the chat itself.

---

## 7. Privacy and data scope

A few things worth knowing:

- The assistant only ever sees entity rows you can see in the
  current layer. It does not have ambient access to a wider
  catalogue.
- Your messages, the assistant's answers, your thumbs ratings, and
  their reasons are stored in the bunny2 database. They are not
  sent to third-party analytics. If an external LLM provider is
  configured (instead of the built-in mock), the answerer prompt
  and the LLM's reply travel to that provider — same path as the
  rest of bunny2's LLM features. Ask your administrator which
  provider is in use.
- Soft-deleting a conversation hides it from the list. Site
  administrators can recover deleted conversations from the
  database; through the UI the deletion is permanent.
- Soft-deleting an underlying entity (a calendar event, a contact)
  removes it from the assistant's reach immediately — the
  assistant cannot answer about hidden rows.

---

## 8. When things don't work

- **"I couldn't find anything matching that"** — the LIKE search
  used in v1 is literal. Try the actual noun ("AMI", not "the AMI
  thing").
- **The board card is stuck in `failed`** — the answer's status
  line carries the error key. The most common cases are an
  upstream LLM hiccup (re-ask) or a network drop mid-stream
  (re-ask).
- **Thumbs-down saved but the message hasn't improved** — the
  feedback is data for the people improving the assistant; it
  doesn't retrain the assistant in real time.
- **A conversation disappeared** — you soft-deleted it, or a site
  administrator did. Ask an administrator if you need it back.

---

## 9. Related reading

- [`working-with-layers.md`](./working-with-layers.md) — what a
  layer is and how access works.
- [`scheduled-tasks.md`](./scheduled-tasks.md) — the background
  jobs that keep the chat corpus and history in shape
  (`chat.embeddings.backfill`, `chat.runs.prune`).
- `getting-started.md` — first launch and your personal layer.
