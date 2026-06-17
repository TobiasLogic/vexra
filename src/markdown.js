import chalk from 'chalk';

const RULES = [
  { re: /^#{1}\s+(.+)$/, fn: (_, t) => '\n' + chalk.bold.underline.hex('#36D0D0')(t) + '\n' },
  { re: /^#{2}\s+(.+)$/, fn: (_, t) => '\n' + chalk.bold.hex('#36D0D0')(t) + '\n' },
  { re: /^#{3,6}\s+(.+)$/, fn: (_, t) => '\n' + chalk.bold(t) + '\n' },
  { re: /^>\s?(.*)$/, fn: (_, t) => chalk.dim('│ ') + chalk.italic.dim(t) },
  { re: /^[-*]\s+(.+)$/, fn: (_, t) => '  ' + chalk.hex('#36D0D0')('•') + ' ' + styleInline(t) },
  { re: /^\d+\.\s+(.+)$/, fn: (m, t) => '  ' + chalk.dim(m.match(/^\d+\./)[0]) + ' ' + styleInline(t) },
  { re: /^---+$/, fn: () => chalk.dim('─'.repeat(40)) },
  { re: /^```(.*)$/, fn: () => null },
];

function styleInline(text) {
  let out = text;
  out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t));
  out = out.replace(/__(.+?)__/g, (_, t) => chalk.bold(t));
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => chalk.italic(t));
  out = out.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, t) => chalk.italic(t));
  out = out.replace(/~~(.+?)~~/g, (_, t) => chalk.strikethrough(t));
  out = out.replace(/`([^`]+)`/g, (_, t) => chalk.cyan(t));
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => chalk.underline.blue(text) + chalk.dim(`(${url})`));
  return out;
}

export function renderMarkdownLine(line) {
  for (const rule of RULES) {
    const m = line.match(rule.re);
    if (m) {
      const result = rule.fn(m, m[1] || '');
      if (result === null) return null;
      return result;
    }
  }
  return styleInline(line);
}

export function createMarkdownStreamWriter() {
  let inCodeBlock = false;
  let codeBlockLang = '';

  return function write(raw) {
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (inCodeBlock) {
        if (line.trimEnd() === '```' || line.trimEnd() === '```\r') {
          inCodeBlock = false;
          process.stdout.write('\n');
        } else {
          process.stdout.write(line + (i < lines.length - 1 ? '\n' : ''));
        }
        continue;
      }

      const codeMatch = line.match(/^```(.*)$/);
      if (codeMatch) {
        inCodeBlock = true;
        codeBlockLang = codeMatch[1].trim();
        process.stdout.write(chalk.dim('  ┌─') + chalk.dim(codeBlockLang || 'code') + '\n');
        continue;
      }

      const rendered = renderMarkdownLine(line);
      if (rendered !== null) {
        process.stdout.write(rendered + (i < lines.length - 1 ? '\n' : ''));
      }
    }
  };
}
