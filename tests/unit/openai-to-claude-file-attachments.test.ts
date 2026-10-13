import test from "node:test";
import assert from "node:assert/strict";

const { openaiToClaudeRequest } =
  await import("../../open-sse/translator/request/openai-to-claude.ts");

function userBlocks(model: string, content: unknown) {
  const translated = openaiToClaudeRequest(model, { messages: [{ role: "user", content }] }, false);
  const userMsg = translated.messages.find((m) => m.role === "user");
  assert.ok(userMsg && Array.isArray(userMsg.content), "expected a translated user message");
  return userMsg.content;
}

test("openaiToClaudeRequest maps an OpenAI file (PDF) block to a Claude document block", () => {
  const blocks = userBlocks("claude-sonnet-4", [
    { type: "text", text: "summarize" },
    {
      type: "file",
      file: { filename: "edital.pdf", file_data: "data:application/pdf;base64,JVBERiAtMQ==" },
    },
  ]);
  const doc = blocks.find((b) => b.type === "document");
  assert.ok(doc, "PDF file block must become a Claude document block, not be dropped");
  assert.equal(doc.source.type, "base64");
  assert.equal(doc.source.media_type, "application/pdf");
  assert.equal(doc.source.data, "JVBERiAtMQ==");
  assert.equal(doc.title, "edital.pdf");
});

test("openaiToClaudeRequest maps an OpenAI file (image mime) block to a Claude image block", () => {
  const blocks = userBlocks("claude-sonnet-4", [
    {
      type: "file",
      file: { filename: "shot.png", file_data: "data:image/png;base64,iVBORw0KGgo=" },
    },
  ]);
  const img = blocks.find((b) => b.type === "image");
  assert.ok(img, "image-mime file block must become a Claude image block");
  assert.equal(img.source.type, "base64");
  assert.equal(img.source.media_type, "image/png");
  assert.equal(img.source.data, "iVBORw0KGgo=");
});

test("openaiToClaudeRequest maps a remote file (PDF url) block to a Claude document url block", () => {
  const blocks = userBlocks("claude-sonnet-4", [
    { type: "file", file: { filename: "remote.pdf", file_data: "https://example.com/a.pdf" } },
  ]);
  const doc = blocks.find((b) => b.type === "document");
  assert.ok(doc, "remote PDF file block must become a Claude document url block");
  assert.equal(doc.source.type, "url");
  assert.equal(doc.source.url, "https://example.com/a.pdf");
});

test("openaiToClaudeRequest skips a video file block (Claude has no native video input)", () => {
  const blocks = userBlocks("claude-sonnet-4", [
    { type: "text", text: "watch this" },
    { type: "file", file: { filename: "clip.mp4", file_data: "data:video/mp4;base64,AAAAIGZ0" } },
  ]);
  const doc = blocks.find((b) => b.type === "document");
  const img = blocks.find((b) => b.type === "image");
  assert.ok(
    !doc && !img,
    "a video file must not be mislabeled as a Claude document or image block"
  );
  // the text part is still forwarded
  assert.ok(
    blocks.some((b) => b.type === "text"),
    "the accompanying text part must still be forwarded"
  );
});

// Text files become a text block
// (Copilot /v1/messages rejects document source.type "text"); unknown document
// types are a 400 unsupported_attachment instead of a silent drop.
test("openaiToClaudeRequest turns a text/plain file into a labelled text block", () => {
  const b64 = Buffer.from("CODIGO LARANJA 7").toString("base64");
  const blocks = userBlocks("claude-sonnet-4", [
    { type: "file", file: { filename: "nota.txt", file_data: `data:text/plain;base64,${b64}` } },
  ]);
  assert.ok(!blocks.some((b) => b.type === "document"));
  assert.ok(
    blocks.some((b) => b.type === "text" && b.text === "[Arquivo: nota.txt]\nCODIGO LARANJA 7")
  );
});

test("openaiToClaudeRequest rejects a docx file with unsupported_attachment", () => {
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  assert.throws(
    () =>
      userBlocks("claude-sonnet-4", [
        { type: "file", file: { filename: "a.docx", file_data: `data:${docx};base64,UEsDBA==` } },
      ]),
    (err: Error & { statusCode?: number; errorType?: string }) =>
      err.statusCode === 400 &&
      err.errorType === "unsupported_attachment" &&
      err.message.includes(docx)
  );
});
