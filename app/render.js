import fs from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index].content || '[image blocked]');
md.validateLink = url => /^https?:\/\//i.test(url);

export function linkTimestamps(markdown, videoId, duration) {
  return markdown.replace(/\[(\d{1,2}:)?\d{2}:\d{2}\](?!\()/g, token => {
    const nums = token.slice(1, -1).split(':').map(Number);
    const seconds = nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration + 30) return token;
    return `${token}(https://www.youtube.com/watch?v=${videoId}&t=${seconds}s)`;
  });
}

export function renderMarkdown(markdown, job) {
  const linked = linkTimestamps(markdown, job.videoId, job.duration || 0);
  return sanitizeHtml(md.render(linked), {
    allowedTags: ['h1','h2','h3','h4','p','ul','ol','li','strong','em','blockquote','code','pre','hr','a','table','thead','tbody','tr','th','td'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https'], transformTags: {
      a: (tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' } })
    }
  });
}

export async function selfContainedHtml(job, jobDir, markdown) {
  let image = '';
  if (job.thumbnailFile) {
    try {
      const bytes = await fs.readFile(path.join(jobDir, job.thumbnailFile));
      const ext = path.extname(job.thumbnailFile).slice(1).replace('jpg', 'jpeg');
      image = `<img class="hero" alt="Video thumbnail" src="data:image/${ext};base64,${bytes.toString('base64')}">`;
    } catch {}
  }
  const body = renderMarkdown(markdown, job);
  const title = String(job.title || 'YouTube summary').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark;--bg:#fafafa;--fg:#171717;--card:#fff;--muted:#666;--link:#0759c7}@media(prefers-color-scheme:dark){:root{--bg:#101114;--fg:#eee;--card:#191b20;--muted:#aaa;--link:#83b5ff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.58 system-ui,sans-serif}main{max-width:850px;margin:auto;padding:18px}.hero{width:100%;max-height:430px;object-fit:cover;border-radius:14px}article{background:var(--card);padding:clamp(18px,4vw,38px);border-radius:14px;margin:16px 0}h1,h2,h3{line-height:1.2}a{color:var(--link)}pre{overflow:auto;padding:12px}table{display:block;overflow:auto;border-collapse:collapse}td,th{padding:6px;border:1px solid var(--muted)}.meta{color:var(--muted)}</style></head><body><main>${image}<article>${body}</article></main></body></html>`;
}
