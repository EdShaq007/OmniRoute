// Images and documents as model inputs: Claude `document` blocks reach OpenAI/Gemini
// targets, Gemini refuses unreadable types with 400, and remote URLs are inlined as
// base64 for targets that do not fetch them (Copilot /v1/messages, Gemini).

import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";

// Public-looking DNS for the mocked example.com download (same seam as the image tests).
const originalDnsLookup = dns.promises.lookup;
(dns.promises as { lookup: unknown }).lookup = (async (
  _hostname: string,
  options?: { all?: boolean }
) => {
  const record = { address: "203.0.113.1", family: 4 };
  return options && options.all ? [record] : record;
}) as typeof dns.promises.lookup;
process.on("exit", () => {
  (dns.promises as { lookup: unknown }).lookup = originalDnsLookup;
});

const { claudeToOpenAIRequest } =
  await import("../../open-sse/translator/request/claude-to-openai.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { convertOpenAIContentToParts } =
  await import("../../open-sse/translator/helpers/geminiHelper.ts");
const { inlineRemoteAttachments } =
  await import("../../open-sse/handlers/chatCore/inlineRemoteAttachments.ts");
const { setPinnedFetchTestOverride } = await import("../../src/shared/network/remoteImageFetch.ts");

const PDF_B64 = Buffer.from("%PDF-1.4 fake").toString("base64");
const claudeBody = {
  max_tokens: 50,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "resuma" },
        {
          type: "document",
          title: "edital.pdf",
          source: { type: "base64", media_type: "application/pdf", data: PDF_B64 },
        },
      ],
    },
  ],
};

test("Claude document (PDF) becomes an OpenAI file part", () => {
  const out = claudeToOpenAIRequest("gpt-6-sol", structuredClone(claudeBody), false);
  const user = out.messages.find((m) => m.role === "user");
  const file = user.content.find((p) => p.type === "file");
  assert.deepEqual(file, {
    type: "file",
    file: { filename: "edital.pdf", file_data: `data:application/pdf;base64,${PDF_B64}` },
  });
});

test("Claude document (PDF) becomes Gemini inlineData", () => {
  const out = claudeToGeminiRequest("gemini-3.8-flash", structuredClone(claudeBody), false);
  const parts = out.contents.flatMap((c) => c.parts);
  assert.ok(
    parts.some(
      (p) => p.inlineData?.mimeType === "application/pdf" && p.inlineData?.data === PDF_B64
    )
  );
});

test("Gemini: text file becomes text, docx is a 400 unsupported_attachment", () => {
  const txt = Buffer.from("CODIGO LARANJA 7").toString("base64");
  const parts = convertOpenAIContentToParts([
    { type: "file", file: { filename: "nota.txt", file_data: `data:text/plain;base64,${txt}` } },
  ]);
  assert.deepEqual(parts, [{ text: "[Arquivo: nota.txt]\nCODIGO LARANJA 7" }]);

  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  assert.throws(
    () =>
      convertOpenAIContentToParts([
        { type: "file", file: { filename: "a.docx", file_data: `data:${docx};base64,UEsDBA==` } },
      ]),
    (err: Error & { statusCode?: number; errorType?: string }) =>
      err.statusCode === 400 && err.errorType === "unsupported_attachment"
  );
});

test("remote image URL is inlined as base64 for Copilot Claude, without touching the input", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  setPinnedFetchTestOverride(
    async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } })
  );
  try {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "que marca?" },
            { type: "image_url", image_url: { url: "https://example.com/logo.png" } },
          ],
        },
      ],
    };
    const out = await inlineRemoteAttachments(body, "github", "claude");
    assert.equal(
      out.messages[0].content[1].image_url.url,
      `data:image/png;base64,${png.toString("base64")}`
    );
    assert.equal(body.messages[0].content[1].image_url.url, "https://example.com/logo.png");

    // Targets that fetch URLs themselves are left alone.
    assert.equal(await inlineRemoteAttachments(body, "github", "openai-responses"), body);
  } finally {
    setPinnedFetchTestOverride(undefined);
  }
});

test("remote document URL for Gemini is inlined; a LAN URL is a 400 before upstream", async () => {
  setPinnedFetchTestOverride(
    async () =>
      new Response(Buffer.from("%PDF-1.4"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })
  );
  try {
    const ok = await inlineRemoteAttachments(
      {
        input: [
          {
            role: "user",
            content: [{ type: "input_file", file_url: "https://example.com/a.pdf" }],
          },
        ],
      },
      "antigravity",
      "antigravity"
    );
    assert.match(ok.input[0].content[0].file_data, /^data:application\/pdf;base64,/);
    assert.equal(ok.input[0].content[0].file_url, undefined);

    await assert.rejects(
      inlineRemoteAttachments(
        {
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "http://10.77.20.30/x.jpg" } }],
            },
          ],
        },
        "gemini",
        "gemini"
      ),
      (err: Error & { statusCode?: number }) => err.statusCode === 400
    );
  } finally {
    setPinnedFetchTestOverride(undefined);
  }
});
