import chalk from 'chalk';

const BLOCKS = ['▃', '▄', '▅', '▆', '▇', '█'];

const SPINNER_SETS = {
  dots:    ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  arc:     ['◜', '◠', '◝', '◞', '◡', '◟'],
  bounce:  ['⎺', '⎻', '⎼', '⎽', '⎼', '⎻'],
  circle:  ['◐', '◓', '◑', '◒'],
  square:  ['◰', '◳', '◲', '◱'],
  line:    ['|', '/', '-', '\\'],
  grow:    ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█', '▉', '▊', '▋', '▌', '▍', '▎'],
  flip:    ['_', '_', '_', '_', '-', '`', '-', '_', '_', '_'],
  braille: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
  clock:   ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'],
};

const TEAL = [54, 208, 208];
const CYAN = [0, 255, 255];
const PURPLE = [180, 100, 255];
const PINK = [255, 100, 180];
const GREEN = [72, 224, 128];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function rainbowColor(t) {
  const r = Math.round(127.5 + 127.5 * Math.sin(t));
  const g = Math.round(127.5 + 127.5 * Math.sin(t + 2.094));
  const b = Math.round(127.5 + 127.5 * Math.sin(t + 4.189));
  return [r, g, b];
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\r\x1b[2K';

function isTty() {
  return !!process.stdout.isTTY && chalk.level > 0;
}

export function buildFrame(t, width) {
  let out = '';
  for (let i = 0; i < width; i++) {
    const wave =
      0.5 +
      0.38 * Math.sin(i * 0.5 - t * 0.35) +
      0.12 * Math.sin(i * 0.23 + t * 0.21 + 1.3);
    const b = clamp01(wave);

    const ch = BLOCKS[Math.round(b * (BLOCKS.length - 1))];
    const r = Math.round(lerp(34, 150, b));
    const g = Math.round(lerp(78, 245, b));
    const bl = Math.round(lerp(92, 240, b));

    out += chalk.rgb(r, g, bl)(ch);
  }
  return out;
}

export function createShimmer(label = '', { width, intervalMs = 70 } = {}) {
  const tty = isTty();
  const cols = process.stdout.columns || 80;
  const labelText = label ? label + ' ' : '';
  const W = Math.max(8, Math.min(width || 24, cols - labelText.length - 2));

  let timer = null;
  let t = 0;
  let running = false;

  function render() {
    process.stdout.write('\r' + chalk.dim(labelText) + buildFrame(t, W) + '\x1b[K');
    t++;
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!tty) {
        process.stdout.write(chalk.dim((label || 'Working') + '…') + '\n');
        return;
      }
      process.stdout.write(HIDE_CURSOR);
      render();
      timer = setInterval(render, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!running) return;
      running = false;
      if (!tty) return;
      if (timer) { clearInterval(timer); timer = null; }
      process.stdout.write(CLEAR_LINE + SHOW_CURSOR);
    },
  };
}

export async function shimmerText(text, opts = {}) {
  const {
    base = TEAL,
    peak = [236, 255, 255],
    prefix = '',
    suffix = '',
    intervalMs = 28,
    bold = true,
    spread = 2.3,
    stepChars = 0.5,
  } = opts;

  const chars = [...text];
  const baseStyle = bold ? chalk.bold.rgb(base[0], base[1], base[2]) : chalk.rgb(base[0], base[1], base[2]);
  const staticLine = prefix + baseStyle(text) + suffix;

  const tty = isTty();
  if (!tty || chars.length === 0) {
    process.stdout.write(staticLine + '\n');
    return;
  }

  const startPos = -spread;
  const endPos = chars.length - 1 + spread;
  const steps = Math.max(1, Math.round((endPos - startPos) / stepChars));

  let interrupted = false;
  const onSig = () => {
    interrupted = true;
    process.stdout.write('\r' + staticLine + '\x1b[K' + SHOW_CURSOR + '\n');
    process.exit(0);
  };
  process.once('SIGINT', onSig);
  process.stdout.write(HIDE_CURSOR);

  try {
    for (let s = 0; s <= steps; s++) {
      const pos = startPos + (s / steps) * (endPos - startPos);
      let line = prefix;
      for (let i = 0; i < chars.length; i++) {
        const b = clamp01(1 - Math.abs(i - pos) / spread);
        const r = Math.round(base[0] + (peak[0] - base[0]) * b);
        const g = Math.round(base[1] + (peak[1] - base[1]) * b);
        const bl = Math.round(base[2] + (peak[2] - base[2]) * b);
        const style = bold ? chalk.bold.rgb(r, g, bl) : chalk.rgb(r, g, bl);
        line += style(chars[i]);
      }
      line += suffix;
      process.stdout.write('\r' + line + '\x1b[K');
      await sleep(intervalMs);
    }
  } finally {
    if (!interrupted) {
      process.stdout.write('\r' + staticLine + '\x1b[K' + SHOW_CURSOR + '\n');
      process.removeListener('SIGINT', onSig);
    }
  }
}

export function createSpinner(label = '', opts = {}) {
  const {
    style = 'braille',
    intervalMs = 80,
    color = TEAL,
    rainbow = false,
  } = opts;

  const tty = isTty();
  const frames = SPINNER_SETS[style] || SPINNER_SETS.braille;
  let timer = null;
  let idx = 0;
  let running = false;
  let t = 0;

  function render() {
    const frame = frames[idx % frames.length];
    const c = rainbow ? rainbowColor(t * 0.15) : color;
    const styled = chalk.bold.rgb(c[0], c[1], c[2])(frame);
    const text = label ? ' ' + chalk.dim(label) : '';
    process.stdout.write('\r' + styled + text + '\x1b[K');
    idx++;
    t++;
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!tty) {
        process.stdout.write(chalk.dim((label || 'Working') + '…') + '\n');
        return;
      }
      process.stdout.write(HIDE_CURSOR);
      render();
      timer = setInterval(render, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop(finalLabel) {
      if (!running) return;
      running = false;
      if (!tty) return;
      if (timer) { clearInterval(timer); timer = null; }
      if (finalLabel) {
        process.stdout.write(CLEAR_LINE + chalk.green('✔') + ' ' + chalk.dim(finalLabel) + '\n');
      } else {
        process.stdout.write(CLEAR_LINE);
      }
      process.stdout.write(SHOW_CURSOR);
    },
    update(newLabel) {
      label = newLabel;
    },
  };
}

export function createPulse(label = '', opts = {}) {
  const {
    intervalMs = 60,
    color = TEAL,
    width = 30,
  } = opts;

  const tty = isTty();
  let timer = null;
  let t = 0;
  let running = false;

  function render() {
    const phase = t * 0.08;
    let out = '';
    for (let i = 0; i < width; i++) {
      const wave = 0.5 + 0.5 * Math.sin(i * 0.3 - phase);
      const b = clamp01(wave);
      const alpha = 0.3 + 0.7 * b;
      const r = Math.round(color[0] * alpha);
      const g = Math.round(color[1] * alpha);
      const bl = Math.round(color[2] * alpha);
      const ch = b > 0.7 ? '█' : b > 0.4 ? '▓' : b > 0.2 ? '▒' : '░';
      out += chalk.rgb(r, g, bl)(ch);
    }
    const text = label ? ' ' + chalk.dim(label) : '';
    process.stdout.write('\r' + out + text + '\x1b[K');
    t++;
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!tty) {
        process.stdout.write(chalk.dim((label || 'Working') + '…') + '\n');
        return;
      }
      process.stdout.write(HIDE_CURSOR);
      render();
      timer = setInterval(render, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!running) return;
      running = false;
      if (!tty) return;
      if (timer) { clearInterval(timer); timer = null; }
      process.stdout.write(CLEAR_LINE + SHOW_CURSOR);
    },
  };
}

export function createGradientBar(label = '', opts = {}) {
  const {
    intervalMs = 50,
    width = 40,
    colors = [TEAL, PURPLE, PINK, TEAL],
  } = opts;

  const tty = isTty();
  let timer = null;
  let t = 0;
  let running = false;

  function getColorAt(pos) {
    const segCount = colors.length - 1;
    const scaled = ((pos % 1) + 1) % 1 * segCount;
    const seg = Math.floor(scaled);
    const frac = scaled - seg;
    return lerpColor(colors[Math.min(seg, segCount)], colors[Math.min(seg + 1, segCount)], frac);
  }

  function render() {
    const offset = t * 0.03;
    let out = '';
    for (let i = 0; i < width; i++) {
      const pos = (i / width + offset) % 1;
      const c = getColorAt(pos);
      const brightness = 0.6 + 0.4 * Math.sin(i * 0.2 - t * 0.12);
      const r = Math.round(c[0] * brightness);
      const g = Math.round(c[1] * brightness);
      const b = Math.round(c[2] * brightness);
      out += chalk.rgb(r, g, b)('▓');
    }
    const text = label ? ' ' + chalk.dim(label) : '';
    process.stdout.write('\r' + out + text + '\x1b[K');
    t++;
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!tty) {
        process.stdout.write(chalk.dim((label || 'Working') + '…') + '\n');
        return;
      }
      process.stdout.write(HIDE_CURSOR);
      render();
      timer = setInterval(render, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!running) return;
      running = false;
      if (!tty) return;
      if (timer) { clearInterval(timer); timer = null; }
      process.stdout.write(CLEAR_LINE + SHOW_CURSOR);
    },
  };
}

export function createParticles(label = '', opts = {}) {
  const {
    intervalMs = 65,
    width = 36,
    color = CYAN,
    particleCount = 6,
  } = opts;

  const tty = isTty();
  let timer = null;
  let t = 0;
  let running = false;

  const particles = Array.from({ length: particleCount }, (_, i) => ({
    pos: (i / particleCount) * width,
    speed: 0.4 + Math.random() * 0.6,
    size: 1 + Math.random() * 2,
  }));

  function render() {
    const grid = new Array(width).fill(0);
    for (const p of particles) {
      p.pos += p.speed;
      if (p.pos >= width) p.pos -= width;
      const idx = Math.floor(p.pos);
      for (let d = -1; d <= 1; d++) {
        const ci = idx + d;
        if (ci >= 0 && ci < width) {
          const dist = Math.abs(p.pos - ci);
          grid[ci] = Math.max(grid[ci], clamp01(1 - dist / p.size));
        }
      }
    }

    let out = '';
    for (let i = 0; i < width; i++) {
      const b = grid[i];
      if (b > 0.01) {
        const r = Math.round(color[0] * b);
        const g = Math.round(color[1] * b);
        const bl = Math.round(color[2] * b);
        const ch = b > 0.7 ? '●' : b > 0.3 ? '○' : '·';
        out += chalk.rgb(r, g, bl)(ch);
      } else {
        out += chalk.dim('·');
      }
    }
    const text = label ? ' ' + chalk.dim(label) : '';
    process.stdout.write('\r' + out + text + '\x1b[K');
    t++;
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!tty) {
        process.stdout.write(chalk.dim((label || 'Working') + '…') + '\n');
        return;
      }
      process.stdout.write(HIDE_CURSOR);
      render();
      timer = setInterval(render, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!running) return;
      running = false;
      if (!tty) return;
      if (timer) { clearInterval(timer); timer = null; }
      process.stdout.write(CLEAR_LINE + SHOW_CURSOR);
    },
  };
}

export async function typewriter(text, opts = {}) {
  const {
    intervalMs = 18,
    color = null,
    bold: isBold = false,
    prefix = '',
    suffix = '',
  } = opts;

  const tty = isTty();
  const chars = [...text];

  if (!tty || chars.length === 0) {
    const styled = color
      ? (isBold ? chalk.bold.rgb(color[0], color[1], color[2]) : chalk.rgb(color[0], color[1], color[2]))(text)
      : (isBold ? chalk.bold(text) : text);
    process.stdout.write(prefix + styled + suffix + '\n');
    return;
  }

  let interrupted = false;
  const onSig = () => {
    interrupted = true;
    process.stdout.write(prefix + text + suffix + SHOW_CURSOR + '\n');
    process.exit(0);
  };
  process.once('SIGINT', onSig);

  try {
    for (let i = 0; i <= chars.length; i++) {
      const visible = chars.slice(0, i).join('');
      const styled = color
        ? (isBold ? chalk.bold.rgb(color[0], color[1], color[2]) : chalk.rgb(color[0], color[1], color[2]))(visible)
        : (isBold ? chalk.bold(visible) : visible);
      process.stdout.write('\r' + prefix + styled + '\x1b[K');
      await sleep(intervalMs);
    }
  } finally {
    if (!interrupted) {
      const finalStyled = color
        ? (isBold ? chalk.bold.rgb(color[0], color[1], color[2]) : chalk.rgb(color[0], color[1], color[2]))(text)
        : (isBold ? chalk.bold(text) : text);
      process.stdout.write('\r' + prefix + finalStyled + suffix + SHOW_CURSOR + '\n');
      process.removeListener('SIGINT', onSig);
    }
  }
}

export async function animateBorder(width, opts = {}) {
  const {
    intervalMs = 35,
    color = TEAL,
    rainbow = false,
    style = 'round',
  } = opts;

  const tty = isTty();
  const borders = {
    round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
    double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
    bold: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  };
  const b = borders[style] || borders.round;
  const innerW = width - 2;

  if (!tty) {
    console.log(b.tl + b.h.repeat(innerW) + b.tr);
    console.log(b.v + ' '.repeat(innerW) + b.v);
    console.log(b.bl + b.h.repeat(innerW) + b.br);
    return;
  }

  const totalChars = (innerW * 2) + 2;
  const sweepLen = Math.floor(totalChars * 0.3);
  const steps = Math.min(totalChars + sweepLen + 5, 50);

  function buildFrame(headPos) {
    function charColor(idx) {
      const dist = Math.abs(((idx - headPos % totalChars) + totalChars) % totalChars);
      const wrapDist = Math.min(dist, totalChars - dist);
      if (wrapDist > sweepLen) {
        const c = rainbow ? rainbowColor(idx * 0.1) : color;
        return chalk.rgb(c[0], c[1], c[2]);
      }
      const brightness = 1 - (wrapDist / sweepLen) * 0.6;
      const c = rainbow ? rainbowColor(idx * 0.1) : color;
      return chalk.bold.rgb(
        Math.min(255, Math.round(c[0] * brightness + 255 * (1 - brightness) * 0.5)),
        Math.min(255, Math.round(c[1] * brightness + 255 * (1 - brightness) * 0.5)),
        Math.min(255, Math.round(c[2] * brightness + 255 * (1 - brightness) * 0.5)),
      );
    }

    let line1 = charColor(0)(b.tl);
    for (let i = 0; i < innerW; i++) line1 += charColor(i + 1)(b.h);
    line1 += charColor(innerW + 1)(b.tr);

    let line2 = charColor(totalChars - 1)(b.v) + ' '.repeat(innerW) + charColor(innerW + 2)(b.v);

    let line3 = charColor(totalChars - 2)(b.bl);
    for (let i = 0; i < innerW; i++) line3 += charColor(totalChars - 3 - i)(b.h);
    line3 += charColor(innerW + 3)(b.br);

    return line1 + '\n' + line2 + '\n' + line3;
  }

  process.stdout.write(HIDE_CURSOR);
  process.stdout.write('\x1b[s');
  process.stdout.write(buildFrame(0) + '\n');
  await sleep(intervalMs);

  for (let s = 1; s < steps; s++) {
    process.stdout.write('\x1b[u' + buildFrame(s) + '\n');
    await sleep(intervalMs);
  }

  const c = rainbow ? rainbowColor(0) : color;
  const st = chalk.rgb(c[0], c[1], c[2]);
  const final = st(b.tl + b.h.repeat(innerW) + b.tr) + '\n'
    + st(b.v) + ' '.repeat(innerW) + st(b.v) + '\n'
    + st(b.bl + b.h.repeat(innerW) + b.br);
  process.stdout.write('\x1b[u' + final + '\n' + SHOW_CURSOR);
}

export async function fadeTransition(text, opts = {}) {
  const {
    intervalMs = 30,
    color = TEAL,
    direction = 'in',
    bold: isBold = true,
  } = opts;

  const tty = isTty();
  if (!tty) {
    process.stdout.write(text + '\n');
    return;
  }

  const chars = [...text];
  const steps = 12;

  for (let s = 0; s <= steps; s++) {
    const progress = direction === 'in' ? s / steps : 1 - s / steps;
    let line = '';
    for (let i = 0; i < chars.length; i++) {
      const charProgress = clamp01(progress * 1.5 - (i / chars.length) * 0.5);
      const alpha = charProgress;
      const r = Math.round(color[0] * alpha);
      const g = Math.round(color[1] * alpha);
      const bl = Math.round(color[2] * alpha);
      const style = isBold ? chalk.bold.rgb(r, g, bl) : chalk.rgb(r, g, bl);
      line += style(chars[i]);
    }
    process.stdout.write('\r' + line + '\x1b[K');
    await sleep(intervalMs);
  }
  process.stdout.write('\n');
}

export function createMatrix(label = '', opts = {}) {
  const {
    intervalMs = 70,
    width = 30,
    color = GREEN,
  } = opts;

  const tty = isTty();
  const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0123456789';
  let timer = null;
  let running = false;

  const columns = Array.from({ length: width }, () => ({
    char: glyphs[Math.floor(Math.random() * glyphs.length)],
    brightness: Math.random(),
    targetBrightness: Math.random(),
  }));

  function render() {
    let out = '';
    for (const col of columns) {
      if (Math.random() < 0.15) {
        col.char = glyphs[Math.floor(Math.random() * glyphs.length)];
        col.targetBrightness = 0.3 + Math.random() * 0.7;
      }
      col.brightness += (col.targetBrightness - col.brightness) * 0.2;
      const b = clamp01(col.brightness);
      const r = Math.round(color[0] * b);
      const g = Math.round(color[1] * b);
      const bl = Math.round(color[2] * b);
      out += chalk.rgb(r, g, bl)(col.char);
    }
    const text = label ? ' ' + chalk.dim(label) : '';
    process.stdout.write('\r' + out + text + '\x1b[K');
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!tty) {
        process.stdout.write(chalk.dim((label || 'Working') + '…') + '\n');
        return;
      }
      process.stdout.write(HIDE_CURSOR);
      render();
      timer = setInterval(render, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!running) return;
      running = false;
      if (!tty) return;
      if (timer) { clearInterval(timer); timer = null; }
      process.stdout.write(CLEAR_LINE + SHOW_CURSOR);
    },
  };
}

export async function progressBar(current, total, opts = {}) {
  const {
    width = 30,
    color = TEAL,
    label = '',
    showPercent = true,
  } = opts;

  const pct = clamp01(current / total);
  const filled = Math.round(width * pct);
  const empty = width - filled;

  let bar = '';
  for (let i = 0; i < filled; i++) {
    const t = i / width;
    const c = lerpColor(color, CYAN, t);
    bar += chalk.rgb(c[0], c[1], c[2])('█');
  }
  bar += chalk.dim('░'.repeat(empty));

  const pctText = showPercent ? ` ${chalk.dim(`${Math.round(pct * 100)}%`)}` : '';
  const labelText = label ? ` ${chalk.dim(label)}` : '';
  process.stdout.write('\r' + bar + pctText + labelText + '\x1b[K');
}

export async function animateCountUp(from, to, opts = {}) {
  const {
    durationMs = 800,
    intervalMs = 30,
    color = TEAL,
    prefix = '',
    suffix = '',
    bold: isBold = true,
  } = opts;

  const tty = isTty();
  const steps = Math.max(1, Math.round(durationMs / intervalMs));
  const style = isBold ? chalk.bold.rgb(color[0], color[1], color[2]) : chalk.rgb(color[0], color[1], color[2]);

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(lerp(from, to, eased));
    process.stdout.write('\r' + prefix + style(String(val)) + suffix + '\x1b[K');
    if (tty) await sleep(intervalMs);
  }
  process.stdout.write('\n');
}
