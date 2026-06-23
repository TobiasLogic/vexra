// Holds the live VexraIndexer for the running session so modules like tools.js
// can refresh the index after edits without importing the REPL (avoids a cycle).
let current = null;

export function setIndexer(indexer) {
  current = indexer;
}

export function getIndexer() {
  return current;
}
