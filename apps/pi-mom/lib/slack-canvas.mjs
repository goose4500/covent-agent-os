export async function createRunCanvas({ client, run, markdown, channel, trace = () => {} } = {}) {
  if (!client || typeof client.apiCall !== "function") {
    trace("agent.canvas_unavailable", { runId: run?.id, reason: "apiCall_missing" });
    return undefined;
  }

  try {
    const response = await client.apiCall("canvases.create", {
      title: `Agent run ${run.id}`.slice(0, 80),
      document_content: {
        type: "markdown",
        markdown: String(markdown || "").slice(0, 100_000),
      },
      channel_id: channel || run.channel,
    });
    if (!response?.ok) {
      trace("agent.canvas_failed", { runId: run.id, error: response?.error || "not_ok" });
      return undefined;
    }
    const id = response.canvas_id || response.canvas?.id;
    return {
      id,
      url: response.canvas_url || response.canvas?.url || (id && run.team ? `https://app.slack.com/docs/${run.team}/${id}` : undefined),
    };
  } catch (error) {
    trace("agent.canvas_failed", { runId: run?.id, error: error?.data?.error || error.message });
    return undefined;
  }
}
