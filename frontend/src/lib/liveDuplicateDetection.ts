export type LiveDuplicateRecord = {
  id: string;
  store_id: string;
  feedback_text: string;
  source: string;
  category: string;
  created_at: string;
};

export type LiveDuplicateMatch<T extends LiveDuplicateRecord> = {
  incident: T;
  similarity: number;
  match_type: 'exact_text' | 'near_text';
  matched_text: string;
  matched_source: string;
  matched_at: string;
};

export type LiveDuplicateEvidence = {
  incident_id: string;
  feedback_text: string;
  source: string;
  received_at: string;
};

const DUPLICATE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const NEAR_MATCH_THRESHOLD = 0.76;

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function characterNgrams(value: string): Set<string> {
  const padded = `  ${value}  `;
  const grams = new Set<string>();
  for (let index = 0; index <= padded.length - 3; index += 1) {
    grams.add(padded.slice(index, index + 3));
  }
  return grams;
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const gram of left) if (right.has(gram)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

/**
 * Suggest a human-reviewed same-store repeat. This deliberately uses only
 * conservative character overlap; it is not a semantic or multilingual model.
 */
export function findLiveDuplicateMatch<T extends LiveDuplicateRecord>(
  feedbackText: string,
  storeId: string,
  source: string,
  category: string,
  incidents: readonly T[],
  sourceEvidence: readonly LiveDuplicateEvidence[] = [],
  now = new Date(),
): LiveDuplicateMatch<T> | null {
  const normalizedText = normalizeText(feedbackText);
  if (normalizedText.length < 12) return null;

  const incomingGrams = characterNgrams(normalizedText);
  const nowMs = now.getTime();
  const matches: LiveDuplicateMatch<T>[] = [];
  const evidenceByIncident = new Map<string, LiveDuplicateEvidence[]>();
  for (const evidence of sourceEvidence) {
    evidenceByIncident.set(evidence.incident_id, [...(evidenceByIncident.get(evidence.incident_id) ?? []), evidence]);
  }

  for (const incident of incidents) {
    if (
      incident.store_id !== storeId ||
      incident.category.toLocaleLowerCase() !== category.toLocaleLowerCase()
    ) continue;

    const messages: LiveDuplicateEvidence[] = [
      {
        incident_id: incident.id,
        feedback_text: incident.feedback_text,
        source: incident.source,
        received_at: incident.created_at,
      },
      ...(evidenceByIncident.get(incident.id) ?? []),
    ];
    for (const message of messages) {
      const createdAt = new Date(message.received_at).getTime();
      if (
        message.source.toLocaleLowerCase() === source.toLocaleLowerCase() ||
        !Number.isFinite(createdAt) ||
        createdAt < nowMs - DUPLICATE_LOOKBACK_MS ||
        createdAt > nowMs + 5 * 60 * 1000
      ) continue;

      const priorText = normalizeText(message.feedback_text);
      if (priorText.length < 12) continue;
      if (priorText === normalizedText) {
        matches.push({
          incident,
          similarity: 1,
          match_type: 'exact_text',
          matched_text: message.feedback_text,
          matched_source: message.source,
          matched_at: message.received_at,
        });
        continue;
      }
      if (Math.min(priorText.length, normalizedText.length) < 24) continue;

      const similarity = diceSimilarity(incomingGrams, characterNgrams(priorText));
      if (similarity >= NEAR_MATCH_THRESHOLD) {
        matches.push({
          incident,
          similarity,
          match_type: 'near_text',
          matched_text: message.feedback_text,
          matched_source: message.source,
          matched_at: message.received_at,
        });
      }
    }
  }

  matches.sort((left, right) =>
    right.similarity - left.similarity ||
    right.incident.created_at.localeCompare(left.incident.created_at),
  );
  return matches[0] ?? null;
}
