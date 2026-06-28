// HORUS
const SUPABASE_URL = 'https://rvqraldjcjixcrjnceda.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cXJhbGRqY2ppeGNyam5jZWRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0NzgwMDQsImV4cCI6MjA5ODA1NDAwNH0.JLXMvYk2-v7zXyH5LrYp5anLc3FpZmkQB0daAcefUng'

const DB_KEY = 'horario_app_v1'
const THEME_KEY = 'horus_theme'
const ONBOARDING_KEY = 'horus_onboarding_done'
const AUTH_KEY = 'horus_auth'

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function hx(c){return /^#[0-9A-Fa-f]{6}$/.test(c)?c:'#888'}

const OLD_HC = ['Javier','Alejandra','Sergio','Yorbelis','Luz']
function cleanProfiles(saved) {
  if (!saved.profiles || !saved.profiles.length) return
  saved.profiles = saved.profiles.filter(p => !OLD_HC.includes(p))
  if (OLD_HC.includes(saved.activeProfile)) saved.activeProfile = saved.profiles[0] || ''
}
try {
  const old = localStorage.getItem(DB_KEY)
  if (old) { const parsed = JSON.parse(old); cleanProfiles(parsed); localStorage.setItem(DB_KEY, JSON.stringify(parsed)) }
} catch(e) { /* ignore */ }

// --- PERSISTENCIA LOCAL ---
const S = { M:{code:'M',label:'Mañana',hex:'#F2A33C',blocks:[{start:'08:30',end:'17:00'}]}, T:{code:'T',label:'Tarde',hex:'#5B8DEF',blocks:[{start:'16:15',end:'00:45'}]}, INT:{code:'INT',label:'Intermedio',hex:'#2DD4BF',blocks:[{start:'13:30',end:'22:00'}]}, P:{code:'P',label:'Partido',hex:'#C77DFF',blocks:[]}, V:{code:'V',label:'Vacaciones',hex:'#7C9885',blocks:[]}, B:{code:'B',label:'Baja',hex:'#EF5B5B',blocks:[]}, RE:{code:'RE',label:'Resto/Otro',hex:'#A0A0A0',blocks:[]} }
function defaultState() { return { activeProfile:'',profiles:[],shiftTypes:JSON.parse(JSON.stringify(S)),days:{},settings:{notificationsEnabled:false,alarmMinutesBefore:30},onboardingDone:false } }
function loadState() {
  try {
    const r=localStorage.getItem(DB_KEY);if(!r)return defaultState()
    const saved=JSON.parse(r)
    if(!saved||typeof saved!=='object')return defaultState()
    cleanProfiles(saved)
    return{...defaultState(),...saved,shiftTypes:{...S,...saved.shiftTypes}}
  }catch{return defaultState()}
}
function saveState() { state._savedAt = Date.now(); localStorage.setItem(DB_KEY,JSON.stringify(state)) }
function loadAuth() { try { const r=localStorage.getItem(AUTH_KEY);return r?JSON.parse(r):null }catch{return null} }
function saveAuth(u) { if(u)localStorage.setItem(AUTH_KEY,JSON.stringify(u));else localStorage.removeItem(AUTH_KEY); user=u }

let state = loadState()
let user = loadAuth()
let theme = localStorage.getItem(THEME_KEY) || 'dark'

// --- HELPERS ---
function $(id) { return document.getElementById(id) }
function show(sid) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); $(sid)?.classList.add('active') }
function applyTheme(t) { document.documentElement.setAttribute('data-theme',t); localStorage.setItem(THEME_KEY,t); const m=document.querySelector('meta[name="theme-color"]'); if(m)m.content=t==='dark'?'#0D0F13':'#F5F6FA' }

// --- SUPABASE FETCH ---
async function supabaseFetch(path, body) {
  const headers = { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
  if (user) headers['Authorization'] = `Bearer ${user.access_token}`
  const r = await fetch(SUPABASE_URL + path, { method: 'POST', headers, body: JSON.stringify(body) })
  return r
}

async function refreshToken() {
  if (!user || !user.refresh_token) return false
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: user.refresh_token })
    })
    if (r.ok) {
      const d = await r.json()
      saveAuth({ ...user, access_token: d.access_token, refresh_token: d.refresh_token })
      return true
    }
  } catch(e) { /* ignore */ }
  return false
}

async function login(email, password) {
  const r = await supabaseFetch('/auth/v1/token?grant_type=password', { email, password })
  if (!r.ok) { const e=await r.json(); throw new Error(e.error_description||e.message||e.msg||'Error') }
  return r.json()
}

async function signup(email, password) {
  const r = await supabaseFetch('/auth/v1/signup', { email, password })
  if (!r.ok) { const e=await r.json(); throw new Error(e.message||e.msg||'Error') }
}

async function authFetch(url, opts) {
  const h = { ...opts.headers, 'apikey': SUPABASE_ANON_KEY }
  if (user) h['Authorization'] = `Bearer ${user.access_token}`
  let r = await fetch(url, { ...opts, headers: h })
  if (r.status === 401 && await refreshToken()) {
    h['Authorization'] = `Bearer ${user.access_token}`
    r = await fetch(url, { ...opts, headers: h })
  }
  return r
}

let _sb=false
async function syncDown() {
  if (!user||_sb) return
  _sb=true
  try {
    const r = await authFetch(`${SUPABASE_URL}/rest/v1/user_data?select=data,updated_at&user_id=eq.${user.id}`, {})
    if (r.status === 401) { logout(); return }
    if (r.status === 400) { try { const e=await r.json(); console.warn('Sync 400:',e); return } catch { return } }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    if (d.length && d[0].data) {
      const remote = d[0].data
      const remoteTime = new Date(d[0].updated_at||0).getTime()
      const localTime = (state._savedAt||0)
      if (remoteTime > localTime) {
        const rd = remote.onboardingDone||localStorage.getItem(ONBOARDING_KEY)
        state = {...defaultState(), ...remote, shiftTypes: {...S, ...remote.shiftTypes}}
        if (rd) { state.onboardingDone = true; localStorage.setItem(ONBOARDING_KEY,'1') }
        saveState()
      }
    }
  } catch(e) { console.error('Sync down error:', e); showToast('✗ Error al sincronizar') }
  finally { _sb=false }
}

// --- SUPABASE PROFILES (onboarding status sync) ---
async function fetchProfileOnboarding() {
  if (!user) return null
  try {
    const r = await authFetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {})
    if (r.ok) {
      const d = await r.json()
      if (d.length) return d[0].onboarding_complete
    }
  } catch(e) { /* ignore */ }
  return null
}

async function setProfileOnboardingDone() {
  if (!user) return
  try {
    let r = await authFetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarding_complete: true })
    })
    const txt = await r.text()
    if (txt === '[]') {
      await authFetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: user.id, onboarding_complete: true })
      })
    }
  } catch(e) { console.log('Profile sync error:', e) }
}

async function syncUp() {
  if (!user) return
  try {
    state._savedAt = Date.now()
    const body = JSON.stringify({ data: state, updated_at: new Date().toISOString() })
    const h = { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }
    let r = await authFetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user.id}`, { method: 'PATCH', headers: h, body })
    if (r.status === 401) { logout(); return }
    if (r.status === 400) { try { const e=await r.json(); console.warn('SyncUp 400:',e); return } catch { return } }
    const txt = await r.text()
    if (txt === '[]' || r.status === 404) {
      r = await authFetch(`${SUPABASE_URL}/rest/v1/user_data`, {
        method: 'POST', headers: h, body: JSON.stringify({ user_id: user.id, data: state, updated_at: new Date().toISOString() })
      })
      if (!r.ok && r.status!==400) { try { const e=await r.json(); throw new Error(e.message||'Error al crear') } catch(e2) { if(!(e2 instanceof SyntaxError))throw e2 } }
    }
  } catch(e) { console.error('Sync up error:', e); showToast('✗ Error al guardar en la nube') }
}

// --- AUTH UI ---
document.querySelectorAll('.auth-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(x=>x.classList.remove('active'))
    t.classList.add('active')
    $('authSubmit').textContent = t.dataset.tab==='login' ? 'Iniciar sesión' : 'Crear cuenta'
    $('authError').textContent = ''
  })
})

$('authForm').addEventListener('submit', async e => {
  e.preventDefault()
  const btn = $('authSubmit'), err = $('authError')
  btn.disabled = true; btn.textContent = 'Espera...'; err.textContent = ''; err.style.color = 'var(--c-B)'
  try {
    const email = $('authEmail').value.trim(), pw = $('authPassword').value
    const isLogin = document.querySelector('.auth-tab.active')?.dataset.tab === 'login'
    if (isLogin) {
      const data = await login(email, pw)
      saveAuth({ id: data.user.id, email: data.user.email, access_token: data.access_token, refresh_token: data.refresh_token })
      await syncDown()
      await afterLogin()
      syncUp()
    } else {
      await signup(email, pw)
      err.textContent = 'Cuenta creada. Revisa tu email.'
      err.style.color = '#4CAF50'
    }
  } catch(e) { err.textContent = e.message; err.style.color = 'var(--c-B)' }
  btn.disabled = false; btn.textContent = document.querySelector('.auth-tab.active')?.dataset.tab==='login'?'Iniciar sesión':'Crear cuenta'
})

$('logoutBtn').onclick = logout
$('settingsLogout').onclick = logout
async function logout() { clearInterval(_int1);clearInterval(_int2); st.forEach(t=>clearTimeout(t)); st=[]; saveAuth(null); state = defaultState(); saveState(); show('s-auth') }

// --- FLUJO ---
async function afterLogin() {
  const localDone = localStorage.getItem(ONBOARDING_KEY)
  if (localDone) { enterApp(); return }
  // Check state fallback (survives sync across devices)
  if (state.onboardingDone) { localStorage.setItem(ONBOARDING_KEY,'1'); enterApp(); return }
  // Check Supabase profiles
  const remoteDone = await fetchProfileOnboarding()
  if (remoteDone) { localStorage.setItem(ONBOARDING_KEY,'1'); state.onboardingDone=true; saveState(); enterApp(); return }
  show('s-onboarding'); goOnboarding(0)
}

let _int1,_int2
function enterApp() {
  show('s-app')
  renderAll()
  sa()
  _int1=setInterval(()=>sa(),60000)
  _int2=setInterval(()=>{
    const now=new Date()
    const dt=$('dtTime');if(dt)dt.textContent=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
    const row=document.querySelector('.day-row.is-today .now-line')
    if(row){const nm=now.getHours()*60+now.getMinutes();row.style.left=`${(nm/1440*100).toFixed(2)}%`}
  },10000)
}

// --- ONBOARDING ---
let oStep=0, oMembers=[]
function renderOMembers() {
  $('onboardingMemberList').innerHTML = oMembers.map((m,i)=>`<span class="member-tag">${esc(m)}<button data-i="${i}" aria-label="Eliminar ${esc(m)}">×</button></span>`).join('')
  document.querySelectorAll('.member-list button').forEach(b=>b.addEventListener('click',()=>{oMembers.splice(Number(b.dataset.i),1);renderOMembers()}))
}
function goOnboarding(s) {
  oStep=s; document.querySelectorAll('.onboarding-content').forEach(c=>c.classList.remove('active')); document.querySelector(`.onboarding-content[data-step="${s}"]`).classList.add('active')
  document.querySelectorAll('.onboarding-step').forEach((x,i)=>{x.classList.remove('active','done');if(i<s)x.classList.add('done');if(i===s)x.classList.add('active')})
  $('onboardingPrev').style.visibility=s===0?'hidden':'visible'; $('onboardingNext').textContent=s===2?'Finalizar':'Siguiente'
  if (s===0) $('onboardingName').value = ''
  if (s===1) { oMembers=[]; renderOMembers() }
}
$('onboardingNext').addEventListener('click',()=>{
  if(oStep===0) { const n=$('onboardingName').value.trim(); if(!n){alert('Ingresa tu nombre');return};goOnboarding(1);return }
  if(oStep<2)goOnboarding(oStep+1); else {
    const n=$('onboardingName').value.trim()||'Usuario'; state.activeProfile=n
    if(!state.profiles.includes(n))state.profiles.unshift(n)
    oMembers.forEach(m=>{if(!state.profiles.includes(m))state.profiles.push(m)})
    state.settings.notificationsEnabled=$('onboardingNotifSwitch').classList.contains('on')
    state.settings.alarmMinutesBefore=Number($('onboardingMinutes').value)
    state.onboardingDone=true; saveState(); localStorage.setItem(ONBOARDING_KEY,'1'); setProfileOnboardingDone(); enterApp()
  }
})
$('onboardingPrev').addEventListener('click',()=>{if(oStep>0)goOnboarding(oStep-1)})
$('onboardingAddMember').addEventListener('click',()=>{const i=$('onboardingMemberInput'),n=i.value.trim();if(!n)return;if(oMembers.includes(n)){alert('Ya existe');return};if(oMembers.length>=20){alert('Máximo 20 miembros');return};oMembers.push(n);i.value='';renderOMembers()})
$('onboardingMemberInput').addEventListener('keydown',e=>{if(e.key==='Enter'){$('onboardingAddMember').click()}})
$('onboardingNotifSwitch').addEventListener('click',async function(){
  if(!this.classList.contains('on')&&Notification.permission!=='granted'){
    const p=await Notification.requestPermission();
    if(p!=='granted'){alert('Se necesita permiso para notificaciones');return}
  }
  this.classList.toggle('on')
})

// --- CALENDARIO ---
const DOW=['D','L','M','X','J','V','S'], MON=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
let cm=new Date().getMonth(), cy=new Date().getFullYear(), adk=null, pb=[], st=[]
function key(y,m,d){return`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
function tk(){const t=new Date();return key(t.getFullYear(),t.getMonth(),t.getDate())}
function tm(t){const[h,m]=t.split(':').map(Number);if(isNaN(h)||isNaN(m)||h<0||h>23||m<0||m>59)return 0;return h*60+m}
function _hasST(sc){return Object.prototype.hasOwnProperty.call(state.shiftTypes,sc)}
function gd(k){return state.days[k]||{date:k,sc:null,dt:'normal',notes:''}}
function gb(d){if(d.dt!=='normal')return d.sc==='P'?(d.bo||[]):(d.dtb||[]);if(d.sc==='P'||d.sc==='RE')return d.bo||[];if(d.sc&&_hasST(d.sc))return d.bo?.length?d.bo:state.shiftTypes[d.sc].blocks;return[]}
function cal(){
  const c=$('calendarList');if(!c)return;c.innerHTML='';$('monthLabel').textContent=`${MON[cm]} ${cy}`
  const dim=new Date(cy,cm+1,0).getDate(),t=tk(),nm=tm(`${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}`)
  // Draw timeline axis
  const ax=$('timelineAxis');if(ax){ax.innerHTML='';for(let h=0;h<24;h+=3)ax.innerHTML+=`<span style="left:${(h/24*100).toFixed(2)}%">${String(h).padStart(2,'0')}:00</span>`;ax.innerHTML+=`<span style="left:${(23.5/24*100).toFixed(2)}%">24:00</span>`}
  // Day rows
  for(let d=1;d<=dim;d++){const k=key(cy,cm,d),day=gd(k),isT=k===t,isE=day.dt!=='normal',row=document.createElement('div');row.className=`day-row${isT?' is-today':''}${isE?' is-exception':''}${!day.sc&&!isE?' empty':''}`;const bl=gb(day),bg=hx(isE?'#F2A33C':(_hasST(day.sc)?state.shiftTypes[day.sc].hex:'#888'));const th=bl.flatMap(b=>{const sm=tm(b.start),em0=tm(b.end);if(em0>sm)return[{s:sm,e:em0,l:em0-sm>120?`${esc(b.start)}-${esc(b.end)}`:''}];return[{s:sm,e:1440,l:`${esc(b.start)}-${esc(b.end)}`},{s:0,e:em0,l:''}]}).map(({s,e,l})=>`<div class="block" style="left:${(s/1440*100).toFixed(2)}%;width:${((e-s)/1440*100).toFixed(2)}%;background:${bg}">${l?`<span class="block-label">${l}</span>`:''}</div>`).join('');let tag=day.sc?`<span class="tag" style="background:${bg}">${esc(day.sc)}</span>`:'—';if(isE)tag=day.dt==='feriado'?'FER':'EVT';const noteIcon=day.notes?`<span class="note-icon">📝</span>`:'';row.innerHTML=`<div><div class="day-num">${d}</div><div class="day-dow">${DOW[new Date(cy,cm,d).getDay()]}</div></div><div class="day-track">${th}${isT?`<div class="now-line" style="left:${(nm/1440*100).toFixed(2)}%"></div>`:''}</div><div class="day-code">${noteIcon}${tag}</div>`;row.addEventListener('click',()=>od(k));c.appendChild(row)}
  // Update dashboard
  updateDashboard()
}
function leg(){const e=$('legend');if(!e)return;e.innerHTML=Object.values(state.shiftTypes).map(s=>`<span><span class="dot" style="background:${hx(s.hex)}"></span>${esc(s.code)} · ${esc(s.label)}</span>`).join('')}

function updateDashboard(){
  const dt=$('dashboardToday');if(!dt)return
  const k=tk(),day=gd(k),bl=gb(day)
  $('dtDate').textContent=new Date().toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'}).replace(/^\w/,c=>c.toUpperCase())
  const now=new Date();$('dtTime').textContent=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
  if(day.sc&&_hasST(day.sc)){$('dtShift').textContent=state.shiftTypes[day.sc].label;$('dtShift').style.color=state.shiftTypes[day.sc].hex}
  else if(day.sc){$('dtShift').textContent=day.sc;$('dtShift').style.color='var(--text)'}
  else{$('dtShift').textContent='Sin turno';$('dtShift').style.color='var(--text-dim)'}
  if(bl.length){const h=bl.map(b=>`${b.start}–${b.end}`).join(' · ');$('dtHours').textContent=h;$('dtHours').style.display='block'}
  else $('dtHours').style.display='none'
  if(day.notes){$('dtNotes').textContent='📝 '+day.notes;$('dtNotes').style.display='block'}
  else $('dtNotes').style.display='none'
}

// --- SHEET ---
function od(k){adk=k;const day=gd(k);pb=JSON.parse(JSON.stringify(gb(day)));const[y,m,d]=k.split('-').map(Number);$('sheetTitle').textContent=`${d} de ${MON[m-1]}`;$('sheetSub').textContent=new Date(y,m-1,d).toLocaleDateString('es-ES',{weekday:'long'});$('sheetNotes').value=day.notes||'';const cr=$('shiftChips');cr.innerHTML=Object.values(state.shiftTypes).map(s=>`<button class="chip${day.sc===s.code?' selected':''}" data-code="${esc(s.code)}"><span class="dot" style="background:${hx(s.hex)}"></span>${esc(s.label)}</button>`).join('')+'<button class="chip'+(!day.sc?' selected':'')+'" data-code="">Sin turno</button>';cr.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{cr.querySelectorAll('.chip').forEach(x=>x.classList.remove('selected'));c.classList.add('selected');day.sc=c.dataset.code||null;const isE=day.dt!=='normal',ed=isE||day.sc==='P'||day.sc==='RE';if(isE&&day.sc!=='P')pb=day.dtb?.length?day.dtb:[{start:'08:30',end:'17:00'}];else if(day.sc==='P')pb=day.bo?.length?day.bo:[{start:'08:30',end:'13:00'},{start:'17:00',end:'21:00'}];else if(day.sc==='RE')pb=day.bo?.length?day.bo:[{start:'08:30',end:'17:00'}];else if(day.sc)pb=JSON.parse(JSON.stringify(state.shiftTypes[day.sc].blocks));else pb=[];rb(ed)}));const tr=$('dayTypeToggle');tr.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b.dataset.type===(day.dt||'normal'));b.onclick=()=>{tr.querySelectorAll('button').forEach(x=>x.classList.remove('active'));b.classList.add('active');day.dt=b.dataset.type;const isE=day.dt!=='normal';if(isE&&day.sc!=='P')pb=day.dtb?.length?day.dtb:[{start:'08:30',end:'17:00'}];else if(day.sc==='P')pb=day.bo?.length?day.bo:[{start:'08:30',end:'13:00'},{start:'17:00',end:'21:00'}];else if(!isE&&day.sc)pb=JSON.parse(JSON.stringify(state.shiftTypes[day.sc]?.blocks||[]));rb(isE||day.sc==='P'||day.sc==='RE')}});rb(day.dt!=='normal'||day.sc==='P'||day.sc==='RE');$('btnDeleteDay').onclick=()=>{if(!confirm('¿Eliminar este día?'))return;delete state.days[k];saveState();cs();cal()};$('btnSaveDay').onclick=()=>{day.notes=$('sheetNotes').value.trim();const isE=day.dt!=='normal';if(isE&&day.sc!=='P')day.dtb=pb;else if(day.sc==='P'||day.sc==='RE')day.bo=pb;if(!day.sc&&day.dt==='normal'&&!day.notes)delete state.days[adk];else state.days[adk]=day;saveState();cs();cal();sa()};$('sheetBackdrop').classList.add('open');$('daySheet').classList.add('open')}
function rb(ed){const w=$('blocksEditor');w.innerHTML='';if(!ed){w.innerHTML=`<p class="sheet-sub" style="margin-top:-6px">${day.sc?'Horario del catálogo.':'Selecciona un turno para editar horarios.'}</p>`;return};pb.forEach((b,i)=>{const r=document.createElement('div');r.className='time-row';r.innerHTML=`<div style="flex:1"><span class="field-label">Inicio ${i+1}</span><input type="time" value="${esc(b.start)}" data-i="${i}" data-k="start"></div><div style="flex:1"><span class="field-label">Fin ${i+1}</span><input type="time" value="${esc(b.end)}" data-i="${i}" data-k="end"></div>`;w.appendChild(r)});w.querySelectorAll('input').forEach(inp=>inp.addEventListener('change',e=>{const i=Number(e.target.dataset.i),k=e.target.dataset.k;pb[i][k]=e.target.value;if(k==='end'&&pb[i].start&&tm(pb[i].end)<=tm(pb[i].start)){try{if(!confirm('¿El turno cruza medianoche?'))pb[i][k]=pb[i].start}catch{pb[i][k]=pb[i].start}}}))}
function cs(){$('sheetBackdrop').classList.remove('open');$('daySheet').classList.remove('open')}

// --- CATALOG ---
function showToast(msg){
  const t=document.createElement('div');t.textContent=msg
  t.style.cssText='position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:10px 20px;border-radius:999px;font-size:13px;z-index:100;'
  document.body.appendChild(t);setTimeout(()=>t.remove(),2000)
}
function rc(){const e=$('catalogList');if(!e)return;e.innerHTML=Object.values(state.shiftTypes).map(s=>{const na=s.code==='V'||s.code==='B'||s.code==='P',b=s.blocks[0]||{start:'',end:''};return`<div class="shift-card"><span class="swatch" style="background:${hx(s.hex)}"></span><div class="meta"><div class="name">${esc(s.label)} <span style="color:var(--text-dim);font-weight:400">(${esc(s.code)})</span></div><div class="hours">${na?'Sin horario fijo':'Horario por defecto'}</div></div>${na?'':`<input type="time" data-code="${esc(s.code)}" data-k="start" value="${esc(b.start)}"><input type="time" data-code="${esc(s.code)}" data-k="end" value="${esc(b.end)}">`}</div>`}).join('');e.querySelectorAll('input[type=time]').forEach(inp=>inp.addEventListener('change',e=>{const c=e.target.dataset.code,k=e.target.dataset.k;if(!state.shiftTypes[c].blocks[0])state.shiftTypes[c].blocks[0]={start:'',end:''};state.shiftTypes[c].blocks[0][k]=e.target.value;saveState();cal();showToast('✓ Guardado')}))}

// --- SETTINGS ---
function rs(){const pr=$('profileRow');if(!pr)return;pr.innerHTML=state.profiles.map(p=>`<label class="profile-chip${state.activeProfile===p?' active':''}"><input type="radio" name="profile" value="${esc(p)}"${state.activeProfile===p?' checked':''}>${esc(p)}</label>`).join('');pr.querySelectorAll('input[type=radio]').forEach(r=>r.addEventListener('change',e=>{state.activeProfile=e.target.value;saveState();rs();$('profilePill').textContent=state.activeProfile}));$('btnAddProfile').onclick=()=>{const i=$('newProfileName'),n=i.value.trim();if(!n)return;if(!state.profiles.includes(n))state.profiles.push(n);state.activeProfile=n;i.value='';saveState();rs()};const pb=$('permBanner');if('Notification'in window&&Notification.permission!=='granted'){pb.style.display='flex';pb.querySelector('button').onclick=async()=>{if((await Notification.requestPermission())==='granted'){state.settings.notificationsEnabled=true;saveState();rs();sa()}}}else pb.style.display='none';const ns=$('notifSwitch');ns.classList.toggle('on',state.settings.notificationsEnabled);ns.onclick=()=>{if(Notification.permission!=='granted'){alert('Concede permiso arriba.');return};state.settings.notificationsEnabled=!state.settings.notificationsEnabled;saveState();rs();sa()};const ms=$('minutesBefore');ms.value=state.settings.alarmMinutesBefore;ms.onchange=e=>{state.settings.alarmMinutesBefore=Number(e.target.value);saveState();sa()};if(user)$('userEmailDisplay').textContent=user.email}

// --- ALARMAS ---
function sa(){const nw=Date.now();st.forEach(t=>clearTimeout(t));st=[];if(!state.settings.notificationsEnabled||Notification.permission!=='granted')return;for(let o=0;o<=1;o++){const d=new Date(nw+o*86400000),k=key(d.getFullYear(),d.getMonth(),d.getDate());gb(gd(k)).forEach(b=>{const[h,m]=b.start.split(':').map(Number),at=new Date(d.getFullYear(),d.getMonth(),d.getDate(),h,m).getTime()-state.settings.alarmMinutesBefore*60000,delay=at-nw;if(delay>0&&delay<172800000)st.push(setTimeout(()=>{navigator.serviceWorker?.ready.then(r=>r.active?.postMessage({type:'SHOW_NOTIFICATION',payload:{title:`Turno en ${state.settings.alarmMinutesBefore} min`,body:`${state.shiftTypes[gd(k).sc]?.label||'Turno'} · entra a las ${b.start}`,tag:`turno-${k}-${b.start}`}}))},delay))})}}

const closeSheet = cs
let syncing=false
$('syncBtn').onclick = async () => {
  if(syncing)return;syncing=true
  const btn=$('syncBtn'),icon=btn.querySelector('svg'),b=$('syncBar'),m=$('syncMsg')
  btn.disabled=true;icon.classList.add('spinning');b.style.display='flex';b.className='sync-bar syncing';m.textContent='Sincronizando...'
  try{await syncDown();await syncUp();renderAll();b.className='sync-bar success';m.textContent='✓ Sincronizado correctamente'}
  catch(e){b.className='sync-bar error';m.textContent='✗ Error: '+e.message}
  setTimeout(()=>{b.style.display='none';b.className='sync-bar';icon.classList.remove('spinning');btn.disabled=false;syncing=false},2500)
}

document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('daySheet').classList.contains('open'))cs()})

// --- NAV ---
document.querySelectorAll('.bottom-nav button').forEach(b=>b.addEventListener('click',()=>sv(b.dataset.view)))
document.getElementById('prevMonth').onclick=()=>{if($('daySheet').classList.contains('open'))return;cm--;if(cm<0){cm=11;cy--}cal()}
document.getElementById('nextMonth').onclick=()=>{if($('daySheet').classList.contains('open'))return;cm++;if(cm>11){cm=0;cy++}cal()}
document.getElementById('sheetBackdrop').addEventListener('click',cs)
document.getElementById('btnCancelDay').addEventListener('click',cs)
document.getElementById('themeToggle').onclick=()=>{theme=theme==='dark'?'light':'dark';applyTheme(theme);ut()}
document.getElementById('settingsThemeSwitch').onclick=()=>{theme=theme==='dark'?'light':'dark';applyTheme(theme);ut()}
function ut(){const sw=$('settingsThemeSwitch');if(sw)sw.classList.toggle('on',theme==='dark')}
function sv(n){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${n}`));document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===n));if(n==='calendar'){updateDashboard()}if(n==='catalog')rc();if(n==='settings')rs()}

// Make switches keyboard-accessible
document.querySelectorAll('.switch').forEach(s=>{s.setAttribute('role','switch');s.setAttribute('tabindex','0');s.setAttribute('aria-checked',s.classList.contains('on'));s.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();s.click()}});const obs=new MutationObserver(()=>s.setAttribute('aria-checked',s.classList.contains('on')));obs.observe(s,{attributes:true,attributeFilter:['class']})})
function renderAll(){cal();leg();$('profilePill').textContent=state.activeProfile}

// --- SERVICE WORKER ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
  })
}

// --- BOOT ---
window.addEventListener('online',()=>{showToast('✓ Conexión restaurada');if($('localModeMsg'))$('localModeMsg').style.display='none';if(user){syncDown();syncUp()}})
window.addEventListener('offline',()=>{showToast('✗ Sin conexión (modo offline)');if($('localModeMsg'))$('localModeMsg').style.display='block'})
applyTheme(theme); ut()
if($('localModeMsg'))$('localModeMsg').style.display=navigator.onLine?'none':'block'
if (user) {
  if (localStorage.getItem(ONBOARDING_KEY)||state.onboardingDone) { enterApp(); syncDown() }
  else { afterLogin() }
} else {
  show('s-auth')
}