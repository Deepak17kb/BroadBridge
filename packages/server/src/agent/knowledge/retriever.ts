import { KNOWLEDGE_BASE, type KnowledgeDoc } from './corpus.js';

/**
 * BM25 retrieval over the knowledge base.
 *
 * Lexical rather than embedding-based on purpose. The corpus is small and
 * domain-specific, BM25 needs no model call and no vector store, and it works
 * identically in the deterministic mode where there are no credentials at all.
 * An embedding index would be the right call at a few thousand documents; at
 * fourteen it would add a network hop, a cold-start cost and an availability
 * dependency in exchange for nothing measurable.
 */

const K1 = 1.5;
const B = 0.75;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for', 'from', 'how',
  'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'should', 'so', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we',
  'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your', 'can', 'could',
  'would', 'about', 'into', 'more', 'much', 'not', 'now',
]);

/** Very light stemmer - enough to unify plurals and common verb endings. */
function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ies', 'ers', 'er', 'ed', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s%-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

interface IndexedDoc {
  doc: KnowledgeDoc;
  termFrequency: Map<string, number>;
  length: number;
}

class Bm25Index {
  private readonly docs: IndexedDoc[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private averageLength = 0;

  constructor(corpus: KnowledgeDoc[]) {
    for (const doc of corpus) {
      // Title and tags are repeated so a topical match outranks a passing mention
      // buried in another document's body.
      const text = `${doc.title} ${doc.title} ${doc.tags.join(' ')} ${doc.tags.join(' ')} ${doc.content}`;
      const tokens = tokenize(text);
      const termFrequency = new Map<string, number>();
      for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      for (const term of termFrequency.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      this.docs.push({ doc, termFrequency, length: tokens.length });
    }
    this.averageLength =
      this.docs.reduce((acc, d) => acc + d.length, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, limit = 3): RetrievalHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const total = this.docs.length;

    const scored = this.docs.map((indexed) => {
      let score = 0;
      const matched: string[] = [];
      for (const term of terms) {
        const tf = indexed.termFrequency.get(term);
        if (!tf) continue;
        matched.push(term);
        const df = this.documentFrequency.get(term) ?? 0;
        // Standard BM25 IDF, with the +1 that keeps it positive for common terms.
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const norm = tf + K1 * (1 - B + (B * indexed.length) / this.averageLength);
        score += idf * ((tf * (K1 + 1)) / norm);
      }
      return { indexed, score, matched };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        id: s.indexed.doc.id,
        title: s.indexed.doc.title,
        score: Math.round(s.score * 1000) / 1000,
        snippet: bestSnippet(s.indexed.doc.content, s.matched),
        content: s.indexed.doc.content,
      }));
  }
}

export interface RetrievalHit {
  id: string;
  title: string;
  score: number;
  /** The most relevant passage, for citation display. */
  snippet: string;
  /** Full document text, passed to the model as grounding context. */
  content: string;
}

/** Picks the paragraph containing the most query terms. */
function bestSnippet(content: string, terms: string[]): string {
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
  let best = paragraphs[0] ?? '';
  let bestHits = -1;
  for (const paragraph of paragraphs) {
    const lower = tokenize(paragraph);
    const hits = terms.filter((t) => lower.includes(t)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = paragraph;
    }
  }
  return best.length > 320 ? `${best.slice(0, 317)}...` : best;
}

const index = new Bm25Index(KNOWLEDGE_BASE);

export function retrieve(query: string, limit = 3): RetrievalHit[] {
  return index.search(query, limit);
}

export function getDoc(id: string): KnowledgeDoc | undefined {
  return KNOWLEDGE_BASE.find((d) => d.id === id);
}

export { KNOWLEDGE_BASE };
