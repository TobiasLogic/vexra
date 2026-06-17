import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import { simpleGlob } from './glob.js';

const MAX_FILE_SIZE = 50 * 1024;
const MAX_TOTAL_SIZE = 200 * 1024;

export function expandMentions(text, cwd = process.cwd()) {
  const mentions = [];
  const regex = /@([^\s@]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    mentions.push({ token: match[0], path: match[1], index: match.index });
  }
  return mentions;
}

export function resolveMentions(text, cwd = process.cwd()) {
  const mentions = expandMentions(text);
  if (mentions.length === 0) return { text, context: '', images: [] };

  let contextParts = [];
  let images = [];
  let totalSize = 0;
  let cleanText = text;
  let limitReached = false;

  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

  for (const mention of mentions) {
    if (limitReached) break;

    let paths = [mention.path];
    if (mention.path.includes('*')) {
      paths = simpleGlob(mention.path, cwd).map(p => relative(cwd, p));
      if (paths.length === 0) {
        contextParts.push(`[No files matched: ${mention.path}]`);
        continue;
      }
    }

    for (const pathStr of paths) {
      if (limitReached) break;

      const fullPath = resolve(cwd, pathStr);
      const relPath = relative(cwd, fullPath);

      if (!existsSync(fullPath)) {
        contextParts.push(`[File not found: ${pathStr}]`);
        continue;
      }

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          contextParts.push(`[${pathStr} is a directory, not a file]`);
          continue;
        }

        const ext = (relPath.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        if (imageExts.has(ext)) {
          const mimeType = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
          const base64 = readFileSync(fullPath, 'base64');
          images.push({
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` }
          });
          continue;
        }

        if (stat.size > MAX_FILE_SIZE) {
          const content = readFileSync(fullPath, 'utf-8').slice(0, MAX_FILE_SIZE);
          contextParts.push(`--- ${relPath} (truncated at ${MAX_FILE_SIZE} bytes) ---\n${content}\n--- end ${relPath} ---`);
          totalSize += MAX_FILE_SIZE;
        } else {
          const content = readFileSync(fullPath, 'utf-8');
          contextParts.push(`--- ${relPath} ---\n${content}\n--- end ${relPath} ---`);
          totalSize += content.length;
        }
      } catch (err) {
        contextParts.push(`[Error reading ${pathStr}: ${err.message}]`);
      }

      if (totalSize > MAX_TOTAL_SIZE) {
        contextParts.push(`[Total context limit reached, remaining files skipped]`);
        limitReached = true;
      }
    }
  }

  const context = contextParts.length > 0
    ? '\n\nAttached file contents:\n\n' + contextParts.join('\n\n')
    : '';

  return { text: cleanText, context, images };
}
