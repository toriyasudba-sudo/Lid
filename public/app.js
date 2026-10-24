const $=id=>document.getElementById(id);
const CONFIG={consultationUrl:'https://t.me/toriya_nova'},CONSENT_V='2026-10-22';
const tg=window.Telegram&&window.Telegram.WebApp||null;
const web=!(tg&&tg.initData);
const isLocal=location.protocol==='file:'||['localhost','127.0.0.1'].includes(location.hostname);
const screens=['boot','s0','s0video','consent','formats','demo1','demo2','demo3','control','mech','v5','price','order'];
const NOSTACK=['boot'];
const ENTRY_LABELS={
  voice:'0 ₽ · Голосовой краш-тест канала',
  proto:'2 500 ₽ · Прототип + разбор (депозит)',
  dev:'Запуск Mini App под ключ'
};
const state={
  consent:false,
  formats:new Set(),
  entry:'voice',
  tier:'35 000 ₽ · Под ключ с разбором (2–3 дня)',
  otherNets:false,
  sending:false
};
try{state.consent=localStorage.getItem('tn_consent')===CONSENT_V}catch{}
const qs=new URLSearchParams(location.search);
const src=qs.get('src')||(tg&&tg.initDataUnsafe&&tg.initDataUnsafe.start_param)||'';
function webId(){let id='';try{id=localStorage.getItem('tn_webid')||''}catch{}if(!/^[a-f0-9-]{36}$/.test(id)){id=crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16)});try{localStorage.setItem('tn_webid',id)}catch{}}return id}
async function apiPost(url,payload){const initData=tg&&tg.initData||'';const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Init-Data':initData,'X-Web-Id':initData?'':webId()},body:JSON.stringify({...payload,initData})});return r.json()}
let consentP=null;
function track(event,meta={}){if(isLocal||(!state.consent&&event!=='consent'))return;const send=()=>apiPost('/api/event',{event,meta}).catch(()=>{});consentP&&event!=='consent'?consentP.then(send):send()}
function haptic(k,v){try{tg.HapticFeedback[k](v)}catch{}}
function openTg(u){if(!web&&tg.openTelegramLink&&u.startsWith('https://t.me/'))tg.openTelegramLink(u);else location.href=u}
const ROUTE=[['Проблема',['s0']],['Решение',['s0video','consent']],['Продукт',['formats','demo1','demo2','demo3']],['Выгоды',['control','mech']],['Условия и заказ',['v5','price','order']]];let routeK=-1;
function setRoute(id){const bar=$('routebar'),cap=$('routecap');const k=ROUTE.findIndex(r=>r[1].includes(id));if(k<0){bar.classList.remove('on');return}
if(!bar.dataset.built){bar.innerHTML=ROUTE.map((r,i)=>(i?'<b class="l"></b>':'')+'<i class="n"></i>').join('');bar.dataset.built='1'}
bar.classList.add('on');bar.querySelectorAll('.n').forEach((n,i)=>{n.className='n'+(i<k?' done':i===k?' cur':'')});bar.querySelectorAll('.l').forEach((l,i)=>l.classList.toggle('done',i<k));
cap.textContent='Ступень '+(k+1)+' из '+ROUTE.length+' · '+ROUTE[k][0];if(k>routeK&&routeK>=0)haptic('impactOccurred','light');routeK=k}
let cur=null,backing=false;const navStack=[];
function syncBack(){const hide=NOSTACK.includes(cur)||!navStack.length;try{hide?tg.BackButton.hide():tg.BackButton.show()}catch{}const b=$('webBack');if(b)b.style.display=(web&&!hide)?'block':'none'}
function goBack(){const prev=navStack.pop();if(!prev)return;backing=true;show(prev);backing=false}
function syncSelectionUI(){
  document.querySelectorAll('.start-opt[data-start]').forEach(el=>{
    el.classList.toggle('on',el.dataset.start===state.entry);
  });
  document.querySelectorAll('.tier[data-entry]').forEach(el=>{
    el.classList.toggle('on',el.dataset.entry===state.entry);
  });
  document.querySelectorAll('.tier[data-tier]').forEach(el=>{
    el.classList.toggle('on',state.entry==='dev'&&el.dataset.tier===state.tier);
  });
}
function renderChips(){
  const mainChip=state.entry==='dev'?state.tier:ENTRY_LABELS[state.entry];
  const items=[mainChip,...(state.otherNets?['+10 000 ₽ · Другие сети']:[]),...state.formats];
  $('fmtChips').innerHTML=items.filter(Boolean).map(x=>'<span class="chip">'+x+'</span>').join('');
  syncSelectionUI();
}
function show(id){if(!screens.includes(id))return;screens.forEach(x=>{const el=$(x);if(el)el.classList.toggle('active',x===id)});window.scrollTo(0,0);
if(cur!==id){if(!backing&&cur&&!NOSTACK.includes(cur))navStack.push(cur);cur=id;if(id!=='boot')track('screen_view',{screen:id});if(id==='order'||id==='price')renderChips()}syncBack();setRoute(id)}

document.addEventListener('click',e=>{
const a=e.target.closest('a[href^="#"]');if(a){e.preventDefault();show(a.getAttribute('href').slice(1));return}
const l=e.target.closest('a[data-doc]');if(l){e.preventDefault();const u=location.origin+l.getAttribute('href');try{web?window.open(u,'_blank'):tg.openLink(u)}catch{window.open(u,'_blank')}return}
const s=e.target.closest('.sq[data-f]');if(s){const f=s.dataset.f;state.formats.has(f)?state.formats.delete(f):state.formats.add(f);s.classList.toggle('on');haptic('selectionChanged');return}
const te=e.target.closest('.tier[data-entry]');if(te){state.entry=te.dataset.entry;renderChips();haptic('selectionChanged');return}
const t=e.target.closest('.tier[data-tier]');if(t){state.tier=t.dataset.tier;state.entry='dev';renderChips();haptic('selectionChanged');return}
const st=e.target.closest('.start-opt[data-start]');if(st){state.entry=st.dataset.start;renderChips();haptic('selectionChanged');return}
const ad=e.target.closest('#addonNet');if(ad){state.otherNets=!state.otherNets;ad.classList.toggle('on',state.otherNets);renderChips();haptic('selectionChanged');return}
});
$('webBack').onclick=goBack;
$('goDemo').onclick=()=>show(state.consent?'formats':'consent');
const syncC=()=>{$('consentBtn').disabled=!($('cb1').checked&&$('cb2').checked)};['cb1','cb2','cb3'].forEach(i=>$(i).addEventListener('change',syncC));syncC();
if(web){const l=$('cb3').closest('label');if(l)l.style.display='none'}
$('consentBtn').onclick=()=>{const m=!web&&$('cb3').checked;state.consent=true;try{localStorage.setItem('tn_consent',CONSENT_V)}catch{}
consentP=apiPost('/api/event',{event:'consent',meta:{processing:true,privacy:true,messages:m,v:CONSENT_V,src}}).catch(()=>{});
track('app_open',{tz:new Date().getTimezoneOffset(),web,src});
if(m){try{if(tg.initDataUnsafe.user.allows_write_to_pm!==true)tg.requestWriteAccess(()=>{})}catch{}}
show('formats')};

$('consultBtn').onclick=async()=>{
  if(state.sending)return;
  const channel=($('channelInput')&&$('channelInput').value||'').trim();
  const product=$('productInput').value.trim();
  const request=$('consultInput').value.trim();
  const status=$('consultStatus');

  if(state.entry==='voice'&&(!channel||!/(@|t\.me|http|\.)/i.test(channel))){
    status.className='error';
    status.textContent='Для бесплатного голосового разбора укажите, пожалуйста, ссылку на ваш ТГ-канал или блог (@юзернейм или ссылку).';
    return;
  }
  if(!product){
    status.className='error';
    status.textContent='Напишите, пожалуйста, вашу нишу, что вы продаёте и с каким чеком.';
    return;
  }

  state.sending=true;
  const b=$('consultBtn');
  b.disabled=true;
  b.textContent='Готовлю сообщение…';

  const chosenStep=state.entry==='dev'?('Запуск под ключ ('+state.tier+')'):ENTRY_LABELS[state.entry];
  const formats=[chosenStep,...(state.otherNets?['+10 000 ₽ · Другие сети']:[]),...state.formats].filter(Boolean);
  const fullProduct=channel?(product+' | Канал/блог: '+channel):product;
  const fullRequest=request||chosenStep;

  const draft='MINI\n\nПривет, Тория!\n🎯 С чего хочу начать: '+chosenStep+
    (channel?'\n🔗 Канал / блог: '+channel:'')+
    '\n\n📦 Ниша, продукт и чек:\n'+product+
    (request?'\n\n🧩 Задача для Mini App:\n'+request:'')+
    (state.formats.size||state.otherNets?'\n\nИнтересуют форматы: '+[...state.formats,...(state.otherNets?['+10 000 ₽ (другие сети)']:[])].join(', '):'');

  track('consultation_click',{entry:state.entry,formats});
  const go=()=>setTimeout(()=>openTg(CONFIG.consultationUrl+'?text='+encodeURIComponent(draft)),350);
  try{
    if(!isLocal)await apiPost('/api/consultation',{
      product:fullProduct,
      request:fullRequest,
      formats,
      intent:state.entry==='voice'?'voice':'miniapp',
      src
    });
    status.className='success';
    status.textContent='Готово! Открываю Telegram с уже заполненным сообщением.';
    track('consultation_sent',{entry:state.entry,formats});
    haptic('notificationOccurred','success');
    go();
  }catch(e){
    status.className='error';
    status.textContent='Сервер не ответил, но я всё равно открою Telegram с готовым сообщением.';
    go();
  }finally{
    setTimeout(()=>{
      state.sending=false;
      b.disabled=false;
      b.textContent='✨ ПОЛУЧИТЬ ГОЛОСОВОЙ РАЗБОР / ОСТАВИТЬ ЗАЯВКУ →';
    },900);
  }
};

/* start */
if(!web){try{tg.ready();tg.expand();tg.setHeaderColor('#F3EDE2');tg.setBackgroundColor('#F3EDE2');tg.BackButton.onClick(goBack)}catch{}}
document.documentElement.style.setProperty('--tg-vh',(tg&&tg.viewportStableHeight||innerHeight)+'px');
const go0=qs.get('go');show(go0==='order'?'order':go0==='price'?'price':go0==='formats'&&state.consent?'formats':'s0');
track('app_open',{tz:new Date().getTimezoneOffset(),web,src});
