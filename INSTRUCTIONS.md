# 🧩 Google Stitch MCP Tools (`local/stitch`)

### 📦 Project Management

* **create_project**
  Creates a new Stitch project (container for UI designs)

* **get_project**
  Retrieves details of a specific project

* **list_projects**
  Lists all accessible Stitch projects

---

### 🎨 Design System

* **create_design_system**
  Creates a design system for a project

* **apply_design_system**
  Applies a design system to a list of screens

* **update_design_system**
  Updates an existing design system

* **list_design_systems**
  Lists all design systems in a project

---

### 🖼️ Screens / UI

* **create_screen**
  Creates a new screen inside a project

* **get_screen**
  Retrieves details of a specific screen

* **list_screens**
  Lists all screens in a project

* **edit_screens**
  Edits existing screens using text instructions

---

### 🤖 AI Generation / Transformation

* **generate_screen_from_text**
  Generates a new screen from a text prompt

* **generate_variants**
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

* There is **no direct "delete" tool** (so edits must be controlled)
* `edit_screens` is **very powerful** (can reshape UI via text)
* `generate_screen_from_text` is your **primary creation tool**
* `generate_variants` is great for **A/B or refinement**

---
