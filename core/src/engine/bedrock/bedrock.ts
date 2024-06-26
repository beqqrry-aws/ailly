import { dirname } from "node:path";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { Content, View } from "../../content/content.js";
import { LOGGER as ROOT_LOGGER, isDefined } from "../../util.js";
import { Message, Summary } from "../index.js";
import { Models, PromptBuilder } from "./prompt-builder.js";
import { getLogger } from "@davidsouther/jiffies/lib/esm/log.js";

export const name = "bedrock";
export const DEFAULT_MODEL = "anthropic.claude-3-sonnet-20240229-v1:0";

const LOGGER = getLogger("@ailly/core:bedrock");

const MODEL_MAP: Record<string, string> = {
  sonnet: "anthropic.claude-3-sonnet-20240229-v1:0",
  haiku: "anthropic.claude-3-haiku-20240307-v1:0",
  opus: "anthropic.claude-3-opus-20240229-v1:0",
};

export async function generate(
  c: Content,
  { model = DEFAULT_MODEL }: { model: string }
): Promise<{ message: string; debug: unknown }> {
  LOGGER.level = ROOT_LOGGER.level;
  LOGGER.format = ROOT_LOGGER.format;
  const bedrock = new BedrockRuntimeClient({});
  model = MODEL_MAP[model] ?? model;
  let messages = c.meta?.messages ?? [];
  if (!messages.find((m) => m.role == "user")) {
    throw new Error("Bedrock must have at least one message with role: user");
  }
  if (messages.at(-1)?.role == "assistant") {
    messages = messages.slice(0, -1);
  }
  let stopSequences: undefined | string[];
  let fence: undefined | string = undefined;
  if (c.context.edit) {
    const lang = c.context.edit.file.split(".").at(-1) ?? "";
    fence = "```" + lang;
    messages.push({ role: "assistant", content: fence });
    stopSequences = ["```"];
  }

  const promptBuilder = new PromptBuilder(model as Models);
  const prompt = promptBuilder.build(messages);

  if (stopSequences) {
    prompt.stop_sequences = stopSequences;
  }

  // Use given temperature; or 0 for edit (don't want creativity) but 1.0 generally.
  prompt.temperature =
    c.meta?.temperature ?? c.context.edit != undefined ? 0.0 : 1.0;

  LOGGER.debug("Bedrock sending prompt", { prompt });

  try {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: model,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(prompt),
      })
    );

    const body = JSON.parse(response.body.transformToString());
    response.body = body;

    LOGGER.info(`Response from Bedrock for ${c.name}`);
    LOGGER.debug(`Bedrock response`, body);

    let message: string = (body.content?.[0]?.text ?? "").trim();
    // In edit mode, claude (at least) does not return the stop sequence nor the prefill, so the edit is the message.

    return {
      message,
      debug: {
        id: null,
        model,
        usage: null,
        finish: body.stop_reason,
      },
    };
  } catch (error) {
    LOGGER.warn(`Error from Bedrock for ${c.name}`, { error });
    return {
      message: "💩",
      debug: { finish: "failed", error: { message: (error as Error).message } },
    };
  }
}

export async function view(): Promise<View> {
  return {
    claude: {
      long: "Prefer long, elegant, formal language.",
    },
  };
}

export async function format(
  contents: Content[],
  context: Record<string, Content>
): Promise<Summary> {
  const summary: Summary = { prompts: contents.length, tokens: 0 };
  for (const content of contents) {
    await addContentMeta(content, context);
  }
  return summary;
}

async function addContentMeta(
  content: Content,
  context: Record<string, Content>
) {
  content.meta ??= {};
  if (content.context.folder)
    content.meta.messages = getMessagesFolder(content, context);
  else content.meta.messages = getMessagesPredecessor(content, context);
}

export function getMessagesPredecessor(
  content: Content,
  context: Record<string, Content>
): Message[] {
  const system = (content.context.system ?? [])
    .map((s) => s.content)
    .join("\n");
  const history: Content[] = [];
  while (content) {
    history.push(content);
    content = context[content.context.predecessor!];
  }
  history.reverse();
  const augment = history
    .map<Array<Message | undefined>>(
      (c) =>
        (c.context.augment ?? []).map<Message>(({ content }) => ({
          role: "user",
          content:
            "Use this code block as background information for format and style, but not for functionality:\n```\n" +
            content +
            "\n```\n",
        })) ?? []
    )
    .flat()
    .filter(isDefined);
  const parts = history
    .map<Array<Message | undefined>>((content) => [
      {
        role: "user",
        content: content.prompt,
      },
      content.response
        ? { role: "assistant", content: content.response }
        : undefined,
    ])
    .flat()
    .filter(isDefined);
  return [{ role: "system", content: system }, ...augment, ...parts];
}

export function getMessagesFolder(
  content: Content,
  context: Record<string, Content>
): Message[] {
  const system =
    (content.context.system ?? []).map((s) => s.content).join("\n") +
    "\n" +
    "Instructions are happening in the context of this folder:\n" +
    `<folder name="${dirname(content.path)}">\n` +
    (content.context.folder ?? [])
      .map((c) => context[c])
      .map<string>(
        (c) => `<file name="${c.name}>\n${c.prompt ?? c.response ?? ""}</file>`
      )
      .join("\n") +
    "\n</folder>";

  const history: Content[] = [content];
  const augment: Message[] = [];

  const parts = history
    .map<Array<Message | undefined>>((content) => [
      {
        role: "user",
        content: content.prompt,
      },
      content.response
        ? { role: "assistant", content: content.response }
        : undefined,
    ])
    .flat()
    .filter(isDefined);
  return [{ role: "system", content: system }, ...augment, ...parts];
}

export async function tune(content: Content[]) {}

const td = new TextDecoder();
export async function vector(inputText: string, {}: {}): Promise<number[]> {
  const bedrock = new BedrockRuntimeClient({});
  const response = await bedrock.send(
    new InvokeModelCommand({
      body: JSON.stringify({ inputText }),
      modelId: "amazon.titan-embed-text-v1",
      contentType: "application/json",
      accept: "*/*",
    })
  );

  const body = JSON.parse(td.decode(response.body));

  return body.embedding;
}

export function extractFirstFence(message: string): string {
  const firstTicks = message.indexOf("```");
  if (firstTicks != 0) LOGGER.warn("First code fence is not at index 0");
  const endOfFirstLine = message.indexOf("\n", firstTicks);
  const nextTicks = message.indexOf("```", endOfFirstLine + 1);
  message = message.slice(endOfFirstLine + 1, nextTicks + 1);
  return message;
}
