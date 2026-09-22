export interface ParsedReview {
  approved: boolean;
  feedback: string;
  finalAnswer: string;
  confidence?: number;
}

function quotedField(text: string, field: string): string | undefined {
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "s"));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

export function parseReview(text: string): ParsedReview {
  const normalized = text
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (typeof parsed.approved === "boolean") {
      return {
        approved: parsed.approved,
        feedback: String(parsed.feedback || ""),
        finalAnswer: String(parsed.finalAnswer || ""),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      };
    }
  } catch {
    // Some providers emit duplicate keys or a non-JSON confidence value. Fall
    // through to the field-level recovery below; the approval decision and
    // answer fields remain typed and bounded by this parser.
  }

  const approved = normalized.match(/"approved"\s*:\s*(true|false)/i);
  if (!approved) throw new Error("Reviewer response did not contain a valid approved boolean");
  const feedback = quotedField(normalized, "feedback");
  const finalAnswer = quotedField(normalized, "finalAnswer");
  const confidences = [...normalized.matchAll(/"confidence"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return {
    approved: approved[1].toLowerCase() === "true",
    feedback: feedback || "",
    finalAnswer: finalAnswer || "",
    confidence: confidences.length ? confidences[confidences.length - 1] : undefined,
  };
}
