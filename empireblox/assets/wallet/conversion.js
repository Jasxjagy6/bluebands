/* Quotes, balances and receipts come from the treasury; browser state is UI only. */
export function mountConversion(host,{api,esc,logo,assets,balance,fresh,refresh,userId,live,onWithdraw}){
  const $=s=>host.querySelector(s),coin={id:'COINS',symbol:'COINS',decimals:18};
  const human=(units,dec=18)=>{
    const n=BigInt(units),s=n.toString().padStart(dec+1,'0'),fraction=dec?s.slice(-dec).replace(/0+$/,''):'';
    return (dec?s.slice(0,-dec):s)+(fraction?'.'+fraction:'');
  };
  const amount=(id,units)=>human(units, id==='COINS'?18:assets.find(a=>a.id===id)?.decimals??18);
  const storageKey='banditblox.pending-conversion.'+userId;
  let direction='crypto_to_coins',quote=null,key=null,busy=false,version=0,historyPage=0,historyVersion=0,pending=null;
  let requestController=new AbortController();
  try{const saved=JSON.parse(sessionStorage.getItem(storageKey));if(saved?.request&&saved?.quote)pending=saved;}catch{}
  host.innerHTML=`<section class="conversion-rate" aria-label="Coin conversion rate"><span class="conversion-emblem">${logo('COINS')}</span><div><span class="eyebrow">One rate. Both directions.</span><h2>6,000 <span>coins</span> <em>=</em> 10 <span>USDT</span></h2><p>Your crypto wallet and playing balance, connected.</p></div><span class="conversion-rate-tag">0% conversion fee</span></section>
    <div class="conversion-layout"><section class="conversion-card" aria-labelledby="convertHeading"><div class="conversion-heading"><span class="eyebrow">Make a conversion</span><h2 id="convertHeading">Crypto ↔ coins</h2></div>
    <form id="conversionForm"><div class="conversion-direction" role="group" aria-label="Conversion direction"><button type="button" data-direction="crypto_to_coins" aria-pressed="true">Crypto to coins</button><button type="button" data-direction="coins_to_crypto" aria-pressed="false">Coins to crypto</button></div>
    <label for="conversionAsset">Crypto currency</label><select id="conversionAsset" data-searchable>${assets.map(a=>`<option value="${esc(a.id)}">${esc(a.symbol)}</option>`).join('')}</select>
    <div class="conversion-input-label"><label for="conversionAmount">You pay</label><button type="button" class="wallet-link" id="conversionMax">Use max</button></div>
    <div class="conversion-input"><input id="conversionAmount" inputmode="decimal" autocomplete="off" placeholder="0.00" maxlength="69" required aria-describedby="conversionAvailable"><span id="conversionSource"></span></div><p class="conversion-available" id="conversionAvailable"></p>
    <div class="conversion-receive"><span>You receive</span><strong id="conversionOutput">Review a quote below</strong></div>
    <section class="conversion-review" id="conversionReview" hidden aria-labelledby="conversionReviewTitle"><h3 id="conversionReviewTitle">Review conversion</h3><dl><div><dt>You pay</dt><dd id="conversionPay"></dd></div><div><dt>You receive</dt><dd id="conversionGet"></dd></div><div><dt>Conversion fee</dt><dd>0</dd></div><div><dt>Quote valid for</dt><dd id="conversionExpiry" role="timer" aria-live="off"></dd></div></dl><p>The receive amount is rounded down to the currency’s smallest unit.</p></section>
    <button type="submit" id="conversionSubmit" class="wallet-primary">Review conversion</button><button type="button" id="conversionEdit" class="wallet-link" hidden>Edit amount</button><p id="conversionStatus" role="status" aria-live="polite"></p>
    </form><div id="conversionReceipt" hidden></div></section>
    <aside class="conversion-guide"><span class="eyebrow">From wallet to play</span><h2>Your coins.<br>Your next move.</h2><ol><li><span>01</span><div><strong>Deposit crypto</strong><p>Use the same permanent address and network in your wallet.</p></div></li><li><span>02</span><div><strong>Convert to coins</strong><p>600 coins = 1 USDT. Other crypto uses a live server quote, locked for up to 30 seconds.</p></div></li><li><span>03</span><div><strong>Play, then convert back</strong><p>All games use coins. Convert coins to crypto before requesting a withdrawal.</p></div></li></ol><p class="conversion-guide-note">Your coin balance is saved to your account on the server. You can return on another device.</p></aside></div>
    <section class="conversion-history" aria-labelledby="conversionHistoryTitle"><div class="wallet-heading"><div><span class="eyebrow">Your receipts</span><h2 id="conversionHistoryTitle">Conversion history</h2></div><button type="button" class="wallet-link" id="refreshConversions">Refresh</button></div><div id="conversionRecords" aria-live="polite"></div><div class="activity-pager"><button type="button" id="conversionPrevious" disabled>Previous</button><small id="conversionPage">Page 1</small><button type="button" id="conversionNext" disabled>Next</button></div></section>`;
  const form=$('#conversionForm'),input=$('#conversionAmount'),select=$('#conversionAsset'),submit=$('#conversionSubmit'),status=$('#conversionStatus');
  form.noValidate=true;
  const selected=()=>assets.find(a=>a.id===select.value);
  const source=()=>direction==='crypto_to_coins'?selected():coin;
  const fields=()=>[input,select,$('#conversionMax'),...host.querySelectorAll('[data-direction]')];
  const savePending=value=>{pending=value;try{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}catch{}};
  function available(){
    if(!live())return;
    const a=source();$('#conversionSource').innerHTML=a?logo(a.symbol)+esc(a.symbol):'—';
    $('#conversionAvailable').textContent=a?(fresh()?'Available: '+amount(a.id,balance(a.id)||'0')+' '+a.symbol:'Balance unavailable. Refresh your account before converting.'):'No crypto currencies are available.';
    if(!quote&&!busy&&!pending)submit.disabled=!a||!fresh();
  }
  function clearQuote(){
    if(busy||pending)return;
    ++version;requestController.abort();requestController=new AbortController();quote=null;key=null;
    $('#conversionReview').hidden=$('#conversionEdit').hidden=true;$('#conversionOutput').textContent='Review a quote below';
    submit.textContent='Review conversion';status.textContent='';input.readOnly=false;available();
  }
  function setDirection(next){
    if(busy||pending)return;direction=next;input.value='';clearQuote();
    host.querySelectorAll('[data-direction]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.direction===direction)));available();
  }
  host.querySelectorAll('[data-direction]').forEach(b=>b.onclick=()=>setDirection(b.dataset.direction));
  input.addEventListener('input',clearQuote);select.addEventListener('change',clearQuote);
  $('#conversionEdit').onclick=()=>{clearQuote();input.focus();};
  $('#conversionMax').onclick=()=>{if(busy||pending||!fresh())return;clearQuote();const a=source();if(a)input.value=amount(a.id,balance(a.id)||'0');input.focus();};
  const pay=q=>q.direction==='crypto_to_coins'?q.crypto_amount+' '+q.symbol:q.coin_amount+' COINS';
  const get=q=>q.direction==='crypto_to_coins'?q.coin_amount+' COINS':q.crypto_amount+' '+q.symbol;
  function tick(){
    if(!live()){clearInterval(timer);requestController.abort();window.removeEventListener('eb-currency',available);return;}
    if(!quote||busy||pending)return;
    const seconds=Math.max(0,Math.ceil((Date.parse(quote.expires_at)-Date.now())/1000));$('#conversionExpiry').textContent=seconds+'s';
    if(!seconds){quote=null;key=null;input.readOnly=false;$('#conversionEdit').hidden=true;submit.textContent='Refresh quote';submit.disabled=!fresh();status.textContent='Quote expired. Review a fresh quote to continue.';}
  }
  async function execute(){
    const approved=pending||{request:key,quote:quote.id};
    savePending(approved);submit.textContent='Converting…';
    try{
      const receipt=await api('/me/conversions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(approved)});
      if(!live())return;
      savePending(null);quote=null;key=null;input.value='';input.readOnly=false;
      $('#conversionReview').hidden=$('#conversionEdit').hidden=true;$('#conversionOutput').textContent='Conversion complete';
      const q=receipt.quote;
      $('#conversionReceipt').innerHTML=`<span class="conversion-success-mark" aria-hidden="true">✓</span><span class="eyebrow">Conversion complete</span><h3>${esc(get(q))}</h3><p>${esc(pay(q))} converted successfully.</p><small>Receipt ${esc(receipt.conversion_id)}</small>${q.direction==='coins_to_crypto'?'<button type="button" class="secondary-action" id="conversionWithdraw">Request crypto withdrawal →</button>':''}`;
      $('#conversionReceipt').hidden=false;
      $('#conversionWithdraw')?.addEventListener('click',()=>onWithdraw(q.asset_id));
      status.textContent='Conversion complete. Your balances have been updated.';playFeedback();
      await refresh();if(live()){historyPage=0;void history();}
    }catch(err){
      if(!live())return;
      if(err.status>=400&&err.status<500&&![401,403].includes(err.status)){
        savePending(null);quote=null;key=null;input.readOnly=false;$('#conversionReview').hidden=$('#conversionEdit').hidden=true;
        status.textContent=err.message;
      }else status.textContent='The result could not be confirmed. Check this conversion again using the same request.';
    }
  }
  function playFeedback(){window.dispatchEvent(new CustomEvent('eb-converted'));}
  form.onsubmit=async e=>{
    e.preventDefault();if(busy||!live())return;
    if(!pending&&!quote&&!/^\d{1,50}(?:\.\d{1,18})?$/.test(input.value.trim())){status.textContent='Enter a positive decimal amount (up to 18 places).';return;}
    busy=true;fields().forEach(f=>f.disabled=true);submit.disabled=true;$('#conversionEdit').disabled=true;
    try{
      if(pending||quote){await execute();return;}
      const seq=++version;status.textContent='Fetching your quote…';submit.textContent='Preparing quote…';
      const q=await api('/me/conversions/quote',{method:'POST',signal:requestController.signal,headers:{'content-type':'application/json'},body:JSON.stringify({asset:select.value,direction,amount:input.value.trim()})});
      if(!live()||seq!==version)return;
      quote=q;key=crypto.randomUUID();input.readOnly=true;status.textContent='Review the exact amounts, then confirm.';
      $('#conversionPay').textContent=pay(q);$('#conversionGet').textContent=get(q);$('#conversionOutput').textContent=get(q);
      $('#conversionReview').hidden=$('#conversionEdit').hidden=false;submit.textContent='Confirm conversion';
    }catch(err){if(live()&&err.name!=='AbortError')status.textContent=err.message;}
    finally{
      busy=false;if(live()){fields().forEach(f=>f.disabled=!!pending);$('#conversionEdit').disabled=false;submit.disabled=false;
        submit.textContent=pending?'Check pending conversion':quote?'Confirm conversion':'Review conversion';available();tick();}
    }
  };
  async function history(){
    const seq=++historyVersion,records=$('#conversionRecords');records.setAttribute('aria-busy','true');$('#refreshConversions').disabled=true;
    try{
      const d=await api('/me/conversions?page='+historyPage);if(!live()||seq!==historyVersion)return;
      records.innerHTML=d.rows.map(r=>`<details class="transaction-details"><summary class="activity-entry">${logo(r.quote.direction==='crypto_to_coins'?'COINS':r.quote.symbol)}<span><strong>${r.quote.direction==='crypto_to_coins'?'Crypto to coins':'Coins to crypto'}</strong><small>${esc(new Date(r.converted_at).toLocaleString())}</small></span><b>+${esc(get(r.quote))}</b></summary><dl class="bet-facts"><div><dt>Paid</dt><dd>${esc(pay(r.quote))}</dd></div><div><dt>Received</dt><dd>${esc(get(r.quote))}</dd></div><div><dt>Conversion ID</dt><dd>${esc(r.conversion_id)}</dd></div><div><dt>Journal</dt><dd>${esc(r.journal_id)}</dd></div></dl></details>`).join('')||'<p class="wallet-empty">Your completed conversions will appear here.</p>';
      $('#conversionPrevious').disabled=!historyPage;$('#conversionNext').disabled=!d.more;$('#conversionPage').textContent='Page '+(historyPage+1);
    }catch{if(live())records.innerHTML='<p class="wallet-muted">Conversion history could not load. Use Refresh to try again.</p>';}
    finally{if(live()&&seq===historyVersion){records.removeAttribute('aria-busy');$('#refreshConversions').disabled=false;}}
  }
  $('#refreshConversions').onclick=()=>void history();$('#conversionPrevious').onclick=()=>{historyPage--;void history();};$('#conversionNext').onclick=()=>{historyPage++;void history();};
  const timer=setInterval(tick,1000);window.addEventListener('eb-currency',available);available();
  if(pending){fields().forEach(f=>f.disabled=true);submit.textContent='Check pending conversion';submit.disabled=false;status.textContent='A previous conversion is awaiting confirmation. Check its result before making another conversion.';}
  void history();
}
