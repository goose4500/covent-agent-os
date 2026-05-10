import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanPiOutput, stripTerminalSequences } from "../domain/redact.mjs";
import { splitForSlackStream } from "../domain/slack-format.mjs";

function piSubprocessEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SLACK_") || key.includes("SLACK") || key.startsWith("LINEAR_") || key.includes("LINEAR")) {
      delete env[key];
    }
  }
  return env;
}

export function createPiRunner({ config, trace, slack }) {
  async function runPi(prompt, { onOutput } = {}) {
    const promptDir = await mkdtemp(join(tmpdir(), "pi-mom-prompt-"));
    const promptPath = join(promptDir, "prompt.md");
    await writeFile(promptPath, prompt, { mode: 0o600 });

    try {
      return await new Promise((resolve, reject) => {
        const safeRuntimeArgs = config.pi.allowTools ? [] : ["--no-tools", "--no-extensions"];
        const args = [...config.pi.extraArgs, ...safeRuntimeArgs, "--no-session", "-p", `@${promptPath}`];
        const child = spawn(config.pi.command, args, {
          env: piSubprocessEnv(),
          cwd: config.pi.workdir,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let idleTimer;
        let emittedOutput = "";

        const emitNewOutput = () => {
          if (typeof onOutput !== "function") return;
          const cleanedSoFar = cleanPiOutput(stdout);
          if (cleanedSoFar === emittedOutput) return;

          const delta = cleanedSoFar.startsWith(emittedOutput)
            ? cleanedSoFar.slice(emittedOutput.length)
            : cleanedSoFar;
          emittedOutput = cleanedSoFar;

          if (!delta) return;
          try {
            onOutput(delta);
          } catch (error) {
            trace("pi.output_stream_callback_error", { error: error.message });
          }
        };

        const finish = (kind, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(idleTimer);
          clearTimeout(timeoutTimer);

          const cleaned = stripTerminalSequences(stdout);
          if (error && kind !== "stdout_idle") {
            const message = cleaned ? `${error.message}\n\nPartial stdout:\n${cleaned}` : error.message;
            reject(new Error(message));
            return;
          }

          if (cleaned) {
            trace("pi.output_ready", { kind, outputLength: cleaned.length });
            try { child.kill("SIGTERM"); } catch {}
            resolve(cleaned);
            return;
          }

          if (error) reject(error);
          else reject(new Error(`${config.pi.command} produced no stdout. stderr: ${stripTerminalSequences(stderr)}`));
        };

        const timeoutTimer = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch {}
          finish("timeout", new Error(`${config.pi.command} timed out after ${config.pi.timeoutMs}ms. stderr: ${stripTerminalSequences(stderr)}`));
        }, config.pi.timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          emitNewOutput();
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finish("stdout_idle"), config.pi.outputIdleMs);
        });

        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (error) => finish("process_error", error));
        child.on("close", (code, signal) => {
          if (code === 0) finish("process_close");
          else finish("process_close", new Error(`${config.pi.command} exited ${code ?? signal}. stderr: ${stripTerminalSequences(stderr)}`));
        });
      });
    } finally {
      await rm(promptDir, { recursive: true, force: true });
    }
  }

  async function runPiWithSlackStream({ client, event, channel, threadTs, user, prompt, requestId }) {
    if (typeof client.chatStream !== "function") {
      throw new Error("Slack WebClient chatStream helper is unavailable. Update @slack/web-api or disable PI_MOM_STREAMING.");
    }

    const streamArgs = slack.streamArgsForEvent({
      channel,
      threadTs,
      user,
      team: event.team || event.team_id || event.context_team_id,
    });
    const stream = client.chatStream(streamArgs);
    let streamChain = Promise.resolve();
    let streamError = null;
    let streamedLength = 0;
    let streamVisible = false;

    const queueAppend = (text) => {
      for (const markdown_text of splitForSlackStream(text, config.pi.streamAppendChars)) {
        streamedLength += markdown_text.length;
        streamChain = streamChain
          .then(() => stream.append({ markdown_text }))
          .catch((error) => {
            streamError = streamError || error;
            trace("slack.stream_append_error", {
              requestId,
              error: error?.data?.error || error.message,
            });
          });
      }
      return streamChain;
    };

    try {
      await queueAppend(`👀 Covent Pi is thinking… (req: ${requestId})\n\n`);
      await streamChain;
      if (streamError) throw streamError;
      streamVisible = true;
      trace("slack.stream_started", {
        requestId,
        hasRecipient: Boolean(streamArgs.recipient_user_id && streamArgs.recipient_team_id),
      });

      const result = await runPi(prompt, { onOutput: queueAppend });
      await streamChain;
      if (streamError) throw streamError;
      await stream.stop();
      trace("slack.stream_stopped", { requestId, streamedLength, resultLength: result.length });
      return result;
    } catch (error) {
      if (streamVisible) {
        try {
          await queueAppend(`\n\nPi encountered an error (req: ${requestId}). Check the pi-mom terminal for details.`);
          await streamChain;
          await stream.stop();
          error.slackStreamNotified = true;
        } catch (stopError) {
          trace("slack.stream_stop_error", {
            requestId,
            error: stopError?.data?.error || stopError.message,
          });
        }
      }
      throw error;
    }
  }

  return { runPi, runPiWithSlackStream };
}
