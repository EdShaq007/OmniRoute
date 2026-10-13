/**
 * a request attachment the target cannot represent is a 400, not a
 * silent drop (the model would answer without it). chatCore maps `statusCode` and
 * `errorType` of a translation error to the HTTP response.
 */
export function unsupportedAttachment(
  mime: string,
  target: string
): Error & { statusCode: number; errorType: string } {
  const error = new Error(
    `Attachment type "${mime || "unknown"}" is not supported by ${target}`
  ) as Error & { statusCode: number; errorType: string };
  error.statusCode = 400;
  error.errorType = "unsupported_attachment";
  return error;
}

/** Decode a text/* (or JSON/XML) base64 payload into a labelled text block body. */
export function attachmentAsText(filename: unknown, base64: string): string {
  const name = typeof filename === "string" && filename ? filename : "anexo";
  return `[Arquivo: ${name}]\n${Buffer.from(base64, "base64").toString("utf8")}`;
}

export function isTextLikeMime(mime: string): boolean {
  return /^text\//i.test(mime) || /^application\/(json|xml|x-yaml|yaml)$/i.test(mime);
}
