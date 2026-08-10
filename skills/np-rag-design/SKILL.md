---
name: np-rag-design
description: "Quality bar for researcher/architect/executor work that adds or changes a retrieval-augmented (RAG) or semantic-search pipeline — chunking, embeddings, vector or hybrid indexes, retrieval, ranking, and grounding. Triggered when a task touches how documents are split, embedded, indexed, retrieved, filtered, or fed to a model as context. Encodes a checklist the design MUST satisfy before commit, not a spec document to author. Provider- and store-agnostic."
user-invocable: false
---

# RAG / Retrieval Design

Retrieval decides what the model sees. Bad chunks, a stale index, or unfiltered hits silently degrade every downstream answer. Make each retrieval choice deliberate and measurable.

## Before editing
- Read existing conventions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "retrieval index conventions" --task $TASK_ID`.
- Find the existing chunker, embedding call, and index/query path before adding a parallel one.

## Chunking
- Size and overlap are deliberate choices justified against content shape and query length — not copied defaults.
- Split on semantic boundaries (sections, paragraphs, code blocks); never sever a unit mid-sentence or mid-record.
- Carry source metadata on every chunk: document id, title, location/anchor, timestamp, and access scope.

## Embedding & index
- One embedding model for both index build and query — mixing models or versions makes similarity meaningless.
- Index type (vector / keyword / hybrid) fits scale and query latency; record the dimensionality and distance metric.
- Re-embedding after a model change means a full re-index — plan it, don't half-migrate.

## Retrieval quality
- Have a retrieval eval: a known query→expected-doc set with recall/precision measured, not "it returned something."
- Rank, then filter by a tuned score threshold so weak hits never reach the prompt; cap result count.
- Surface why a chunk was retrieved (score, source) so failures are debuggable.

## Grounding & freshness
- Answers cite the retrieved sources; nothing ungrounded is presented as fact.
- Budget retrieved tokens against the prompt window — truncate or rerank, don't overflow.
- Define the re-index / invalidation trigger (on write, on schedule, on version bump); a stale index serves wrong answers.

## Verification bar (must hold before commit)
- Chunking preserves semantic units and attaches source metadata; size/overlap are justified, not defaulted.
- Index and query use the identical embedding model and version; metric and dimensions are documented.
- A retrieval eval exists and recall on the known set is measured and acceptable — regressions are visible.
- Low-score / irrelevant chunks are filtered by threshold and count before reaching the context window.
- Generated answers are grounded in and cite retrieved sources; see [np-llm-app-architecture] for the generation half.
- Retrieval enforces caller access scope — it never returns documents the caller cannot see; see [np-secure-code-review].
- A concrete re-index / invalidation trigger is defined for content and model changes.
- Index and query latency fit the budget at target scale; see [np-performance].
