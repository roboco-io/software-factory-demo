export function signatureTrailers(engine: string, model: string, issue: number): string {
  return `Agent-Signature: ${engine}/${model}\nFactory-Issue: #${issue}`;
}

export function commitMessage(
  subject: string,
  body: string,
  sig: { engine: string; model: string },
  issue: number,
): string {
  const parts = [subject.replace(/\r?\n/g, " ").trim()];
  if (body.trim()) parts.push(body.trim());
  parts.push(signatureTrailers(sig.engine, sig.model, issue));
  return parts.join("\n\n");
}

export function parseFactoryIssues(message: string): number[] {
  const found = [...message.matchAll(/^\s*(?:\*\s*)?Factory-Issue: #(\d+)\s*$/gm)].map((m) =>
    Number(m[1]),
  );
  return [...new Set(found)];
}
