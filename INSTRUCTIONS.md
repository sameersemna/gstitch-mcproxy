# 🧩 Google Stitch MCP Tools (`local/stitch`)

### 📦 Project Management

- **create_project**
  Creates a new Stitch project (container for UI designs)

- **get_project**
  Retrieves details of a specific project

- **list_projects**
  Lists all accessible Stitch projects

---

### 🎨 Design System

- **create_design_system**
  Creates a design system for a project

- **apply_design_system**
  Applies a design system to a list of screens

- **update_design_system**
  Updates an existing design system

- **list_design_systems**
  Lists all design systems in a project

---

### 🖼️ Screens / UI

- **create_screen**
  Creates a new screen inside a project

- **get_screen**
  Retrieves details of a specific screen

- **list_screens**
  Lists all screens in a project

- **edit_screens**
  Edits existing screens using text instructions

---

### 🤖 AI Generation / Transformation

- **generate_screen_from_text**
  Generates a new screen from a text prompt

- **generate_variants**
  Generates variations of existing screens

---

# 🧠 Mental Model (Very Important)

You can think of Stitch MCP like this:

```
Project
 ├── Design Systems
 └── Screens
       ├── Generated
       ├── Edited
       └── Variants
```

---

# 🔥 Practical Usage Mapping

| Goal                   | Tool                      |
| ---------------------- | ------------------------- |
| Start a new app design | create_project            |
| Define visual style    | create_design_system      |
| Apply style globally   | apply_design_system       |
| Generate UI from idea  | generate_screen_from_text |
| Modify UI              | edit_screens              |
| Explore screens        | list_screens              |
| Fetch specific UI      | get_screen                |
| Create variations      | generate_variants         |

---

# ⚠️ Important Observations

- There is **no direct "delete" tool** (so edits must be controlled)
- `edit_screens` is **very powerful** (can reshape UI via text)
- `generate_screen_from_text` is your **primary creation tool**
- `generate_variants` is great for **A/B or refinement**

---

# 🔑 Project ID — How to Provide It

This proxy **does not** read the project ID from request headers. Whenever you call a tool that needs a project, pass it explicitly via the `arguments` object:

```json
{
  "name": "list_screens",
  "arguments": { "projectId": "<the-project-id>" }
}
```

**As an assistant, when the user tells you the project ID in chat, thread it into every relevant tool call's `arguments.projectId`.** Do not assume the proxy will inject it from the environment — only do that if the user has set `STITCH_PROJECT_ID` in the server's `.env`.

The API key (`STITCH_API_KEY`) is still passed via the MCP client headers — that part is handled outside this tool protocol.

---

# 🔁 When a Call Fails — Read This Before Retrying

The proxy protects your **generation quota**. It will not silently repeat a call that creates or
edits something, because Stitch may already have done the work.

## Error code `-32008` — outcome unknown

> "Outcome unknown: the request may have been applied by Stitch before the connection failed."

This happens when the connection dropped _after_ the request was sent. **Do not** fire a
different-but-equivalent call — that creates a second project or screen.

Correct response:

1. Check the current state with a read-only tool:
   - `list_projects` — was the project created?
   - `list_screens` with `arguments.projectId` — was a screen generated?
   - `get_project` / `get_screen` for details.
2. If the work **did** happen, use the result you found; do not regenerate.
3. If it did **not** happen, retry the **identical** call — same tool, same arguments. The proxy
   replays the stored result instead of starting a second generation.

## Error code `-32004` — still running

> "Upstream request is still running after …ms. It was not cancelled: retry the identical call to
> collect its result."

The generation is **still in progress** on Stitch. Wait, then retry the **identical** call — the
result is stored and will be returned to you rather than regenerated.

## Error code `-32009` — proxy busy

> "Proxy is at its upstream concurrency limit. Retry shortly."

Transient. Wait for the `Retry-After` interval, then retry the identical call.

## Rules of thumb

- **Never** replace a failed call with a "close enough" call. `create_project` → `create_project`;
  never `create_project` → `create_screen`.
- **Always** prefer the identical retry over a new generation.
- For a deliberate second artefact, that is fine — but do it knowingly, and expect the proxy to run
  it because a delivered result is not replayed without an explicit idempotency key.
- Read-only tools (`list_*`, `get_*`) are always safe to retry freely.
