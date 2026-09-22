import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API });

export function eventEmbeddingText(
  eventHint: string,
  summary: string,
): string {
  return `Event: ${eventHint}\n\nSummary: ${summary}`.trim();
}

export async function createEventEmbedding(
  eventHint: string,
  summary: string,
): Promise<number[]> {
  if (!process.env.OPENAI_API) {
    throw new Error('OPENAI_API is not set');
  }

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: eventEmbeddingText(eventHint, summary),
    encoding_format: 'float',
  });

  return response.data[0].embedding;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
