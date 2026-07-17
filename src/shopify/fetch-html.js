const axios = require('axios');
const cheerio = require('cheerio');

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'path', 'template', 'iframe']);
const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'button', 'a', 'label', 'p', 'li']);
const SEMANTIC_TAGS = new Set(['h1','h2','h3','h4','h5','form','button','a','p','ul','li','label','section','nav','article','aside']);

// ─── Tailwind class filter ────────────────────────────────────────────────────

const TAILWIND_WORDS = new Set([
  // Display
  'flex','inline-flex','block','inline-block','inline','grid','inline-grid',
  'contents','table','flow-root','hidden','list-item',
  // Position
  'relative','absolute','fixed','sticky','static',
  // Visibility
  'visible','invisible','collapse',
  // Box
  'box-border','box-content',
  // Isolation
  'isolate','isolation-auto',
  // Float/clear
  'float-right','float-left','float-none',
  'clear-left','clear-right','clear-both','clear-none','clearfix',
  // Overflow (compound words)
  'overflow-auto','overflow-hidden','overflow-visible','overflow-scroll','overflow-clip',
  'overflow-x-auto','overflow-x-hidden','overflow-y-auto','overflow-y-hidden',
  'overscroll-auto','overscroll-contain','overscroll-none',
  // Flex layout
  'flex-row','flex-row-reverse','flex-col','flex-col-reverse',
  'flex-wrap','flex-wrap-reverse','flex-nowrap',
  'flex-1','flex-auto','flex-none','flex-initial',
  'grow','grow-0','shrink','shrink-0',
  'order-first','order-last','order-none',
  // Align/justify
  'items-start','items-end','items-center','items-baseline','items-stretch',
  'justify-start','justify-end','justify-center','justify-between',
  'justify-around','justify-evenly','justify-stretch','justify-normal',
  'self-auto','self-start','self-end','self-center','self-stretch','self-baseline',
  'content-start','content-end','content-center','content-between',
  'content-around','content-evenly','content-stretch','content-normal','content-baseline',
  'place-items-start','place-items-end','place-items-center','place-items-baseline','place-items-stretch',
  'place-self-auto','place-self-start','place-self-end','place-self-center','place-self-stretch',
  // Grid helpers
  'col-auto','col-span-full','row-auto','row-span-full',
  // Typography
  'italic','not-italic',
  'underline','overline','line-through','no-underline',
  'uppercase','lowercase','capitalize','normal-case',
  'antialiased','subpixel-antialiased',
  'truncate','text-ellipsis','text-clip',
  'whitespace-normal','whitespace-nowrap','whitespace-pre',
  'whitespace-pre-line','whitespace-pre-wrap','whitespace-break-spaces',
  'break-normal','break-words','break-all','break-keep',
  'font-thin','font-extralight','font-light','font-normal',
  'font-medium','font-semibold','font-bold','font-extrabold','font-black',
  'text-left','text-center','text-right','text-justify','text-start','text-end',
  'text-xs','text-sm','text-base','text-lg','text-xl',
  'text-2xl','text-3xl','text-4xl','text-5xl','text-6xl','text-7xl','text-8xl','text-9xl',
  'leading-none','leading-tight','leading-snug','leading-normal','leading-relaxed','leading-loose',
  'tracking-tighter','tracking-tight','tracking-normal','tracking-wide','tracking-wider','tracking-widest',
  // Borders
  'border','border-0','border-2','border-4','border-8',
  'border-x','border-y','border-t','border-r','border-b','border-l',
  'border-solid','border-dashed','border-dotted','border-double','border-hidden','border-none',
  'border-collapse','border-separate',
  'divide-x','divide-y',
  'rounded','rounded-none','rounded-sm','rounded-md','rounded-lg',
  'rounded-xl','rounded-2xl','rounded-3xl','rounded-full',
  // Shadow / ring / outline
  'shadow','shadow-sm','shadow-md','shadow-lg','shadow-xl','shadow-2xl','shadow-inner','shadow-none',
  'ring','ring-0','ring-1','ring-2','ring-4','ring-8','ring-inset',
  'outline','outline-none','outline-0',
  // Transition / animation
  'transition','transition-none','transition-all','transition-colors',
  'transition-opacity','transition-shadow','transition-transform',
  'ease-linear','ease-in','ease-out','ease-in-out',
  'animate-none','animate-spin','animate-ping','animate-pulse','animate-bounce',
  // Transform
  'transform','transform-none','transform-gpu','transform-cpu',
  // Cursor / interaction
  'cursor-auto','cursor-default','cursor-pointer','cursor-wait','cursor-text',
  'cursor-move','cursor-help','cursor-not-allowed','cursor-none',
  'cursor-grab','cursor-grabbing','cursor-zoom-in','cursor-zoom-out',
  'pointer-events-none','pointer-events-auto',
  'select-none','select-text','select-all','select-auto',
  'resize','resize-none','resize-y','resize-x',
  'appearance-none','appearance-auto',
  // Filters (no suffix)
  'grayscale','grayscale-0','invert','invert-0','sepia','sepia-0',
  // Object fit
  'object-contain','object-cover','object-fill','object-none','object-scale-down',
  'object-left','object-right','object-top','object-bottom','object-center',
  // Lists / tables
  'table-auto','table-fixed',
  'list-none','list-disc','list-decimal','list-inside','list-outside',
  // Misc
  'container','sr-only','not-sr-only','group','peer',
  'ltr','rtl',
  'will-change-auto','will-change-scroll','will-change-contents','will-change-transform',
]);

// Tailwind prefixes where anything following the dash is also Tailwind
const TAILWIND_PREFIX_RE = /^(flex|grid|items|justify|self|place|object|overflow|overflow-x|overflow-y|overscroll|cursor|select|col|row|grid-cols|grid-rows|gap|gap-x|gap-y|space-x|space-y|divide|basis|order|grow|shrink|scale|rotate|skew|translate-x|translate-y|origin|blur|brightness|contrast|hue-rotate|saturate|sepia|grayscale|backdrop|drop-shadow|mix-blend|bg-blend|animate|transition|ease|duration|delay|will-change|touch|snap|scroll|aspect|columns|float|clear|inset|inset-x|inset-y)-/;

function isTailwindClass(cls) {
  if (!cls) return false;
  // BEM element (__) or modifier (--) → semantic, never Tailwind
  if (cls.includes('__') || cls.includes('--')) return false;
  // Responsive / state variants  (hover:, md:, focus-within:, etc.)
  if (cls.includes(':')) return true;
  // Arbitrary CSS values  (w-[45%], text-[rgb(…)])
  if (cls.includes('[')) return true;
  // Negative utilities  (-mt-4, -translate-x-1)
  if (cls.startsWith('-')) return true;
  // Exact match against known single / compound utility words
  if (TAILWIND_WORDS.has(cls)) return true;
  // utility-NUMBER  px-4, py-2.5, mt-4, z-10, w-12, h-8, gap-2 …
  if (/^[a-z][-a-z]*-\d+(\.\d+)?$/.test(cls)) return true;
  // fraction utilities  w-1/2, w-2/3
  if (/^[a-z][-a-z]*-\d+\/\d+$/.test(cls)) return true;
  // Tailwind color scale  bg-red-500, text-gray-900, border-slate-200
  if (/^(bg|text|border|ring|from|via|to|shadow|fill|stroke|caret|accent|decoration)-[a-z]+-\d{2,3}$/.test(cls)) return true;
  // Unambiguously-Tailwind prefix groups
  if (TAILWIND_PREFIX_RE.test(cls)) return true;
  return false;
}

function filterClasses(rawClass) {
  return (rawClass || '').trim().split(/\s+/).filter(c => c && !isTailwindClass(c));
}

async function getStorefrontCookies(baseUrl, password) {
  try {
    const resp = await axios.post(
      `${baseUrl}/password`,
      `form_type=storefront_password&password=${encodeURIComponent(password)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: (s) => s < 500,
      }
    );
    const setCookie = resp.headers['set-cookie'] || [];
    return setCookie.map((c) => c.split(';')[0]).join('; ');
  } catch (err) {
    const setCookie = err.response?.headers?.['set-cookie'] || [];
    return setCookie.map((c) => c.split(';')[0]).join('; ');
  }
}

async function fetchStorefrontPage(store, urlOrPath, password = null) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `https://${store}${urlOrPath}`;
  const baseUrl = new URL(url).origin;
  let cookies = '';

  if (password) {
    cookies = await getStorefrontCookies(baseUrl, password);
  }

  const resp = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    timeout: 15000,
  });

  if (resp.data?.includes('form_type=storefront_password')) {
    throw new Error('STORE_PASSWORD_REQUIRED');
  }

  return resp.data;
}

function serializeTree($, $root, depth = 0) {
  if (depth > 10) return [];
  const lines = [];

  $root.children().each((_, el) => {
    if (el.type !== 'tag') return;
    const $el = $(el);
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;

    const cls = filterClasses($el.attr('class')).join('.');
    const id = $el.attr('id') ? '#' + $el.attr('id') : '';
    const type = $el.attr('type') ? '[type=' + $el.attr('type') + ']' : '';
    const name = $el.attr('name') ? '[name=' + $el.attr('name') + ']' : '';

    const selector = tag + (cls ? '.' + cls : '') + id + type + name;

    let text = '';
    if (TEXT_TAGS.has(tag)) {
      const t = $el.clone().children().remove().end().text().trim().replace(/\s+/g, ' ').slice(0, 50);
      if (t) text = ' => ' + JSON.stringify(t);
    }

    // Skip structureless wrapper divs — just recurse into children
    if (!cls && !id && !SEMANTIC_TAGS.has(tag)) {
      lines.push(...serializeTree($, $el, depth));
      return;
    }

    lines.push('  '.repeat(depth) + selector + text);
    lines.push(...serializeTree($, $el, depth + 1));
  });

  return lines;
}

function buildPageTree(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();

  const result = {};

  const $header = $('header, #header-group').first();
  if ($header.length) result.header = serializeTree($, $header).join('\n');

  const $main = $('main, #MainContent, [role="main"]').first();
  if ($main.length) result.main = serializeTree($, $main).join('\n');

  const $footer = $('footer').first();
  if ($footer.length) result.footer = serializeTree($, $footer).join('\n');

  return result;
}

async function fetchPageElements(store, urlOrPath, password = null) {
  const html = await fetchStorefrontPage(store, urlOrPath, password);
  return buildPageTree(html);
}

module.exports = { fetchPageElements };
