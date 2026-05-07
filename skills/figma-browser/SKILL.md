---
name: figma-browser
description: Navigate and operate Figma via the figma-browser MCP server for browsing files, exporting assets, and managing design data.
---


# Figma Browser MCP Server

You have access to TWO Figma MCP servers. Use the right one for the job:

| Server | Name in tools | Strength |
|---|---|---|
| **Official Figma MCP** | `mcp__claude_ai_Figma__*` | Read design context with code hints, screenshots, FigJam, generate diagrams, Code Connect |
| **Figma Browser** | `mcp__figma-browser__*` | Browse workspace, search files, export assets, comments, versions, dev resources, design system |

The official MCP requires a file URL upfront. Figma Browser finds files without URLs.

## Decision Flowchart

```
User request
├── "What files/designs do I have?" → figma-browser: find_files or list_projects + list_files
├── "Show me this design" (has URL) → official: get_design_context
├── "Find [name] in Figma" → figma-browser: find_files (search by name)
├── "Export this as PNG/SVG" → figma-browser: export_nodes
├── "What components exist?" → figma-browser: list_components
├── "Implement this Figma design" → official: get_design_context (returns React+Tailwind)
├── "What changed in this file?" → figma-browser: get_versions
├── "Read/post comments" → figma-browser: get_comments / post_comment
├── "Link code to this design node" → figma-browser: create_dev_resources
└── "Create a diagram" → official: generate_diagram
```

## Tools Reference (13 tools)

### Browse & Discover

**`list_projects(team_id?)`** — List all projects in a team. [Tier 2: 25/min]
- `team_id` defaults to env var FIGMA_TEAM_ID if set
- Returns: `[{id, name}]`
- There is NO API to list teams — team_id must be known

**`list_files(project_id, branch_data?)`** — List files in a project. [Tier 2]
- Returns: `[{key, name, thumbnail_url, last_modified, branches?}]`
- Thumbnails are included — no extra call needed
- Set `branch_data=true` to see branches

**`find_files(query?, team_id?)`** — Search files by name across ALL projects. [Tier 2]
- Empty query = full workspace inventory
- Enumerates all projects concurrently, filters client-side
- Results sorted newest first
- Returns: `[{key, name, project, project_id, thumbnail_url, last_modified}]`

### File Intelligence

**`get_file_info(file_key)`** — Metadata + page structure. [Tier 3 + Tier 1]
- Works for ALL file types (Figma, FigJam, Slides)
- Page structure only available for Figma design files (FigJam returns a note)
- Returns: `{name, last_modified, thumbnail_url, creator, folder, url, editor_type, pages[], component_count, style_count}`
- The `url` field gives you the Figma URL to pass to the official MCP

**`get_versions(file_key, cursor?)`** — Version history. [Tier 2]
- Cursor-paginated
- Version IDs can be passed to `export_nodes(version=...)` to export past states
- Returns: `{versions: [{id, created_at, label, description, user}], has_next, next_cursor}`

### Design System

**`list_components(file_key? | team_id?, page_size?, after?)`** — Published components. [Tier 3: 50/min]
- Team-level: cursor-paginated, max page_size 1000
- File-level: all at once, no pagination
- Only returns PUBLISHED components — unpublished ones require the official MCP
- Returns: `{components: [{key, name, description, file_key, node_id, containing_frame, component_set, thumbnail_url}], count, next_after?}`
- `component_set` tells you which variant group a component belongs to

**`list_styles(file_key? | team_id?, page_size?, after?)`** — Published styles. [Tier 3]
- Same pagination as components
- `style_type`: FILL, TEXT, EFFECT, or GRID
- Returns: `{styles: [{key, name, style_type, description, file_key, sort_position, thumbnail_url}], count, next_after?}`

### Asset Export

**`export_nodes(file_key, node_ids, format?, scale?, ...)`** — Render nodes as images. [Tier 1: 10/min]
- Formats: `png`, `jpg`, `svg`, `pdf`
- Scale: 0.01 to 4.0 (default 2x for retina). Max output: 32 megapixels
- SVG options: `svg_outline_text` (default true — vectors), `svg_include_id`, `svg_include_node_id`
- `use_absolute_bounds=true` is critical for text nodes (prevents cropping)
- `contents_only=false` includes overlapping content but is slower
- `version` parameter lets you export from a past version
- Batch multiple node_ids in one call (comma-separated internally)
- URLs expire after ~30 days
- Null URL means render failed (invisible node, 0% opacity)

**`get_image_fills(file_key)`** — Download URLs for all uploaded images. [Tier 2]
- Returns ORIGINAL uploaded images, not rendered exports
- URLs expire after ~14 days
- Use `export_nodes` to render specific nodes instead

### Collaboration

**`get_comments(file_key, as_markdown?)`** — Read all comments. [Tier 2]
- `as_markdown=true` (default) returns formatted text
- Returns: `[{id, message, user, created_at, resolved_at, parent_id, order_id}]`
- No pagination — all comments returned at once
- `resolved_at` being set means the comment is resolved (cannot resolve via API)
- `parent_id` present means it's a reply

**`post_comment(file_key, message, node_id?, reply_to?)`** — Post a comment. [Tier 2]
- `node_id` pins the comment to a specific node
- `reply_to` replies to an existing comment (one level deep only — cannot reply to a reply)
- If neither provided, creates a file-level comment

### Dev Resources

**`get_dev_resources(file_key, node_ids?)`** — Read dev links on nodes. [Tier 2]
- Dev resources are URLs attached to nodes shown in Dev Mode (Jira, GitHub, Storybook, docs)
- `file_key` MUST be a main file key, not a branch key
- `node_ids` optional filter

**`create_dev_resources(resources[])`** — Bulk-create dev links. [Tier 2]
- Each resource: `{name, url, file_key, node_id}`
- Max 10 dev resources per node, no duplicate URLs per node
- Immediately visible in Dev Mode (no publish step)
- Can create across multiple files in one call

## Rate Limit Strategy

The server is rate-limit aware. Here's how to be efficient:

| Tier | Budget | Tools | Strategy |
|---|---|---|---|
| Tier 1 | 10/min | export_nodes, get_file_info (page structure) | Batch node_ids. Use `depth=1` internally. |
| Tier 2 | 25/min | list_projects, list_files, find_files, get_versions, get_image_fills, comments, dev_resources | Most tools. Comfortable budget. |
| Tier 3 | 50/min | get_file_info (meta only), list_components, list_styles | Lightweight. Call freely. |

**Key optimizations:**
- `get_file_info` uses the Tier 3 meta endpoint first, then tries Tier 1 depth=1 for pages
- `find_files` parallelizes all project-file fetches concurrently
- `export_nodes` accepts multiple node_ids in one call — always batch

## Common Workflows

### "What's in my Figma workspace?"
```
1. find_files()                          # empty query = all files
2. For interesting files: get_file_info(key)  # pages, component count
```

### "Export a component from this design"
```
1. find_files("component library")       # find the file
2. get_file_info(key)                    # get page structure
3. list_components(file_key=key)         # find the component
4. export_nodes(key, [node_id], "svg")   # export it
```

### "Implement this Figma design in code"
```
1. find_files("homepage") or user provides URL
2. get_file_info(key) → extract url field
3. Pass URL to official MCP: get_design_context  # gets React+Tailwind code hints
4. Adapt to project's stack
```

### "Review and comment on a design"
```
1. get_comments(file_key)                # see existing comments
2. get_file_info(file_key)               # understand file structure
3. post_comment(file_key, message, node_id)  # leave feedback on specific node
```

### "Link my code to Figma components"
```
1. list_components(file_key=key)         # find component node_ids
2. create_dev_resources([
     {name: "React component", url: "https://github.com/.../Button.tsx",
      file_key: key, node_id: "1:23"}
   ])
```

## Gotchas

1. **FigJam/Slides files** return 400 on `GET /v1/files/:key` — `get_file_info` handles this gracefully by falling back to meta-only
2. **No team listing API** — the team_id must be known (set via FIGMA_TEAM_ID env var)
3. **No file search API** — `find_files` enumerates all projects client-side
4. **PATs expire after max 90 days** — if tools start returning 403, the token needs rotation
5. **Image URLs expire** — export_nodes URLs last ~30 days, image_fills URLs last ~14 days
6. **Branch keys vs file keys** — dev resources require MAIN file keys, not branch keys
7. **Comments can't be resolved via API** — only the Figma UI can resolve comments
8. **Replies are one level deep** — cannot reply to a reply
9. **Components endpoint returns only PUBLISHED components** — for unpublished, use the official MCP's get_metadata
10. **`files:read` scope is deprecated** — the PAT should use granular scopes (file_content:read, etc.)

## Environment

- **PAT**: Set as `FIGMA_TOKEN` env var in the MCP server registration
- **Team ID**: Set as `FIGMA_TEAM_ID` env var (default for team_id params)
- **Server path**: `/home/jfloyd/mcp/tools/figma_mcp.py`
- **API docs**: `/home/jfloyd/figma-api-docs/` (51 files scraped from developers.figma.com)
