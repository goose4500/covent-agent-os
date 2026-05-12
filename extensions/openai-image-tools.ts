import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createOpenAIImage } from "../lib/openai-image-client.mjs";

const COMMON_OUTPUT_PARAMS = {
  model: Type.Optional(Type.String({ description: "GPT Image model. Defaults to OPENAI_IMAGE_MODEL or gpt-image-1." })),
  size: Type.Optional(Type.String({ description: "Output size, e.g. 1024x1024, 1536x1024, 1024x1536, or auto if the selected model supports it." })),
  quality: Type.Optional(Type.String({ description: "Output quality: low, medium, high, or auto. Defaults to OPENAI_IMAGE_QUALITY or low for MVP cost control." })),
  output_format: Type.Optional(Type.String({ description: "Output format: png, jpeg, or webp." })),
  background: Type.Optional(Type.String({ description: "Background: auto, opaque, or transparent when supported by the selected model/format." })),
  n: Type.Optional(Type.Number({ description: "Number of images to create, 1-10. Use 1 by default." })),
  output_dir: Type.Optional(Type.String({ description: "Directory to save image files. Defaults to ~/.pi/agent/generated-images." })),
  prefix: Type.Optional(Type.String({ description: "Safe filename prefix for outputs." })),
};

function formatResult(result: any) {
  const lines = [
    `${result.action === "edit" ? "Edited" : "Generated"} ${result.files.length} image(s) with ${result.model}.`,
    result.requestId ? `Request ID: ${result.requestId}` : undefined,
    `Metadata: ${result.metadataPath}`,
    "Image files:",
    ...result.files.map((file: any) => `- ${file.path}`),
  ].filter(Boolean);

  return lines.join("\n");
}

export default function openAIImageTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gpt_image_generate",
    label: "GPT Image Generate",
    description: "Generate one or more images from a text prompt using OpenAI GPT Image models. Saves files locally and returns paths/metadata; never returns base64.",
    promptSnippet: "Generate an image with OpenAI GPT Image and save it to a local file",
    promptGuidelines: [
      "Use gpt_image_generate when the user asks to create/draw/render a new image from text.",
      "Default to one low-quality draft image unless the user asks for final/high quality.",
      "Return saved file paths and metadata paths. Do not paste base64 image data into chat.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed image prompt. Include subject, composition, style, constraints, text to render, and intended use." }),
      ...COMMON_OUTPUT_PARAMS,
    }),
    async execute(_toolCallId, params: any) {
      const result = await createOpenAIImage({
        action: "generate",
        prompt: params.prompt,
        model: params.model,
        size: params.size,
        quality: params.quality,
        outputFormat: params.output_format,
        background: params.background,
        n: params.n,
        outputDir: params.output_dir,
        prefix: params.prefix || "gpt-image-generate",
      } as any);

      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "gpt_image_edit",
    label: "GPT Image Edit",
    description: "Edit, restyle, or use one or more reference images with OpenAI GPT Image models. Saves edited files locally and returns paths/metadata; never returns base64.",
    promptSnippet: "Edit/reference existing image(s) with OpenAI GPT Image and save the result to a local file",
    promptGuidelines: [
      "Use gpt_image_edit when the user provides source/reference images or asks for image-to-image work.",
      "Preserve important visual details from the input unless the user explicitly wants transformation.",
      "Use input_fidelity=high for models that support it when reference preservation matters; omit it for gpt-image-2.",
      "Return saved file paths and metadata paths. Do not paste base64 image data into chat.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed edit/reference prompt. Say what to preserve, what to change, and what final image should look like." }),
      image_paths: Type.Optional(Type.Array(Type.String(), { description: "Local image file paths to edit/use as references. Up to 16 images." })),
      image_urls: Type.Optional(Type.Array(Type.String(), { description: "Fully qualified public image URLs or data URLs to edit/use as references. Up to 16 images." })),
      input_fidelity: Type.Optional(Type.String({ description: "Input fidelity: high or low for supported models. Omit for gpt-image-2." })),
      mask_image_url: Type.Optional(Type.String({ description: "Optional mask as a public URL or data URL. Must match source image size/format requirements." })),
      mask_file_id: Type.Optional(Type.String({ description: "Optional OpenAI File API ID for a mask image." })),
      ...COMMON_OUTPUT_PARAMS,
    }),
    async execute(_toolCallId, params: any) {
      const result = await createOpenAIImage({
        action: "edit",
        prompt: params.prompt,
        imagePaths: params.image_paths || [],
        imageUrls: params.image_urls || [],
        inputFidelity: params.input_fidelity,
        maskImageUrl: params.mask_image_url,
        maskFileId: params.mask_file_id,
        model: params.model,
        size: params.size,
        quality: params.quality,
        outputFormat: params.output_format,
        background: params.background,
        n: params.n,
        outputDir: params.output_dir,
        prefix: params.prefix || "gpt-image-edit",
      } as any);

      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: result,
      };
    },
  });
}
