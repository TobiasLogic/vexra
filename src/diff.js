import chalk from 'chalk';

export function unifiedDiff(oldContent, newContent, opts = {}) {
  const { contextLines = 3, oldLabel = 'original', newLabel = 'modified' } = opts;
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const lcs = buildLCS(oldLines, newLines);
  const ops = buildOps(oldLines, newLines, lcs);

  const hunks = groupHunks(ops, contextLines, oldLines.length, newLines.length);
  if (hunks.length === 0) return chalk.dim('(no changes)');

  let out = '';
  out += chalk.dim(`--- ${oldLabel}\n`);
  out += chalk.dim(`+++ ${newLabel}\n`);

  for (const hunk of hunks) {
    const oldStart = hunk.oldStart + 1;
    const newStart = hunk.newStart + 1;
    const oldCount = hunk.lines.filter(l => l.type !== 'add').length;
    const newCount = hunk.lines.filter(l => l.type !== 'del').length;
    out += chalk.cyan(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`);

    for (const line of hunk.lines) {
      if (line.type === 'ctx') out += chalk.dim(' ' + line.text + '\n');
      else if (line.type === 'del') out += chalk.red('-' + line.text + '\n');
      else if (line.type === 'add') out += chalk.green('+' + line.text + '\n');
    }
  }

  // Best-effort language-aware syntax highlighting if cli-highlight is used
  // We apply chalk colors above, but a proper implementation would highlight the source first.
  return out;
}

function buildLCS(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function buildOps(oldLines, newLines, lcs) {
  const ops = [];
  let i = oldLines.length, j = newLines.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: 'ctx', oldIdx: i - 1, newIdx: j - 1, text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      ops.unshift({ type: 'add', newIdx: j - 1, text: newLines[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'del', oldIdx: i - 1, text: oldLines[i - 1] });
      i--;
    }
  }
  return ops;
}

function groupHunks(ops, context, totalOld, totalNew) {
  const changes = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'ctx') changes.push(i);
  }
  if (changes.length === 0) return [];

  const hunks = [];
  let hunkStart = Math.max(0, changes[0] - context);
  let hunkEnd = Math.min(ops.length - 1, changes[0] + context);

  for (let c = 1; c < changes.length; c++) {
    const nextStart = Math.max(0, changes[c] - context);
    const nextEnd = Math.min(ops.length - 1, changes[c] + context);
    if (nextStart <= hunkEnd + 1) {
      hunkEnd = nextEnd;
    } else {
      hunks.push(buildHunk(ops, hunkStart, hunkEnd));
      hunkStart = nextStart;
      hunkEnd = nextEnd;
    }
  }
  hunks.push(buildHunk(ops, hunkStart, hunkEnd));
  return hunks;
}

function buildHunk(ops, start, end) {
  const lines = ops.slice(start, end + 1);
  let oldStart = 0, newStart = 0;
  for (const line of lines) {
    if (line.oldIdx !== undefined) { oldStart = line.oldIdx; break; }
    if (line.newIdx !== undefined) { newStart = line.newIdx; break; }
  }
  return { oldStart, newStart, lines };
}

export function diffForEdit(oldContent, oldString, newString) {
  const newContent = oldContent.replace(oldString, newString);
  return unifiedDiff(oldContent, newContent);
}

export function diffForLineEdit(oldContent, startLine, endLine, newString) {
  const lines = oldContent.split('\n');
  const start = startLine - 1;
  const end = endLine;
  const newLines = newString.split('\n');
  if (newLines[newLines.length - 1] === '') newLines.pop();
  
  const pre = lines.slice(0, start);
  const post = lines.slice(end);
  const newContent = [...pre, ...newLines, ...post].join('\n');
  
  return unifiedDiff(oldContent, newContent);
}
