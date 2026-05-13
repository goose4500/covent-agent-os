// PRD-intake edit-modal builder + submission parser.
//
// The intake card's "Edit" button opens a modal pre-filled with the AI
// proposal. The bridge needs to (a) know the approvalId on submit so it can
// look up the pending entry, and (b) release the claimed-by lock when the
// user closes the modal without submitting — hence `private_metadata` +
// `notify_on_close: true`.
//
// Mirror of `buildInputModalView` in slack-ui-context.mjs, generalized to a
// multi-field form. Block IDs and action IDs are exported so the view
// handler in `index.mjs` can find values without hard-coding strings twice.

export const PI_INTAKE_EDIT_BLOCKS = Object.freeze({
  TITLE: "pi_intake_edit_title",
  DESCRIPTION: "pi_intake_edit_description",
  PRIORITY: "pi_intake_edit_priority",
  TEAM: "pi_intake_edit_team",
  PROJECT: "pi_intake_edit_project",
});

export const PI_INTAKE_EDIT_ACTIONS = Object.freeze({
  TITLE: "pi_intake_edit_title_value",
  DESCRIPTION: "pi_intake_edit_description_value",
  PRIORITY: "pi_intake_edit_priority_value",
  TEAM: "pi_intake_edit_team_value",
  PROJECT: "pi_intake_edit_project_value",
});

const PRIORITY_OPTIONS = [
  { value: "0", label: "P0 — none" },
  { value: "1", label: "P1 — urgent" },
  { value: "2", label: "P2 — high" },
  { value: "3", label: "P3 — medium" },
  { value: "4", label: "P4 — low" },
];

function priorityOption(opt) {
  return {
    text: { type: "plain_text", text: opt.label },
    value: opt.value,
  };
}

function matchInitialPriority(priority) {
  if (priority == null) return priorityOption(PRIORITY_OPTIONS[0]); // "none"
  const n = Number(priority);
  if (!Number.isFinite(n)) return priorityOption(PRIORITY_OPTIONS[0]);
  const found = PRIORITY_OPTIONS.find((o) => o.value === String(Math.trunc(n)));
  return priorityOption(found || PRIORITY_OPTIONS[0]);
}

function clamp(text, max) {
  const v = String(text ?? "");
  if (!v) return "";
  return v.length <= max ? v : v.slice(0, Math.max(0, max));
}

function plainText(s, max = 150) {
  return { type: "plain_text", text: clamp(String(s ?? ""), max) };
}

function placeholder(s) {
  const v = clamp(String(s ?? ""), 150);
  return v ? { type: "plain_text", text: v } : undefined;
}

export function buildEditModalView({
  approvalId,
  proposal,
  defaultTeamId,
  defaultProjectId,
} = {}) {
  const safe = proposal && typeof proposal === "object" ? proposal : {};
  const titleInitial = clamp(safe.title ?? "", 240);
  const descInitial = clamp(safe.description ?? "", 6000);
  const teamInitial = String(safe.suggested_team_id ?? "").trim();
  const projectInitial = String(safe.suggested_project_id ?? "").trim();

  const teamPlaceholder = defaultTeamId
    ? `default: ${defaultTeamId}`
    : "Leave blank to use the channel default";
  const projectPlaceholder = defaultProjectId
    ? `default: ${defaultProjectId}`
    : "Leave blank to use the channel default";

  const view = {
    type: "modal",
    callback_id: "pi_intake_edit_modal",
    private_metadata: String(approvalId ?? ""),
    notify_on_close: true,
    title: plainText("Edit proposal", 24),
    submit: plainText("Approve & create", 24),
    close: plainText("Cancel", 24),
    blocks: [
      {
        type: "input",
        block_id: PI_INTAKE_EDIT_BLOCKS.TITLE,
        label: plainText("Title", 75),
        element: {
          type: "plain_text_input",
          action_id: PI_INTAKE_EDIT_ACTIONS.TITLE,
          max_length: 240,
          initial_value: titleInitial || undefined,
          placeholder: placeholder("Short, action-oriented title"),
        },
      },
      {
        type: "input",
        block_id: PI_INTAKE_EDIT_BLOCKS.DESCRIPTION,
        label: plainText("Description (markdown)", 75),
        element: {
          type: "plain_text_input",
          action_id: PI_INTAKE_EDIT_ACTIONS.DESCRIPTION,
          multiline: true,
          max_length: 6000,
          initial_value: descInitial || undefined,
          placeholder: placeholder("Problem / Context / What to build / Acceptance criteria / Blocked by"),
        },
      },
      {
        type: "input",
        block_id: PI_INTAKE_EDIT_BLOCKS.PRIORITY,
        label: plainText("Priority", 75),
        element: {
          type: "static_select",
          action_id: PI_INTAKE_EDIT_ACTIONS.PRIORITY,
          initial_option: matchInitialPriority(safe.priority),
          options: PRIORITY_OPTIONS.map(priorityOption),
        },
      },
      {
        type: "input",
        block_id: PI_INTAKE_EDIT_BLOCKS.TEAM,
        optional: true,
        label: plainText("Linear team ID (override)", 75),
        element: {
          type: "plain_text_input",
          action_id: PI_INTAKE_EDIT_ACTIONS.TEAM,
          initial_value: teamInitial || undefined,
          placeholder: placeholder(teamPlaceholder),
        },
      },
      {
        type: "input",
        block_id: PI_INTAKE_EDIT_BLOCKS.PROJECT,
        optional: true,
        label: plainText("Linear project ID (override)", 75),
        element: {
          type: "plain_text_input",
          action_id: PI_INTAKE_EDIT_ACTIONS.PROJECT,
          initial_value: projectInitial || undefined,
          placeholder: placeholder(projectPlaceholder),
        },
      },
    ],
  };

  return view;
}

function readInput(values, blockId, actionId) {
  const block = values?.[blockId];
  if (!block) return undefined;
  const el = block[actionId];
  if (!el) return undefined;
  if (typeof el.value === "string") return el.value;
  if (el.selected_option && typeof el.selected_option.value === "string") return el.selected_option.value;
  return undefined;
}

export function parseEditModalSubmission(view) {
  const values = view?.state?.values ?? {};

  const rawTitle = readInput(values, PI_INTAKE_EDIT_BLOCKS.TITLE, PI_INTAKE_EDIT_ACTIONS.TITLE);
  const rawDesc = readInput(values, PI_INTAKE_EDIT_BLOCKS.DESCRIPTION, PI_INTAKE_EDIT_ACTIONS.DESCRIPTION);
  const rawPriority = readInput(values, PI_INTAKE_EDIT_BLOCKS.PRIORITY, PI_INTAKE_EDIT_ACTIONS.PRIORITY);
  const rawTeam = readInput(values, PI_INTAKE_EDIT_BLOCKS.TEAM, PI_INTAKE_EDIT_ACTIONS.TEAM);
  const rawProject = readInput(values, PI_INTAKE_EDIT_BLOCKS.PROJECT, PI_INTAKE_EDIT_ACTIONS.PROJECT);

  const title = String(rawTitle ?? "").trim();
  const description = String(rawDesc ?? "").trim();

  let priority;
  if (rawPriority != null && String(rawPriority).trim() !== "") {
    const n = Number(rawPriority);
    priority = Number.isFinite(n) ? n : undefined;
  }

  const teamTrim = String(rawTeam ?? "").trim();
  const projectTrim = String(rawProject ?? "").trim();
  const team_id = teamTrim ? teamTrim : undefined;
  const project_id = projectTrim ? projectTrim : undefined;

  return {
    title,
    description,
    priority,
    team_id,
    project_id,
  };
}
