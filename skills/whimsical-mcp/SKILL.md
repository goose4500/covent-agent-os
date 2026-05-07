---
name: whimsical-mcp
description: >-
  Use this skill whenever the user wants to work with Whimsical from Pi:
  creating or editing Whimsical boards, diagrams, flowcharts, mind maps,
  wireframes, docs, folders, searching or reading a Whimsical workspace,
  turning code/specs/processes into Whimsical visuals, or asking what
  Whimsical MCP tools do. This skill explains each Whimsical MCP tool from
  first principles and gives the correct tool-selection workflow.
compatibility: >-
  Requires pi-mcp-adapter with the `whimsical` MCP server configured and
  authenticated.
---

# Whimsical MCP

Use this skill as the operating manual for Whimsical inside Pi.

## First principles

Whimsical MCP gives the agent a controlled API into a Whimsical workspace. Think in these layers:

1. **Workspace** — the account/workspace boundary. Use `whimsical_list_workspaces` when the target workspace is unclear. A `member` can create/edit; a `guest` is read-only.
2. **Folder / parent** — where new files go. Use `whimsical_file_tree` to find folder IDs. Most create tools accept `parent_id`; if omitted, they create in Private/default space.
3. **File** — usually a board, doc, or folder. Creation returns a file ID and URL. Reading/editing uses that ID.
4. **Board objects and groups** — shapes, text, notes, connectors, tables, wireframes, mindmaps, flowcharts, sequence diagrams. Editing normally requires object IDs, so fetch before editing.
5. **Semantic vs spatial creation**:
   - Use **semantic auto-layout** tools when the user describes structure: flowchart, mind map, sequence diagram, wireframe, sticky notes.
   - Use **freeform board** creation when absolute positions matter: sketches, photographed whiteboards, hand-drawn notes, lecture notes, circuits, molecule diagrams, or any layout where left/right/top/bottom placement is meaningful.
6. **Docs** are markdown documents, not boards. Use `whimsical_doc_create` or doc operations through `whimsical_edit`.

In Pi, Whimsical tools are MCP tools. Invoke them through the `mcp` proxy unless direct tools are enabled:

```text
mcp({ connect: "whimsical" })
mcp({ tool: "whimsical_search", args: "{\"query\":\"auth flow\"}" })
```

`args` is a JSON string.

## Default workflow

1. **Connect if needed**: `mcp({ connect: "whimsical" })`.
2. **Select workspace/folder if relevant**:
   - `whimsical_list_workspaces` for workspace IDs.
   - `whimsical_file_tree` for folders/sections.
3. **Inspect existing content before changing it**:
   - `whimsical_search` to find files.
   - `whimsical_fetch` to read a file or object.
4. **Look up syntax before complex creation**:
   - Always call `whimsical_how_to` before flowcharts, wireframes, freeform boards, or advanced edits.
5. **Create or edit**:
   - New visual: `whimsical_create` or a specialized generator.
   - New doc: `whimsical_doc_create`.
   - Existing file: `whimsical_edit`, `whimsical_wireframe_edit`, or `whimsical_auto_layout`.
6. **Verify**:
   - Fetch the result. Use `image: true` for a visual snapshot, or `detail: "detailed"` / `expand_groups: true` for object-level inspection.

For destructive edits or broad changes, explain the intended operation briefly before calling edit/delete operations.

## Tool map

### `whimsical_how_to`

**Purpose:** Built-in Whimsical reference lookup. It returns syntax, schemas, examples, colors, icons, positioning rules, and editing recipes.

**Use when:** You are about to create a flowchart, wireframe, freeform board, table, or advanced edit; or you need to know available topics.

**Key parameter:**
- `topic` optional string. Omit it to list topics. Common topics: `flowchart`, `wireframe`, `board`, `edit`, `table`, `positioning`, `colors`, `icons`, `wireframe-edit`, `fetch`.

**Principle:** Do not guess Whimsical-specific DSLs. Ask `how_to` first and then emit the exact shape it documents.

---

### `whimsical_create`

**Purpose:** General creation tool for boards, folders, diagrams, tables, sticky notes, stamps, and wireframes.

**Use when:** You need to create new Whimsical content, especially when you need one tool that can create many content types.

**Important parameters:**
- `type`: `board`, `folder`, `flowchart`, `mindmap`, `sequence_diagram`, `sticky_notes`, `table`, `wireframe`, or `stamp`.
- `title`: file/item title.
- `workspace_id`: target workspace UUID.
- `parent_id`: folder/section ID.
- `board_id`: add to an existing board instead of creating a new board.
- `data`: content payload; format depends on `type`.
- `x`/`y` or `placement`: where to place content on a board.

**Principle:** Choose `type` by the user's mental model. For exact spatial layouts, use `type: "board"` with `data.items` and explicit `x`/`y`. For structure that can be auto-laid out, use flowchart/mindmap/sequence/wireframe/sticky types.

**Rules of thumb:**
- Flowcharts: call `how_to("flowchart")`; prefer structured `data.nodes` + `data.edges` over Mermaid unless the user specifically asks for Mermaid.
- Mind maps: `data.markdown` where first line is root and children are indented bullets.
- Sequence diagrams: simple arrow syntax in `data.diagram` is usually enough.
- Wireframes: call `how_to("wireframe")`; use the flexbox JSON DSL.
- Freeform boards: call `how_to("board")`; use snake_case fields like `shape_type`, `temp_id`, `from_id`, `to_id`.

---

### `whimsical_doc_create`

**Purpose:** Create a Whimsical document from markdown.

**Use when:** The desired output is written documentation, notes, specs, planning docs, or a markdown-style doc rather than a visual board.

**Parameters:**
- `title`
- `data`: markdown string
- `parent_id`
- `workspace_id`

**Principle:** Use docs for prose and structured writing. Use boards/diagrams for visual relationships.

---

### `whimsical_generate_diagram`

**Purpose:** Specialized auto-layout generator for semantic diagrams.

**Use when:** The user asks for a flowchart, mind map, sequence diagram, or sticky-note-style semantic diagram and absolute positions do not matter.

**Parameters:**
- `type`: `flowchart`, `mindmap`, `sequence_diagram`, or `sticky_notes`.
- `data`: content format varies by type.
- `title`, `board_id`, `parent_id`, `workspace_id`.

**Principle:** This is not for sketches or layouts. It turns abstract structure into a clean auto-laid-out diagram.

**Required prep:** Call `how_to("flowchart")` before flowcharts. Mind maps and simple sequence diagrams have straightforward formats and usually do not need `how_to`.

---

### `whimsical_generate_mind_map`

**Purpose:** Convenience tool for creating mind maps from indented markdown.

**Use when:** The user wants brainstorming, hierarchy, product areas, topic decomposition, or conceptual breakdowns.

**Data format:**
```text
Root Topic
- Child 1
  - Grandchild
- Child 2
```

Pass as:
```json
{"data":{"markdown":"Root\n- Child"},"title":"..."}
```

**Principle:** A mind map is a tree: one root, branches, sub-branches. Keep siblings parallel in wording.

---

### `whimsical_generate_wireframe`

**Purpose:** Generate a Whimsical wireframe using Whimsical's flexbox-style wireframe DSL.

**Use when:** The user wants a UI layout, app screen, settings page, landing page, dashboard sketch, mobile flow, or low-fidelity prototype.

**Required prep:** Always call `how_to("wireframe")` first.

**Parameters:**
- `data`: wireframe DSL layout tree.
- `title`, `board_id`, `parent_id`, `workspace_id`.

**Principle:** Wireframes are layout trees: containers define rows/columns/gaps/padding; leaf elements define UI controls like buttons, inputs, tabs, icons, dividers, placeholder shapes, and text.

---

### `whimsical_edit`

**Purpose:** Edit an existing board or doc.

**Use when:** The user asks to modify, add, remove, rename, restructure, or append to existing Whimsical content.

**Parameters:**
- `id`: board/doc ID.
- `operations`: ordered list of edit operations.

**Board operations:** `add`, `update`, `delete`, `group`, `find_replace`, `delete_by_text`.

**Doc operations:** `update_block`, `insert_after_block`, `append_blocks`, `delete_block`, `replace_content`, table operations.

**Principle:** Fetch first. Editing depends on IDs. For compound diagrams, fetch with `scope` before `find_replace`, because the board overview may only show summaries like `Root (5 nodes)`.

**Helpful details:**
- Use `temp_id` in add operations so later operations can reference newly created shapes/connectors in the same edit call.
- Add operations run before updates/deletes so temp IDs can resolve.
- Use snake_case field names.

---

### `whimsical_search`

**Purpose:** Search workspace files and content.

**Use when:** The user references an existing board/doc/folder by name or topic but does not provide an ID or URL.

**Parameters:**
- `query`: search text.
- `mode`: `files` for filenames, `all` for full content search.
- `workspace_id`.

**Principle:** Search finds candidate files; fetch reads the actual content. New files may take time to index, so fetch by returned/known ID if search misses a just-created item.

---

### `whimsical_fetch`

**Purpose:** Read boards, docs, folders, objects, or rendered board images by ID.

**Use when:** You need content, object IDs, visual verification, or scoped details before editing.

**Important parameters:**
- `id`: file/object ID.
- `detail`: `simple` or `detailed` for boards.
- `image`: true for PNG snapshot.
- `scope`: drill into a compound group like a mindmap/flowchart/sequence diagram.
- `select_kinds`, `grep_text`, `select_ids`: filters.
- `expand_groups`: flatten group contents.
- `viewport` / `crop_ids`: crop image output.

**Principle:** Fetch is the read side of Whimsical. It turns a visual board/doc into text/IDs the agent can reason about.

---

### `whimsical_file_tree`

**Purpose:** Browse folders and sections in a workspace.

**Use when:** You need to decide where to create something or understand workspace organization.

**Parameters:**
- `folder_id`: browse a specific folder/section; omit for root tree.
- `depth`: 1–5.
- `workspace_id`.

**Principle:** `parent_id` values for create tools come from the file tree.

---

### `whimsical_list_workspaces`

**Purpose:** List accessible Whimsical workspaces and roles.

**Use when:** The user has multiple workspaces, workspace is ambiguous, or a create/edit fails due to permissions.

**Parameters:** none.

**Principle:** Workspace IDs disambiguate where searches and creations happen. Role tells whether writes are allowed.

---

### `whimsical_get_board_items`

**Purpose:** Fetch raw board objects for Whimbed/widget rendering.

**Use when:** You need lower-level board object data, pagination, or selected fields for rendering/integration. For normal reading/editing, prefer `whimsical_fetch`.

**Parameters:**
- `fileId`: board file ID.
- `limit`, `offset`: pagination.
- `fields`: choose lightweight fields like `rect`, `objectType`, `text`, `fillColor`, `parentId`, `url`, or heavier graphics fields.

**Principle:** This is closer to raw rendering data than semantic board reading. Use sparingly.

---

### `whimsical_wireframe_edit`

**Purpose:** Edit or reflow an existing wireframe frame.

**Use when:** The target is specifically a wireframe and the user wants structural/layout changes rather than generic board object edits.

**Required prep:** Call `how_to("wireframe-edit")` first.

**Parameters:**
- `board_id`: board file ID.
- `target_id`: wireframe frame ID.
- `operations`: direct edits/deletes, mutually exclusive with `layout`.
- `layout`: new/changed layout tree, mutually exclusive with `operations`.
- `frame_type`, `title`.

**Principle:** Use `wireframe_edit` when the flexbox layout should reflow intelligently. Use `whimsical_edit` only for board-level additions around the wireframe.

---

### `whimsical_auto_layout`

**Purpose:** Re-arrange flowchart shapes using Whimsical's auto-layout engine.

**Use when:** You added or edited shapes/connectors and the flowchart needs cleanup.

**Parameters:**
- `board_id`.
- `parent_id`: optional group/container scope.
- `orientation`: `td`, `lr`, `bt`, `rl`.
- `spacing`: `compact` or `default`.

**Principle:** Content creation defines what exists; auto-layout improves where it sits.

---

### `whimsical_get_mcp_app`

**Purpose:** Read/open the MCP UI resource `ui://whimsical/mcp-app?v=latest`.

**Use when:** The MCP adapter or user interaction needs Whimsical's interactive MCP app/widget. It is not usually needed for normal create/search/fetch/edit tasks.

**Parameters:** none.

**Principle:** This is a UI resource, not a content operation.

## Common recipes

### Create a simple mind map

1. Optionally list workspaces.
2. Call `whimsical_create` with `type: "mindmap"` or `whimsical_generate_mind_map`.
3. Use `data.markdown` with one root and indented bullets.
4. Fetch the board to confirm.

### Create an architecture flowchart

1. Call `whimsical_how_to` with `topic: "flowchart"`.
2. Use structured `data.nodes` and `data.edges`.
3. Prefer stable node IDs like `frontend`, `api`, `db`.
4. Use groups for boundaries like VPC, subnet, services, or layers.
5. Fetch or image-check the result.

### Read and summarize an existing board

1. Search by name/topic with `whimsical_search`.
2. Fetch candidate file IDs with `whimsical_fetch`.
3. If the board contains collapsed groups, fetch again with `scope` or `expand_groups`.
4. Summarize from fetched text, preserving IDs if edits may follow.

### Edit an existing board safely

1. Fetch with `detail: "detailed"` and, if needed, `expand_groups: true`.
2. Identify exact object/group IDs.
3. Use `whimsical_edit` operations.
4. For compound diagrams, use `scope` first and prefer `find_replace` / `delete_by_text` when appropriate.
5. Fetch again to verify.

### Create a wireframe

1. Call `whimsical_how_to` with `topic: "wireframe"`.
2. Build a flexbox layout tree: containers (`direction`, `gap`, `padding`, `children`) and leaf UI elements.
3. Use `text` for readable headings; avoid using placeholder-only elements when actual text matters.
4. Create with `whimsical_generate_wireframe` or `whimsical_create` type `wireframe` as the tool schema allows.
5. Use `whimsical_wireframe_edit` for structural changes later.

## Practical guardrails

- Do not hallucinate IDs. Get them from `create`, `search`, `file_tree`, or `fetch`.
- Do not invent connectors when recreating sketches. Only draw connectors the user/source actually implies.
- Use `placement.relative_to` from a creation response to lay out multiple diagrams neatly.
- Prefer structured flowchart data over Mermaid unless the user asks for Mermaid.
- Use `workspace_id` when there is any ambiguity.
- Fetch after creation/editing; it catches schema mistakes and confirms the board state.
