import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
} from '@nestjs/common';

import { WebChatService } from './web-chat.service';
import { Public } from '../auth/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';

class ChatBody {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  sessionId?: string;

  @IsString()
  @MaxLength(4000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(6000)
  businessContext?: string;
}

@Public()
@Controller()
export class WebController {
  constructor(private readonly webChat: WebChatService) {}

  @Get('test')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return TEST_PAGE_HTML;
  }

  @Post('web/chat')
  @Throttle({ default: { limit: 20, ttl: 60000 } }) // public + cost-bearing: 20/min/IP
  async chat(@Body() body: ChatBody): Promise<unknown> {
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      throw new BadRequestException('text is required');
    }
    return this.webChat.chat(body.sessionId ?? 'anon', body.text, body.businessContext);
  }

  @Get('web/messages')
  async messages(@Query('sessionId') sessionId?: string): Promise<unknown> {
    return this.webChat.listMessages(sessionId ?? 'anon');
  }
}

const TEST_PAGE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Assisty — Operator Console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif; background: #0b0f17; color: #e6e9ef; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 18px; background: #111827; border-bottom: 1px solid #1f2937; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 650; }
  .badge { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #1f2937; color: #9ca3af; }
  .badge.ok { background: #064e3b; color: #6ee7b7; } .badge.bad { background: #7f1d1d; color: #fca5a5; }
  .spacer { flex: 1; } .meta { font-size: 12px; color: #6b7280; } a.link { color: #93c5fd; font-size: 12px; text-decoration: none; }
  .tabs { display: flex; gap: 6px; padding: 8px 18px; background: #0d131f; border-bottom: 1px solid #1f2937; flex-wrap: wrap; }
  .tab { padding: 7px 13px; border-radius: 8px; background: #1f2937; color: #cbd5e1; cursor: pointer; font-size: 13px; border: 0; }
  .tab.active { background: #2563eb; color: #fff; }
  .panel { flex: 1; overflow-y: auto; } .panel.hidden { display: none; }
  #chatPanel { display: flex; flex-direction: column; }
  #log { flex: 1; overflow-y: auto; padding: 20px; max-width: 880px; width: 100%; margin: 0 auto; }
  .row { display: flex; margin: 10px 0; } .row.user { justify-content: flex-end; }
  .bubble { max-width: 80%; padding: 10px 13px; border-radius: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .user .bubble { background: #2563eb; color: #fff; } .agent .bubble { background: #1f2937; }
  .turnmeta { font-size: 11px; color: #6b7280; margin: 2px 6px 6px; } .fallback { color: #fca5a5; margin-left: 6px; }
  .sugg { display: flex; flex-direction: column; gap: 8px; margin: 2px 6px 10px; max-width: 80%; }
  .prodcard { display: flex; gap: 10px; align-items: center; background: #0d131f; border: 1px solid #1f2937; border-radius: 10px; padding: 8px 10px; flex-wrap: wrap; }
  .prodcard .nm { font-weight: 600; font-size: 13px; } .prodcard .pr { color: #6ee7b7; font-size: 12px; }
  .prodcard select { font-size: 12px; padding: 4px 6px; }
  .chip { background: #1f2937; color: #cbd5e1; border: 1px solid #374151; border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  footer { padding: 14px 18px; background: #111827; border-top: 1px solid #1f2937; }
  .inputrow { display: flex; gap: 10px; max-width: 880px; margin: 0 auto; }
  input, textarea, select { background: #0b0f17; color: #e6e9ef; border: 1px solid #374151; border-radius: 9px; font-size: 14px; padding: 9px 11px; font-family: inherit; }
  input#msg { flex: 1; }
  button { padding: 10px 15px; border-radius: 9px; border: 0; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; font-size: 13px; }
  button:disabled { opacity: .5; cursor: default; } button.sec { background: #374151; } button.danger { background: #7f1d1d; } button.sm { padding: 5px 9px; font-size: 12px; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 18px; }
  .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .card h3 { margin: 0 0 4px; font-size: 14px; } .card p.sub { margin: 0 0 12px; font-size: 12px; color: #6b7280; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .full { grid-column: 1 / -1; }
  label.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #9ca3af; }
  .kbrow { display: grid; gap: 6px; margin-bottom: 8px; padding: 8px; background: #0d131f; border-radius: 8px; }
  .cardfoot { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; } .status { font-size: 12px; color: #6ee7b7; }
  .sources { display: flex; flex-wrap: wrap; gap: 8px; }
  .srcchip { display: flex; align-items: center; gap: 8px; background: #0d131f; border: 1px solid #1f2937; border-radius: 999px; padding: 5px 6px 5px 12px; font-size: 12px; }
  .srcchip .x { cursor: pointer; color: #fca5a5; background: #1f2937; border-radius: 999px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; }
  .tones { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; } .tone { background: #1f2937; color: #cbd5e1; border: 1px solid #374151; border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer; } .tone.active { background: #2563eb; color: #fff; }
  table.ord { width: 100%; border-collapse: collapse; font-size: 12px; } table.ord th, table.ord td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #1f2937; vertical-align: top; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; } .pill.pending { background:#374151;color:#cbd5e1 } .pill.confirmed{background:#1e3a8a;color:#bfdbfe} .pill.processing{background:#3730a3;color:#c7d2fe} .pill.shipped{background:#065f46;color:#6ee7b7} .pill.delivered{background:#064e3b;color:#34d399} .pill.cancelled{background:#7f1d1d;color:#fca5a5} .pill.refunded{background:#78350f;color:#fcd34d}
  .prodrow { display:flex; gap:8px; align-items:center; background:#0d131f; border:1px solid #1f2937; border-radius:10px; padding:10px; margin-bottom:8px; flex-wrap:wrap; }
  .hint { max-width: 880px; margin: 8px auto 0; font-size: 11px; color: #6b7280; }
</style></head>
<body>
<div id="authOverlay" style="position:fixed;inset:0;background:#0b0f17;z-index:99999;display:flex;align-items:center;justify-content:center">
  <div style="background:#111827;border:1px solid #1f2937;border-radius:14px;padding:28px;width:340px;max-width:90vw">
    <h2 style="margin:0 0 4px;font-size:18px">🤖 Assisty — Operator Login</h2>
    <p class="sub" style="margin:0 0 16px">Sign in to manage your business.</p>
    <label class="fld">Email<input id="au_email" type="email" autocomplete="username" placeholder="you@business.com" /></label>
    <label class="fld" style="margin-top:10px">Password<input id="au_pass" type="password" autocomplete="current-password" placeholder="at least 6 characters" /></label>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="au_login" style="flex:1">Log in</button>
      <button id="au_signup" class="sec" style="flex:1">Sign up</button>
    </div>
    <div id="au_status" class="status" style="margin-top:10px;min-height:16px"></div>
  </div>
</div>
<header>
  <h1>🤖 Assisty — Operator Console</h1>
  <span id="health" class="badge">checking…</span>
  <span class="meta" id="model">model: —</span>
  <span class="meta" id="modelUsage"></span>
  <span class="spacer"></span>
  <span class="meta" id="who"></span>
  <a class="link" href="/widget-demo" target="_blank">🌐 widget demo ↗</a>
  <span class="meta" id="session"></span>
  <button class="sec sm" id="newsess">New chat</button>
  <button class="sec sm" id="logout">Logout</button>
</header>
<div class="tabs">
  <button class="tab active" data-tab="chat">💬 Chat</button>
  <button class="tab" data-tab="kb">📚 Knowledge</button>
  <button class="tab" data-tab="catalog">🛍️ Catalog</button>
  <button class="tab" data-tab="orders">🧾 Orders</button>
  <button class="tab" data-tab="settings">⚙️ Settings</button>
</div>

<div id="chatPanel" class="panel"><div id="log"></div></div>

<div id="kbPanel" class="panel hidden"><div class="wrap">
  <div class="card">
    <h3>🎭 Agent Persona / Master Prompt</h3>
    <p class="sub">Controls role &amp; tone. Pick a template or write your own, then Save.</p>
    <div class="tones" id="tones"></div>
    <textarea id="agentPrompt" rows="4" style="width:100%" placeholder="e.g. You're a friendly support rep for Acme…"></textarea>
    <div class="cardfoot"><button id="saveAgent">Save persona</button><span class="status" id="st_agent"></span></div>
  </div>
  <div class="card">
    <h3>🧠 Agent Memory — Custom Commands</h3>
    <p class="sub">Standing instructions the agent ALWAYS follows (e.g. "after payment, ask for the payment screenshot &amp; TID"). Saved per business; applied on web &amp; WhatsApp.</p>
    <div id="ruleRows"></div>
    <div class="cardfoot"><button class="sec sm" id="addRule">+ Add command</button><button id="saveRules">Save commands</button><span class="status" id="st_rules"></span></div>
  </div>
  <div class="card"><h3>📦 Data Sources</h3><p class="sub">Knowledge indexed for RAG.</p><div class="sources" id="sources"><span class="meta">loading…</span></div></div>
  <div class="card"><h3>🏢 Business Profile</h3>
    <div class="grid2">
      <label class="fld">Name<input id="p_name" placeholder="Acme Shoes" /></label>
      <label class="fld">Hours<input id="p_hours" placeholder="Mon-Sat 9-6, closed Sun" /></label>
      <label class="fld">Address<input id="p_address" /></label>
      <label class="fld">Contact<input id="p_contact" /></label>
      <label class="fld full">Description<textarea id="p_description" rows="2"></textarea></label>
    </div>
    <div class="cardfoot"><button id="saveProfile">Save profile</button><span class="status" id="st_profile"></span></div>
  </div>
  <div class="card"><h3>❓ FAQ</h3><div id="faqRows"></div><div class="cardfoot"><button class="sec sm" id="addFaq">+ Add</button><button id="saveFaq">Save FAQ</button><span class="status" id="st_faq"></span></div></div>
  <div class="card"><h3>📋 Policies</h3><div id="policyRows"></div><div class="cardfoot"><button class="sec sm" id="addPolicy">+ Add</button><button id="savePolicy">Save policies</button><span class="status" id="st_policy"></span></div></div>
  <div class="card"><h3>🌐 Import website</h3><div class="cardfoot" style="margin-top:0"><input id="w_url" placeholder="https://your-site.com/about" style="flex:1" /><button id="importWeb">Import</button><span class="status" id="st_web"></span></div></div>
  <div class="card"><h3>📝 Free text</h3><textarea id="t_text" rows="3" style="width:100%"></textarea><div class="cardfoot"><button id="saveText">Save</button><span class="status" id="st_text"></span></div></div>
</div></div>

<div id="catalogPanel" class="panel hidden"><div class="wrap">
  <div class="card"><h3>➕ Add product</h3>
    <div class="grid2">
      <label class="fld">Name<input id="c_name" placeholder="Nike Pegasus" /></label>
      <label class="fld">Category<input id="c_category" placeholder="shoes" /></label>
      <label class="fld">Price<input id="c_price" type="number" placeholder="12000" /></label>
      <label class="fld">Stock<input id="c_stock" type="number" placeholder="20" /></label>
      <label class="fld">Sizes (comma)<input id="c_sizes" placeholder="7,8,9,10" /></label>
      <label class="fld">Colours (comma)<input id="c_colours" placeholder="Black,White,Blue" /></label>
      <label class="fld full">Description<textarea id="c_description" rows="2"></textarea></label>
    </div>
    <div class="cardfoot"><button id="saveProduct">Add product</button><button class="sec" id="clearProduct">Clear</button><span class="status" id="st_product"></span></div>
  </div>
  <div class="card"><h3>📄 Import from Excel / CSV</h3>
    <p class="sub">Upload .xlsx or .csv. Recognised columns: name, price, sku/code, stock, category, description, sizes, colours. Imported into THIS business only (re-import updates by SKU).</p>
    <input type="file" id="importFile" accept=".xlsx,.xls,.csv" style="font-size:12px" />
    <div class="cardfoot"><button id="importBtn">Import file</button><span class="status" id="st_import"></span></div>
  </div>
  <div class="card"><h3>🛍️ Products</h3><div id="productList"><span class="meta">loading…</span></div></div>
</div></div>

<div id="ordersPanel" class="panel hidden"><div class="wrap">
  <div class="card"><h3>🧾 Orders <button class="sec sm" id="reloadOrders" style="float:right">Refresh</button></h3>
    <p class="sub">All order records. Update status, add tracking, or cancel (cancellation respects your Settings policy).</p>
    <div id="ordersList"><span class="meta">loading…</span></div>
  </div>
</div></div>

<div id="settingsPanel" class="panel hidden"><div class="wrap">
  <div class="card"><h3>🤖 AI Model</h3>
    <p class="sub">Pick the model this business's agent uses (Gemini / OpenAI / DeepSeek via OpenRouter). Applies to web &amp; WhatsApp.</p>
    <label class="fld" style="max-width:380px">Model<select id="s_model"></select></label>
    <div class="cardfoot"><button id="saveModel">Save model</button><span class="status" id="st_model"></span></div>
  </div>
  <div class="card"><h3>📊 Model Usage <button class="sec sm" id="reloadUsage" style="float:right">Refresh</button></h3>
    <p class="sub">Tokens &amp; messages used per model (this business).</p>
    <div id="usageList"><span class="meta">loading…</span></div>
  </div>
  <div class="card"><h3>⚙️ Order Settings</h3>
    <p class="sub">Control cancellation policy and order defaults.</p>
    <label class="fld">Statuses a customer/operator may cancel from:</label>
    <div id="cancelStatuses" class="sources" style="margin:8px 0"></div>
    <label class="fld" style="flex-direction:row;align-items:center;gap:8px;margin-top:6px"><input type="checkbox" id="s_autoconfirm" style="width:auto" /> Auto-confirm new orders (skip "pending")</label>
    <label class="fld" style="flex-direction:row;align-items:center;gap:8px;margin-top:6px"><input type="checkbox" id="s_customercancel" style="width:auto" /> Allow customers to cancel via chat</label>
    <label class="fld" style="margin-top:8px;max-width:160px">Currency<input id="s_currency" placeholder="PKR" /></label>
    <div class="cardfoot"><button id="saveSettings">Save settings</button><span class="status" id="st_settings"></span></div>
  </div>
</div></div>

<footer id="chatFooter">
  <div class="inputrow"><input id="msg" placeholder="Type a customer message…" autocomplete="off" /><button id="send">Send</button></div>
  <div class="hint">Answers from the Knowledge Base (RAG) + live order/catalog data (relational). Try "what do you sell?", "where is order 1001?", or ask for a product to get suggestions.</div>
</footer>

<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>
<script>
  /* ---- Auth (Supabase operator login) ---- */
  var ASSISTY_TOKEN = localStorage.getItem('assisty_token') || '';
  var SB = null;
  var _fetch = window.fetch.bind(window);
  window.fetch = function(url, opts){ opts = opts || {}; if (ASSISTY_TOKEN && typeof url === 'string' && url.charAt(0) === '/') { opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + ASSISTY_TOKEN }); } return _fetch(url, opts); };
  function showAuth(s){ var o=document.getElementById('authOverlay'); if(o) o.style.display = s ? 'flex' : 'none'; }
  function authStatus(m,bad){ var e=document.getElementById('au_status'); if(e){ e.textContent=m||''; e.style.color=bad?'#fca5a5':'#6ee7b7'; } }
  async function sbConfig(){ if(SB) return SB; SB = await (await _fetch('/auth/config')).json(); return SB; }
  async function sbAuth(path, body){ var c=await sbConfig(); var base=c.supabaseUrl; if(base.charAt(base.length-1)==='/') base=base.slice(0,-1); var r=await _fetch(base+'/auth/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',apikey:c.anonKey},body:JSON.stringify(body)}); var j=await r.json().catch(function(){return {};}); if(!r.ok) throw new Error(j.error_description||j.msg||j.error||('HTTP '+r.status)); return j; }
  function setToken(t){ ASSISTY_TOKEN=t; localStorage.setItem('assisty_token',t); }
  async function checkAuth(){ if(!ASSISTY_TOKEN){ showAuth(true); return false; } try{ var r=await _fetch('/auth/me',{headers:{Authorization:'Bearer '+ASSISTY_TOKEN}}); if(!r.ok) throw 0; var me=await r.json(); var w=document.getElementById('who'); if(w) w.textContent=me.email||'operator'; showAuth(false); return true; }catch(e){ ASSISTY_TOKEN=''; localStorage.removeItem('assisty_token'); showAuth(true); return false; } }
  (function(){
    var lg=document.getElementById('au_login'); if(lg) lg.addEventListener('click', async function(){ authStatus('signing in…'); try{ var j=await sbAuth('token?grant_type=password',{email:(document.getElementById('au_email').value||'').trim(),password:document.getElementById('au_pass').value}); if(!j.access_token) throw new Error('no token returned'); setToken(j.access_token); location.reload(); }catch(e){ authStatus(e.message||'login failed',true); } });
    var su=document.getElementById('au_signup'); if(su) su.addEventListener('click', async function(){ authStatus('creating account…'); try{ var j=await sbAuth('signup',{email:(document.getElementById('au_email').value||'').trim(),password:document.getElementById('au_pass').value}); if(j.access_token){ setToken(j.access_token); location.reload(); } else { authStatus('Account created. If email confirmation is ON in Supabase, confirm then log in.'); } }catch(e){ authStatus(e.message||'signup failed',true); } });
    var lo=document.getElementById('logout'); if(lo) lo.addEventListener('click', function(){ ASSISTY_TOKEN=''; localStorage.removeItem('assisty_token'); location.reload(); });
    checkAuth();
  })();

  var sessionId = localStorage.getItem('assisty_session') || ('web-' + Math.random().toString(36).slice(2, 10));
  localStorage.setItem('assisty_session', sessionId);
  function $(id){ return document.getElementById(id); }
  $('session').textContent = 'session: ' + sessionId;
  var log = $('log'), input = $('msg'), sendBtn = $('send');
  var ALL_STATUSES = ['pending','confirmed','processing','shipped','delivered','cancelled','refunded'];
  function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function val(id){ return ($(id).value || '').trim(); }
  function csv(id){ return val(id).split(',').map(function(s){return s.trim();}).filter(Boolean); }
  function setStatus(id,msg,bad){ var e=$(id); if(!e) return; e.textContent=msg; e.style.color=bad?'#fca5a5':'#6ee7b7'; if(msg) setTimeout(function(){ if(e.textContent===msg) e.textContent=''; },4000); }
  async function api(method, path, obj){ var p={method:method,headers:{}}; if(obj!==undefined){ p.headers['Content-Type']='application/json'; p.body=JSON.stringify(obj); } var r=await fetch(path,p); var j=await r.json().catch(function(){return {};}); if(!r.ok) throw new Error(j.message||('HTTP '+r.status)); return j; }

  /* Tabs */
  var PANELS = { chat:'chatPanel', kb:'kbPanel', catalog:'catalogPanel', orders:'ordersPanel', settings:'settingsPanel' };
  function showTab(which){
    Object.keys(PANELS).forEach(function(k){ $(PANELS[k]).className = 'panel' + (k===which?'':' hidden'); });
    $('chatFooter').style.display = which==='chat'?'block':'none';
    var tabs=document.querySelectorAll('.tab'); for(var i=0;i<tabs.length;i++){ tabs[i].className='tab'+(tabs[i].getAttribute('data-tab')===which?' active':''); }
    if(which==='kb'){ loadSources(); loadAgent(); loadRules(); }
    if(which==='catalog'){ loadCatalog(); }
    if(which==='orders'){ loadOrders(); }
    if(which==='settings'){ loadSettings(); loadUsage(); }
  }
  var tabBtns=document.querySelectorAll('.tab'); for(var i=0;i<tabBtns.length;i++){ tabBtns[i].addEventListener('click', function(){ showTab(this.getAttribute('data-tab')); }); }

  /* Chat */
  function addBubble(role,text,meta){ var row=document.createElement('div'); row.className='row '+role; var h='<div style="display:flex;flex-direction:column"><div class="bubble">'+escapeHtml(text)+'</div>'; if(meta) h+='<div class="turnmeta">'+meta+'</div>'; h+='</div>'; row.innerHTML=h; log.appendChild(row); log.scrollTop=log.scrollHeight; return row; }
  function renderSuggestions(sugg){
    if(!sugg) return;
    /* 1) product/service cards — one <select> per option axis (generic, not size/colour) */
    if(sugg.products && sugg.products.length){
      var box=document.createElement('div'); box.className='row agent'; var inner=document.createElement('div'); inner.className='sugg';
      sugg.products.forEach(function(p){
        var card=document.createElement('div'); card.className='prodcard';
        card.innerHTML='<span class="nm">'+escapeHtml(p.name)+'</span><span class="pr">'+escapeHtml(p.currency)+' '+p.price+'</span>';
        var selects={}, opts=p.options||{};
        Object.keys(opts).forEach(function(axis){
          var vals=opts[axis]||[]; if(!vals.length) return;
          var sel=document.createElement('select'); sel.title=axis;
          var ph=document.createElement('option'); ph.value=''; ph.textContent=axis; sel.appendChild(ph);
          vals.forEach(function(v){ var o=document.createElement('option'); o.value=v; o.textContent=v; sel.appendChild(o); });
          selects[axis]=sel; card.appendChild(sel);
        });
        var b=document.createElement('button'); b.className='sm'; b.textContent=p.inStock?'🛒 Order':'Out of stock'; b.disabled=!p.inStock;
        b.addEventListener('click', function(){ var chosen={}; Object.keys(selects).forEach(function(a){ if(selects[a].value) chosen[a]=selects[a].value; }); placeOrder(p, chosen, b); });
        card.appendChild(b); inner.appendChild(card);
      });
      box.appendChild(inner); log.appendChild(box);
    }
    /* 2) attribute prompts + quick replies -> tappable chips that send the next turn */
    var chips=[];
    (sugg.attributePrompts||[]).forEach(function(ap){ (ap.options||[]).forEach(function(opt){ chips.push({text:opt, send:ap.attribute+' '+opt}); }); });
    (sugg.quickReplies||[]).forEach(function(q){ if(q&&q.label) chips.push({text:q.label, send:q.label}); });
    if(chips.length){
      var crow=document.createElement('div'); crow.className='row agent'; var ci=document.createElement('div'); ci.className='sugg';
      var wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.flexWrap='wrap'; wrap.style.gap='6px';
      chips.forEach(function(c){ var chip=document.createElement('span'); chip.className='chip'; chip.textContent=c.text; chip.addEventListener('click', function(){ send(c.send); }); wrap.appendChild(chip); });
      ci.appendChild(wrap); crow.appendChild(ci); log.appendChild(crow);
    }
    log.scrollTop=log.scrollHeight;
  }
  async function placeOrder(p, options, btn){
    btn.disabled=true;
    try{ var item={name:p.name, price:p.price, qty:1, productId:p.productId}; if(options && Object.keys(options).length) item.options=options;
      var o=await api('POST','/orders',{items:[item], customerRef:sessionId, customerName:'Web Customer'});
      addBubble('agent','✅ Order #'+o.orderNumber+' placed — '+o.status+'. Total '+o.currency+' '+o.total+'. Say "where is order '+o.orderNumber+'?" to track it.','');
    }catch(e){ addBubble('agent','[could not place order] '+e.message,''); } finally{ btn.disabled=false; }
  }
  async function ping(){ var el=$('health'); try{ var j=await (await fetch('/health/db')).json(); if(j.db==='up'){el.textContent='API + DB up';el.className='badge ok';}else{el.textContent='DB down';el.className='badge bad';} }catch(e){el.textContent='API down';el.className='badge bad';} }
  async function loadHistory(){ log.innerHTML=''; try{ var rows=await (await fetch('/web/messages?sessionId='+encodeURIComponent(sessionId))).json(); rows.forEach(function(m){ addBubble(m.direction==='inbound'?'user':'agent', m.content||'', m.direction==='outbound'&&m.model?('model: '+m.model):''); }); }catch(e){} }
  async function send(preset){ var text=(preset!=null?String(preset):input.value).trim(); if(!text) return; if(preset==null) input.value=''; sendBtn.disabled=true; addBubble('user',text,''); var pending=addBubble('agent','…','thinking');
    try{ var j=await api('POST','/web/chat',{sessionId:sessionId,text:text}); pending.querySelector('.bubble').textContent=j.reply; pending.querySelector('.turnmeta').innerHTML=escapeHtml('model: '+j.model+' · ctx '+j.contextHits)+(j.usedFallback?'<span class="fallback">FALLBACK</span>':''); $('model').textContent='model: '+j.model; renderSuggestions(j.suggestions); updateModelUsage(j.model); }
    catch(e){ pending.querySelector('.bubble').textContent='[error] '+e.message; } finally{ sendBtn.disabled=false; input.focus(); } }
  async function updateModelUsage(model){ try{ var j=await (await fetch('/settings/usage')).json(); var rows=(j&&j.usage)||[]; var key=model?String(model).split('/').pop():''; var row=rows.filter(function(r){ return r.model===model || (key && r.model && r.model.indexOf(key)>=0); })[0]; var el=$('modelUsage'); if(!el) return; if(row){ el.textContent='· '+(row.tokens||0).toLocaleString()+' tok / '+(row.messages||0)+' msgs'; } else { var tot=rows.reduce(function(a,r){return a+(r.tokens||0);},0); el.textContent='· '+tot.toLocaleString()+' tok total'; } }catch(e){} }
  sendBtn.addEventListener('click', function(){ send(); }); input.addEventListener('keydown', function(e){ if(e.key==='Enter') send(); });
  $('newsess').addEventListener('click', function(){ sessionId='web-'+Math.random().toString(36).slice(2,10); localStorage.setItem('assisty_session',sessionId); $('session').textContent='session: '+sessionId; log.innerHTML=''; showTab('chat'); input.focus(); });

  /* Persona + tones */
  var TONES = [
    { name:'Professional', text:"You're a polished, professional support rep for this business. You're courteous, clear and efficient, you use proper grammar, and you sound calm and competent. Keep replies concise and skip slang and emojis." },
    { name:'Friendly', text:"You're a warm, friendly support rep who makes people feel looked after. You're upbeat and personable, you use the customer's name when you know it, and you'll drop the occasional light emoji. You sound like a helpful friend who happens to work here." },
    { name:'Playful', text:"You're a fun, upbeat support rep with a bit of personality. You keep things light and a little witty, use casual language and the odd emoji, and make chatting enjoyable — while still nailing the answer." },
    { name:'Concise', text:"You're a fast, no-nonsense support rep. You answer in as few words as possible — often a single line — skip the pleasantries, and get straight to the point. Crisp and clear." },
    { name:'Empathetic', text:"You're a calm, caring support rep. You acknowledge how the customer feels first, reassure them, and stay patient and gentle — especially if they're frustrated — before you solve the problem." }
  ];
  function renderTones(){ var box=$('tones'); box.innerHTML=''; TONES.forEach(function(t){ var b=document.createElement('span'); b.className='tone'; b.textContent=t.name; b.addEventListener('click', function(){ $('agentPrompt').value=t.text; markTone(); }); box.appendChild(b); }); }
  function markTone(){ var cur=val('agentPrompt'); var bs=$('tones').querySelectorAll('.tone'); for(var i=0;i<bs.length;i++) bs[i].className='tone'+(TONES[i].text===cur?' active':''); }
  async function loadAgent(){ try{ var j=await (await fetch('/kb/agent')).json(); $('agentPrompt').value=j.instructions||''; markTone(); }catch(e){} }
  $('agentPrompt').addEventListener('input', markTone);
  $('saveAgent').addEventListener('click', async function(){ try{ await api('POST','/kb/agent',{instructions:val('agentPrompt')}); setStatus('st_agent','Persona saved'); }catch(e){ setStatus('st_agent',e.message,true); } });

  /* Agent Memory — custom commands (operator-configured, applied on every channel) */
  function ruleFields(){ return [{k:'label',ph:'When (optional) e.g. after payment'},{k:'instruction',ph:'Do this e.g. ask for payment screenshot + TID',area:true}]; }
  async function loadRules(){ var box=$('ruleRows'); try{ var j=await (await fetch('/kb/rules')).json(); var rules=(j&&j.rules)||[]; box.innerHTML=''; if(!rules.length){ addRow('ruleRows',ruleFields()); } else { rules.forEach(function(r){ addRow('ruleRows',ruleFields()); var rows=box.querySelectorAll('.kbrow'); var last=rows[rows.length-1]; last.querySelector('[data-k="label"]').value=r.label||''; last.querySelector('[data-k="instruction"]').value=r.instruction||''; }); } }catch(e){ if(!box.querySelector('.kbrow')) addRow('ruleRows',ruleFields()); } }
  $('addRule').addEventListener('click', function(){ addRow('ruleRows',ruleFields()); });
  $('saveRules').addEventListener('click', async function(){ try{ var j=await api('POST','/kb/rules',{rules:collectRows('ruleRows')}); setStatus('st_rules','Saved · '+(j.count||0)+' command(s)'); }catch(e){ setStatus('st_rules',e.message,true); } });

  /* KB sources + collectors */
  async function loadSources(){ var box=$('sources'); box.innerHTML='<span class="meta">loading…</span>'; try{ var rows=await (await fetch('/kb/sources')).json(); if(!rows.length){ box.innerHTML='<span class="meta">No sources yet.</span>'; return; } box.innerHTML=''; rows.forEach(function(s){ var c=document.createElement('span'); c.className='srcchip'; c.innerHTML='<b>'+escapeHtml(s.type)+'</b> · '+s.chunks+' <span class="x" data-t="'+escapeHtml(s.type)+'">×</span>'; box.appendChild(c); }); box.querySelectorAll('.x').forEach(function(x){ x.addEventListener('click', function(){ fetch('/kb/'+encodeURIComponent(this.getAttribute('data-t')),{method:'DELETE'}).then(loadSources); }); }); }catch(e){ box.innerHTML='<span class="meta">failed</span>'; } }
  function addRow(cid,fields){ var w=document.createElement('div'); w.className='kbrow'; w.style.gridTemplateColumns=fields.map(function(){return '1fr';}).join(' '); fields.forEach(function(f){ var el=f.area?document.createElement('textarea'):document.createElement('input'); if(f.area) el.rows=2; el.placeholder=f.ph; el.dataset.k=f.k; w.appendChild(el); }); $(cid).appendChild(w); }
  function collectRows(cid){ var rows=document.querySelectorAll('#'+cid+' .kbrow'); var out=[]; rows.forEach(function(r){ var ins=r.querySelectorAll('input,textarea'); var o={}; var any=false; ins.forEach(function(x){ o[x.dataset.k]=x.value.trim(); if(x.value.trim()) any=true; }); if(any) out.push(o); }); return out; }
  $('addFaq').addEventListener('click', function(){ addRow('faqRows',[{k:'q',ph:'Question'},{k:'a',ph:'Answer',area:true}]); });
  $('addPolicy').addEventListener('click', function(){ addRow('policyRows',[{k:'title',ph:'Title'},{k:'body',ph:'Details',area:true}]); });
  $('saveProfile').addEventListener('click', async function(){ try{ var j=await api('POST','/kb/profile',{name:val('p_name'),hours:val('p_hours'),address:val('p_address'),contact:val('p_contact'),description:val('p_description')}); setStatus('st_profile','Saved · '+j.chunks+' chunks'); loadSources(); }catch(e){ setStatus('st_profile',e.message,true); } });
  $('saveFaq').addEventListener('click', async function(){ try{ var j=await api('POST','/kb/faq',{faqs:collectRows('faqRows')}); setStatus('st_faq','Saved · '+j.chunks+' chunks'); loadSources(); }catch(e){ setStatus('st_faq',e.message,true); } });
  $('savePolicy').addEventListener('click', async function(){ try{ var j=await api('POST','/kb/policies',{policies:collectRows('policyRows')}); setStatus('st_policy','Saved · '+j.chunks+' chunks'); loadSources(); }catch(e){ setStatus('st_policy',e.message,true); } });
  $('importWeb').addEventListener('click', async function(){ setStatus('st_web','importing…'); try{ var j=await api('POST','/kb/website',{url:val('w_url')}); setStatus('st_web','Imported · '+j.chunks+' chunks'); loadSources(); }catch(e){ setStatus('st_web',e.message,true); } });
  $('saveText').addEventListener('click', async function(){ try{ var j=await api('POST','/kb/text',{text:val('t_text')}); setStatus('st_text','Saved · '+j.chunks+' chunks'); loadSources(); }catch(e){ setStatus('st_text',e.message,true); } });

  /* Catalog */
  async function loadCatalog(){ var box=$('productList'); box.innerHTML='<span class="meta">loading…</span>'; try{ var rows=await (await fetch('/catalog/products')).json(); if(!rows.length){ box.innerHTML='<span class="meta">No products yet. Add one above.</span>'; return; } box.innerHTML=''; rows.forEach(function(p){ var d=document.createElement('div'); d.className='prodrow'; d.innerHTML='<div style="flex:1"><b>'+escapeHtml(p.name)+'</b> <span class="meta">'+escapeHtml(p.category||'')+'</span><br><span class="pr" style="color:#6ee7b7">'+escapeHtml(p.currency)+' '+p.price+'</span> · stock '+p.stock+(p.options&&p.options.sizes&&p.options.sizes.length?(' · sizes '+p.options.sizes.join(',')):'')+(p.options&&p.options.colours&&p.options.colours.length?(' · '+p.options.colours.join(',')):'')+'</div>'; var del=document.createElement('button'); del.className='danger sm'; del.textContent='Delete'; del.addEventListener('click', function(){ fetch('/catalog/products/'+p.id,{method:'DELETE'}).then(loadCatalog); }); d.appendChild(del); box.appendChild(d); }); }catch(e){ box.innerHTML='<span class="meta">failed</span>'; } }
  $('clearProduct').addEventListener('click', function(){ ['c_name','c_category','c_price','c_stock','c_sizes','c_colours','c_description'].forEach(function(id){ $(id).value=''; }); });
  $('saveProduct').addEventListener('click', async function(){ if(!val('c_name')){ setStatus('st_product','name required',true); return; } try{ await api('POST','/catalog/products',{name:val('c_name'),category:val('c_category'),description:val('c_description'),price:Number(val('c_price')||0),stock:Number(val('c_stock')||0),sizes:csv('c_sizes'),colours:csv('c_colours')}); setStatus('st_product','Product added'); $('clearProduct').click(); loadCatalog(); }catch(e){ setStatus('st_product',e.message,true); } });
  /* Excel/CSV import (parsed in-browser, sent as rows) */
  function mapImportRow(r){ var low={}; Object.keys(r).forEach(function(k){ low[String(k).trim().toLowerCase()]=r[k]; }); function pick(){ for(var i=0;i<arguments.length;i++){ var v=low[arguments[i]]; if(v!==undefined&&v!=='') return v; } return undefined; } function tocsv(v){ return v?String(v).split(/[,;|]/).map(function(s){return s.trim();}).filter(Boolean):[]; } return { name:(pick('name','product','title','item')||'').toString().trim(), sku:(pick('sku','code','product code','product_code','id')||'').toString().trim(), price:Number(pick('price','rate','amount','mrp')||0)||0, stock:Number(pick('stock','qty','quantity','inventory')||0)||0, category:(pick('category','type','cat')||'').toString().trim(), description:(pick('description','desc','details')||'').toString().trim(), sizes:tocsv(pick('sizes','size')), colours:tocsv(pick('colours','colors','colour','color')) }; }
  $('importBtn').addEventListener('click', async function(){ var f=$('importFile').files[0]; if(!f){ setStatus('st_import','choose a file first',true); return; } if(typeof XLSX==='undefined'){ setStatus('st_import','spreadsheet library still loading — try again',true); return; } setStatus('st_import','parsing…'); try{ var buf=await f.arrayBuffer(); var wb=XLSX.read(buf,{type:'array'}); var ws=wb.Sheets[wb.SheetNames[0]]; var raw=XLSX.utils.sheet_to_json(ws,{defval:''}); var products=raw.map(mapImportRow).filter(function(p){return p.name;}); if(!products.length){ setStatus('st_import','no rows with a product name found',true); return; } var j=await api('POST','/catalog/import',{products:products}); setStatus('st_import','Imported '+(j.imported||0)+' product(s)'); loadCatalog(); }catch(e){ setStatus('st_import',e.message||'import failed',true); } });

  /* Orders */
  function pill(s){ return '<span class="pill '+escapeHtml(s)+'">'+escapeHtml(s)+'</span>'; }
  async function loadOrders(){ var box=$('ordersList'); box.innerHTML='<span class="meta">loading…</span>'; try{ var rows=await (await fetch('/orders')).json(); if(!rows.length){ box.innerHTML='<span class="meta">No orders yet. Place one from Chat (ask for a product → Order).</span>'; return; }
    var html='<table class="ord"><tr><th>#</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Payment</th><th>Tracking</th><th>Actions</th></tr>';
    rows.forEach(function(o){ var items=(o.items||[]).map(function(i){return i.qty+'x '+i.name+(i.size?(' ('+i.size+')'):'')+(i.colour?(' '+i.colour):'');}).join(', ');
      html+='<tr><td>'+escapeHtml(o.orderNumber)+'</td><td>'+escapeHtml(o.customerName||o.customerRef||'-')+'</td><td>'+escapeHtml(items)+'</td><td>'+escapeHtml(o.currency)+' '+o.total+'</td><td>'+pill(o.status)+'</td><td>'+escapeHtml(o.paymentStatus)+'</td><td>'+escapeHtml(o.trackingNumber||'-')+'</td>'
        +'<td><select data-act="status" data-id="'+o.id+'">'+ALL_STATUSES.map(function(s){return '<option '+(s===o.status?'selected':'')+'>'+s+'</option>';}).join('')+'</select> '
        +'<input data-trk="'+o.id+'" placeholder="tracking#" style="width:90px"/> <button class="sec sm" data-ship="'+o.id+'">Ship</button> <button class="danger sm" data-cancel="'+o.id+'">Cancel</button></td></tr>'; });
    html+='</table>'; box.innerHTML=html;
    box.querySelectorAll('[data-act="status"]').forEach(function(sel){ sel.addEventListener('change', async function(){ try{ await api('PATCH','/orders/'+this.getAttribute('data-id')+'/status',{status:this.value}); loadOrders(); }catch(e){ alert(e.message); loadOrders(); } }); });
    box.querySelectorAll('[data-ship]').forEach(function(b){ b.addEventListener('click', async function(){ var id=this.getAttribute('data-ship'); var trk=box.querySelector('[data-trk="'+id+'"]').value.trim(); try{ await api('PATCH','/orders/'+id+'/ship',{trackingNumber:trk,carrier:'TCS'}); loadOrders(); }catch(e){ alert(e.message); } }); });
    box.querySelectorAll('[data-cancel]').forEach(function(b){ b.addEventListener('click', async function(){ try{ await api('PATCH','/orders/'+this.getAttribute('data-cancel')+'/cancel'); loadOrders(); }catch(e){ alert(e.message); } }); });
  }catch(e){ box.innerHTML='<span class="meta">failed</span>'; } }
  $('reloadOrders').addEventListener('click', loadOrders);

  /* Settings */
  async function loadSettings(){ try{ var s=await (await fetch('/settings')).json(); var box=$('cancelStatuses'); box.innerHTML=''; ALL_STATUSES.forEach(function(st){ var lab=document.createElement('label'); lab.className='chip'; var on=(s.cancellableStatuses||[]).indexOf(st)>=0; lab.style.background=on?'#1e3a8a':'#1f2937'; lab.innerHTML='<input type="checkbox" data-st="'+st+'" '+(on?'checked':'')+' style="width:auto;margin-right:6px"/>'+st; box.appendChild(lab); }); $('s_autoconfirm').checked=!!s.autoConfirmOrders; $('s_customercancel').checked=!!s.allowCustomerCancel; $('s_currency').value=s.currency||'PKR'; await loadModels(); $('s_model').value=s.model||''; }catch(e){} }
  async function loadModels(){ var sel=$('s_model'); if(sel.dataset.loaded) return; try{ var j=await (await fetch('/settings/models')).json(); var models=(j&&j.models)||[]; sel.innerHTML=''; var d=document.createElement('option'); d.value=''; d.textContent='Default (system)'; sel.appendChild(d); var groups={}; models.forEach(function(m){ if(!groups[m.provider]){ var og=document.createElement('optgroup'); og.label=m.provider; sel.appendChild(og); groups[m.provider]=og; } var o=document.createElement('option'); o.value=m.id; o.textContent=m.label; groups[m.provider].appendChild(o); }); sel.dataset.loaded='1'; }catch(e){} }
  $('saveSettings').addEventListener('click', async function(){ var cancellable=[]; $('cancelStatuses').querySelectorAll('input[data-st]').forEach(function(cb){ if(cb.checked) cancellable.push(cb.getAttribute('data-st')); }); try{ await api('PUT','/settings',{cancellableStatuses:cancellable,autoConfirmOrders:$('s_autoconfirm').checked,allowCustomerCancel:$('s_customercancel').checked,currency:val('s_currency')||'PKR'}); setStatus('st_settings','Settings saved'); }catch(e){ setStatus('st_settings',e.message,true); } });
  $('saveModel').addEventListener('click', async function(){ try{ await api('PUT','/settings',{model:$('s_model').value}); var lbl=$('s_model').value||'default'; setStatus('st_model','Model saved · '+lbl); $('model').textContent='model: '+lbl; loadUsage(); }catch(e){ setStatus('st_model',e.message,true); } });

  /* Model usage meter */
  async function loadUsage(){ var box=$('usageList'); box.innerHTML='<span class="meta">loading…</span>'; try{ var j=await (await fetch('/settings/usage')).json(); var rows=(j&&j.usage)||[]; if(!rows.length){ box.innerHTML='<span class="meta">No usage yet — send a few chats.</span>'; return; } var max=Math.max.apply(null, rows.map(function(r){return r.tokens||0;}).concat([1])); box.innerHTML=''; rows.forEach(function(r){ var pct=Math.max(2, Math.round(((r.tokens||0)/max)*100)); var d=document.createElement('div'); d.style.margin='10px 0'; d.innerHTML='<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span><b>'+escapeHtml(r.model)+'</b></span><span class="meta">'+(r.tokens||0).toLocaleString()+' tokens · '+(r.messages||0)+' msgs</span></div><div style="height:9px;background:#1f2937;border-radius:6px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:linear-gradient(90deg,#2563eb,#6ee7b7)"></div></div>'; box.appendChild(d); }); }catch(e){ box.innerHTML='<span class="meta">failed to load usage</span>'; } }
  $('reloadUsage').addEventListener('click', loadUsage);

  renderTones();
  addRow('faqRows',[{k:'q',ph:'Question'},{k:'a',ph:'Answer',area:true}]);
  addRow('policyRows',[{k:'title',ph:'Title'},{k:'body',ph:'Details',area:true}]);
  ping(); loadHistory(); setInterval(ping,15000); input.focus();
</script>
</body></html>`;
