import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

/**
 * The embeddable website chat widget.
 *
 *   <script src="http://localhost:3000/widget.js" async></script>
 *
 * Drops a floating chat bubble on any site; it calls POST /web/chat (CORS is
 * enabled in main.ts). GET /widget-demo renders a fake business site that
 * embeds the widget so you can test the full attach-to-website experience.
 */
@Public()
@Controller()
export class WidgetController {
  @Get('widget.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  script(): string {
    return WIDGET_JS;
  }

  @Get('widget-demo')
  @Header('Content-Type', 'text/html; charset=utf-8')
  demo(): string {
    return WIDGET_DEMO_HTML;
  }
}

const WIDGET_JS = `(function () {
  var cur = document.currentScript;
  var api = (function () { try { return new URL(cur.src).origin; } catch (e) { return window.location.origin; } })();
  var sid = localStorage.getItem('assisty_widget_sid') || ('wgt-' + Math.random().toString(36).slice(2, 10));
  localStorage.setItem('assisty_widget_sid', sid);

  var css = ''
    + '#asy-btn{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;background:#2563eb;color:#fff;'
    + 'display:flex;align-items:center;justify-content:center;font-size:26px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3);z-index:2147483000;}'
    + '#asy-panel{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);'
    + 'background:#0b0f17;color:#e6e9ef;border:1px solid #1f2937;border-radius:14px;display:none;flex-direction:column;overflow:hidden;'
    + 'box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:2147483000;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;}'
    + '#asy-head{background:#2563eb;color:#fff;padding:12px 14px;font-weight:600;font-size:14px;}'
    + '#asy-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;}'
    + '.asy-msg{max-width:82%;padding:9px 12px;border-radius:13px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}'
    + '.asy-user{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px;}'
    + '.asy-agent{align-self:flex-start;background:#1f2937;color:#e6e9ef;border-bottom-left-radius:4px;}'
    + '#asy-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #1f2937;}'
    + '#asy-in{flex:1;background:#111827;color:#e6e9ef;border:1px solid #374151;border-radius:9px;padding:9px 11px;font-size:14px;outline:none;}'
    + '#asy-send{background:#2563eb;color:#fff;border:0;border-radius:9px;padding:0 14px;font-weight:600;cursor:pointer;}'
    + '.asy-chip{display:inline-block;background:#1f2937;color:#cbd5e1;border:1px solid #374151;border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer;margin:2px;}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  var btn = document.createElement('div'); btn.id = 'asy-btn'; btn.textContent = '\\uD83D\\uDCAC';
  var panel = document.createElement('div'); panel.id = 'asy-panel';
  panel.innerHTML = '<div id="asy-head">Chat with us</div><div id="asy-log"></div>'
    + '<div id="asy-foot"><input id="asy-in" placeholder="Type a message..." autocomplete="off"/><button id="asy-send">Send</button></div>';
  document.body.appendChild(btn); document.body.appendChild(panel);

  var log = panel.querySelector('#asy-log');
  var inp = panel.querySelector('#asy-in');
  var snd = panel.querySelector('#asy-send');
  var greeted = false;

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function add(role, text) { var d = document.createElement('div'); d.className = 'asy-msg asy-' + role; d.innerHTML = esc(text); log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }

  btn.addEventListener('click', function () {
    var open = panel.style.display === 'flex';
    panel.style.display = open ? 'none' : 'flex';
    if (!open) { if (!greeted) { greeted = true; add('agent', 'Hi! How can I help you today?'); } inp.focus(); }
  });

  function chip(text, sendText) { var c = document.createElement('span'); c.className = 'asy-chip'; c.textContent = text; c.addEventListener('click', function () { sendMsg(sendText); }); return c; }
  function renderSugg(s) {
    if (!s) return;
    var box = document.createElement('div'); box.style.display = 'flex'; box.style.flexWrap = 'wrap'; box.style.alignSelf = 'flex-start'; box.style.maxWidth = '90%';
    var any = false;
    (s.products || []).forEach(function (p) { any = true; box.appendChild(chip('\\uD83D\\uDED2 ' + p.name + ' — ' + p.currency + ' ' + p.price, 'I want the ' + p.name)); });
    (s.attributePrompts || []).forEach(function (ap) { (ap.options || []).forEach(function (o) { any = true; box.appendChild(chip(o, ap.attribute + ' ' + o)); }); });
    (s.quickReplies || []).forEach(function (q) { if (q && q.label) { any = true; box.appendChild(chip(q.label, q.label)); } });
    if (any) { log.appendChild(box); log.scrollTop = log.scrollHeight; }
  }
  async function sendMsg(preset) {
    var t = (preset != null ? String(preset) : inp.value).trim(); if (!t) return;
    if (preset == null) inp.value = '';
    add('user', t); var p = add('agent', '...'); snd.disabled = true;
    try {
      var r = await fetch(api + '/web/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, text: t }) });
      var j = await r.json();
      p.textContent = (j && j.reply) ? j.reply : '[no reply]';
      if (j && j.suggestions) renderSugg(j.suggestions);
    } catch (e) { p.textContent = '[connection error]'; }
    finally { snd.disabled = false; inp.focus(); }
  }
  snd.addEventListener('click', function () { sendMsg(); });
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMsg(); });
})();`;

const WIDGET_DEMO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Acme — Demo Website</title>
<style>
  body{margin:0;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f8fafc;}
  .hero{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;padding:80px 24px;text-align:center;}
  .hero h1{font-size:40px;margin:0 0 10px;}
  .hero p{font-size:18px;opacity:.9;margin:0;}
  .wrap{max-width:900px;margin:0 auto;padding:40px 24px;}
  .note{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;color:#334155;}
</style></head>
<body>
  <div class="hero"><h1>Acme — Demo Website</h1><p>This is a pretend customer website. The Assisty widget is embedded bottom-right. 👉</p></div>
  <div class="wrap"><div class="note">
    <h3>Try the widget</h3>
    <p>Click the blue 💬 bubble in the bottom-right corner and ask about hours, products, returns, or an order number — it answers from the Knowledge Base you set in the console.</p>
    <p>To embed Assisty on a real site, paste this one line before <code>&lt;/body&gt;</code>:</p>
    <pre style="background:#0b0f17;color:#e6e9ef;padding:12px;border-radius:8px;overflow:auto;">&lt;script src="http://localhost:3000/widget.js" async&gt;&lt;/script&gt;</pre>
  </div></div>
  <script src="/widget.js" async></script>
</body></html>`;
