const API = '/api';
let currentUser = null;
let csrfToken = null;
let activePage = 'dashboard';
let currentMap = null;
let selectedLocation = null;
let cachedComplaints = [];
let selectedRating = 5;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function statusClass(status) { return 'status-' + String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function priorityClass(priority) { return 'priority-' + String(priority || '').toLowerCase(); }
function statusPill(status) { return `<span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>`; }
function priorityPill(priority) { return `<span class="priority-pill ${priorityClass(priority)}">${escapeHtml(priority)} priority</span>`; }
function dateShort(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
}
function dateLong(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString([], {day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit'});
}
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'error' : type === 'info' ? 'info' : ''}`;
  toast.textContent = message;
  $('#toast-root').appendChild(toast);
  setTimeout(() => toast.remove(), 3600);
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (csrfToken && !['GET','HEAD'].includes((options.method || 'GET').toUpperCase())) headers.set('X-CSRF-Token', csrfToken);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(API + path, {...options, headers, credentials:'same-origin'});
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}
function setUser(user, token) {
  window.CleanTrackIntro?.close?.();
  currentUser = user;
  csrfToken = token;
  $('#landing-page')?.classList.add('hidden');
  $('#login-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#header-name').textContent = user.name;
  $('#header-role').textContent = `${user.role[0].toUpperCase()}${user.role.slice(1)} workspace`;
  $('#header-avatar').textContent = user.name.charAt(0).toUpperCase();
  $('#header-avatar').className = `avatar ${user.role === 'admin' ? 'avatar-blue' : user.role === 'worker' ? 'avatar-amber' : 'avatar-mint'}`;
  buildNavigation();
  loadNotifications();
  navigate('dashboard');
}
function buildNavigation() {
  let groups = [];
  if (currentUser.role === 'resident') {
    groups = [
      {label:'MY SPACE',items:[['dashboard','⌂','Overview'],['report','＋','Report an issue'],['complaints','▤','My complaints']]},
    ];
  } else if (currentUser.role === 'admin') {
    groups = [
      {label:'OPERATIONS',items:[['dashboard','⌂','Overview'],['complaints','▤','Complaint inbox'],['map','⌖','Live issue map']]},
      {label:'MANAGEMENT',items:[['teams','♧','Collection teams']]},
    ];
  } else {
    groups = [
      {label:'FIELD WORK',items:[['dashboard','⌂','My overview'],['tasks','▣','Assigned tasks'],['map','⌖','Task locations']]},
    ];
  }
  $('#sidebar-nav').innerHTML = groups.map(group => `<div class="nav-caption">${group.label}</div>${group.items.map(item => `<button class="nav-item ${activePage===item[0]?'active':''}" data-page="${item[0]}"><span class="nav-icon">${item[1]}</span>${item[2]}</button>`).join('')}`).join('');
  $$('.nav-item').forEach(button => button.addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    navigate(button.dataset.page);
  }));
}
function navigate(page) {
  activePage = page;
  const labels = {dashboard:'Overview',report:'Report an issue',complaints:currentUser.role==='resident'?'My complaints':'Complaint inbox',map:'Geographic overview',teams:'Collection teams',tasks:'Assigned tasks'};
  $('#page-title').textContent = labels[page] || 'Workspace';
  buildNavigation();
  closeMap();
  if (page === 'dashboard') renderDashboard();
  else if (page === 'report') renderReportForm();
  else if (page === 'complaints') renderComplaintsPage();
  else if (page === 'map') renderMapPage();
  else if (page === 'teams') renderTeamsPage();
  else if (page === 'tasks') renderTasksPage();
}
function closeMap() {
  if (currentMap) {
    currentMap.off();
    currentMap.remove();
    currentMap = null;
  }
}
function requireLeaflet() {
  if (!window.L) {
    showToast('Map library could not load. Check your internet connection.', 'error');
    return false;
  }
  return true;
}
function createMap(elementId, center = [22.5726, 88.3639], zoom = 12) {
  if (!requireLeaflet()) return null;
  const node = document.getElementById(elementId);
  if (!node) return null;
  currentMap = L.map(node, {scrollWheelZoom:false}).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:19,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  }).addTo(currentMap);
  return currentMap;
}
function addComplaintMarker(map, complaint, focus = false) {
  if (!map || !Number.isFinite(Number(complaint.latitude)) || !Number.isFinite(Number(complaint.longitude))) return;
  const color = complaint.status === 'Closed' ? '#4b9a70' : complaint.priority === 'Critical' || complaint.priority === 'High' ? '#d45b51' : '#d39a37';
  const marker = L.circleMarker([Number(complaint.latitude), Number(complaint.longitude)], {radius:8,color:'#fff',weight:2,fillColor:color,fillOpacity:.96}).addTo(map);
  marker.bindPopup(`<div class="popup-title">${escapeHtml(complaint.public_id)} · ${escapeHtml(complaint.category)}</div><div class="popup-sub">${escapeHtml(complaint.area)} · ${escapeHtml(complaint.status)}</div>`);
  marker.on('click', () => openComplaint(complaint.id));
  if (focus) map.setView([Number(complaint.latitude), Number(complaint.longitude)], 15);
  return marker;
}
async function loadComplaints(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key,value]) => { if (value) params.set(key,value); });
  const data = await api('/complaints' + (params.toString() ? `?${params}` : ''));
  cachedComplaints = data.complaints;
  return data.complaints;
}
function pageHeading(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading"><div><span class="eyebrow eyebrow-green">${eyebrow}</span><h1>${title}</h1><p>${subtitle}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ''}</div>`;
}
function statCard(label, value, foot, icon, iconClass) {
  return `<div class="card stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon ${iconClass}">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`;
}
function complaintRow(c) {
  return `<tr>
    <td class="table-id">${escapeHtml(c.public_id)}</td>
    <td><div class="table-main"><b>${escapeHtml(c.category)}</b><small>${escapeHtml(c.area)} · ${escapeHtml(c.description.slice(0,52))}${c.description.length>52?'…':''}</small></div></td>
    <td>${priorityPill(c.priority)}</td><td>${statusPill(c.status)}</td>
    <td>${escapeHtml(dateShort(c.created_at))}</td>
    <td><button class="btn btn-outline btn-small" data-open-complaint="${c.id}">View</button></td>
  </tr>`;
}
function bindComplaintButtons(root = document) {
  $$('[data-open-complaint]', root).forEach(button => button.addEventListener('click', () => openComplaint(Number(button.dataset.openComplaint))));
}
async function renderDashboard() {
  const content = $('#page-content');
  content.innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div><b>Loading your workspace…</b></div>`;
  try {
    const complaints = await loadComplaints();
    if (currentUser.role === 'admin') {
      const d = await api('/dashboard');
      const recent = complaints.slice(0,6);
      const maxCat = Math.max(1, ...d.by_category.map(x => x.count));
      content.innerHTML = `${pageHeading('OPERATIONS OVERVIEW',`Good ${greeting()}, ${escapeHtml(currentUser.name.split(' ')[0])}.`,'Here is the current picture across your waste-management operations.', '<button class="btn btn-primary" data-go="complaints">Open complaint inbox →</button>')}
        <div class="stat-grid">
          ${statCard('Total reports',d.total,'All registered reports','▤','icon-green')}
          ${statCard('Awaiting action',d.submitted,'Submitted, review or information','◷','icon-amber')}
          ${statCard('Active work',d.in_progress,'Assigned, in progress or awaiting check','↗','icon-blue')}
          ${statCard('Verified closed',d.closed,`${d.resolution_rate}% resolution rate`,'✓','icon-green')}
        </div>
        <div class="content-grid">
          <section class="card"><div class="card-header"><div><div class="card-title">Reports by category</div><div class="card-subtitle">Where residents are reporting issues</div></div><span class="chart-legend">${d.by_category.length} categories</span></div><div class="card-body">${d.by_category.length?d.by_category.map(x=>`<div class="category-row"><span class="category-name">${escapeHtml(x.category)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3,100*x.count/maxCat)}%"></div></div><span class="category-count">${x.count}</span></div>`).join(''):'<div class="empty-state">No category data yet.</div>'}</div></section>
          <section class="card"><div class="card-header"><div><div class="card-title">Operations pulse</div><div class="card-subtitle">Items that may need attention</div></div><span class="stat-icon icon-amber">✦</span></div><div class="card-body"><div class="mini-metric"><span>Overdue over 48 hours</span><b>${d.overdue}</b></div><div class="mini-metric"><span>Reopened reports</span><b>${d.reopened}</b></div><div class="mini-metric"><span>Average time to close</span><b>${d.average_resolution_hours===null?'—':d.average_resolution_hours+' hrs'}</b></div><div class="mini-metric"><span>Collection team members</span><b>${d.team_workload.length}</b></div><div class="notice-box"><b>Operational reminder</b>Review high-priority and overdue complaints before allocating new work.</div></div></section>
        </div>
        <section class="card table-card"><div class="card-header"><div><div class="card-title">Latest reports</div><div class="card-subtitle">Recently submitted or updated complaints</div></div><button class="section-link" data-go="complaints">View all →</button></div>${renderTable(recent)}</section>`;
      bindGoButtons();
      bindComplaintButtons(content);
    } else if (currentUser.role === 'resident') {
      const open = complaints.filter(c=>!['Closed','Rejected','Duplicate'].includes(c.status)).length;
      const closed = complaints.filter(c=>c.status==='Closed').length;
      const recent = complaints.slice(0,5);
      content.innerHTML = `${pageHeading('RESIDENT SPACE',`Hello, ${escapeHtml(currentUser.name.split(' ')[0])}.`,'Report a local waste issue or check the progress of a report you have already made.','<button class="btn btn-primary" data-go="report">＋ Report an issue</button>')}
        <div class="stat-grid">${statCard('Your reports',complaints.length,'Reports submitted by you','▤','icon-green')}${statCard('Being handled',open,'Still in the resolution process','◷','icon-amber')}${statCard('Resolved',closed,'Verified and closed reports','✓','icon-blue')}${statCard('Your area',escapeHtml(currentUser.area||'—'),'Registered neighbourhood','⌖','icon-green')}</div>
        <div class="content-grid"><section class="card"><div class="card-header"><div><div class="card-title">Your recent reports</div><div class="card-subtitle">Follow the progress of each issue</div></div><button class="section-link" data-go="complaints">All reports →</button></div>${recent.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Reference</th><th>Issue</th><th>Status</th><th></th></tr></thead><tbody>${recent.map(c=>`<tr><td class="table-id">${escapeHtml(c.public_id)}</td><td><div class="table-main"><b>${escapeHtml(c.category)}</b><small>${escapeHtml(c.area)}</small></div></td><td>${statusPill(c.status)}</td><td><button class="btn btn-outline btn-small" data-open-complaint="${c.id}">Track</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state"><div class="empty-icon">♧</div><b>No reports yet</b><p>When you submit an issue, its progress will appear here.</p><button class="btn btn-primary btn-small" data-go="report">Create your first report</button></div>'}</section>
        <section class="card"><div class="card-header"><div><div class="card-title">How CleanTrack works</div><div class="card-subtitle">A transparent path from report to resolution</div></div></div><div class="card-body"><div class="activity-list"><div class="activity-item"><span class="activity-dot"></span><div><b>1. Report the issue</b><p>Add a category, description, photo and map location.</p></div></div><div class="activity-item"><span class="activity-dot"></span><div><b>2. Follow the work</b><p>Administration reviews and assigns the report.</p></div></div><div class="activity-item"><span class="activity-dot"></span><div><b>3. Verify resolution</b><p>Completion is checked before a report is closed.</p></div></div></div><div class="notice-box"><b>Privacy note</b>Your personal details are not displayed on the public issue map.</div></div></section></div>`;
      bindGoButtons(); bindComplaintButtons(content);
    } else {
      const active = complaints.filter(c=>!['Closed','Rejected','Duplicate'].includes(c.status));
      const started = complaints.filter(c=>c.status==='In Progress').length;
      const verify = complaints.filter(c=>c.status==='Resolved – Pending Verification').length;
      content.innerHTML = `${pageHeading('FIELD OPERATIONS',`Hello, ${escapeHtml(currentUser.name.split(' ')[0])}.`,'Your assigned tasks and the next actions needed to complete them.','<button class="btn btn-primary" data-go="tasks">View assigned tasks →</button>')}
        <div class="stat-grid">${statCard('Assigned tasks',active.length,'Tasks currently assigned to you','▣','icon-blue')}${statCard('In progress',started,'Work started','↗','icon-amber')}${statCard('Awaiting verification',verify,'Submitted for administrator review','✓','icon-green')}${statCard('Completed',complaints.filter(c=>c.status==='Closed').length,'Verified closed tasks','♧','icon-green')}</div>
        <section class="card"><div class="card-header"><div><div class="card-title">Your next tasks</div><div class="card-subtitle">Prioritised by issue urgency</div></div><button class="section-link" data-go="tasks">All tasks →</button></div><div class="card-body">${active.length?active.slice(0,4).map(taskCard).join(''):'<div class="empty-state"><div class="empty-icon">✓</div><b>All clear</b><p>You have no open assigned tasks.</p></div>'}</div></section>`;
      bindGoButtons(); bindTaskButtons(content); bindComplaintButtons(content);
    }
    await refreshNotificationDot();
  } catch (error) { content.innerHTML = `<div class="empty-state"><b>Could not load your dashboard</b><p>${escapeHtml(error.message)}</p><button class="btn btn-outline btn-small" onclick="location.reload()">Refresh</button></div>`; }
}
function greeting() { const h=new Date().getHours(); return h<12?'morning':h<17?'afternoon':'evening'; }
function renderTable(items) {
  if (!items.length) return '<div class="empty-state"><div class="empty-icon">▤</div><b>No complaints found</b><p>New complaints will appear here.</p></div>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Reference</th><th>Reported issue</th><th>Priority</th><th>Status</th><th>Submitted</th><th></th></tr></thead><tbody>${items.map(complaintRow).join('')}</tbody></table></div>`;
}
function bindGoButtons() { $$('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go))); }
function taskCard(c) {
  return `<div class="card task-card"><div class="task-priority ${(c.priority||'').toLowerCase()}"></div><div class="task-content"><h3>${escapeHtml(c.category)} <span class="muted">· ${escapeHtml(c.public_id)}</span></h3><p>${escapeHtml(c.description)}</p><div class="task-meta"><span>⌖ ${escapeHtml(c.area)}</span><span>◷ ${escapeHtml(dateShort(c.created_at))}</span>${priorityPill(c.priority)}${statusPill(c.status)}</div><div class="task-actions"><button class="btn btn-outline btn-small" data-open-complaint="${c.id}">Task details</button>${c.status==='Assigned'?`<button class="btn btn-primary btn-small" data-start-task="${c.id}">Start task</button>`:''}</div></div></div>`;
}
function bindTaskButtons(root=document) {
  $$('[data-start-task]',root).forEach(button=>button.addEventListener('click',async()=>{
    try { await api(`/complaints/${button.dataset.startTask}/work`,{method:'POST',body:JSON.stringify({action:'start',note:'Work started by field team'})}); showToast('Task marked as in progress.'); navigate(activePage); }
    catch(e){showToast(e.message,'error');}
  }));
}
async function renderReportForm() {
  const content = $('#page-content');
  selectedLocation = null;
  content.innerHTML = `${pageHeading('CITIZEN REPORTING','Report a waste issue','Provide clear details so the responsible team can locate and assess the issue.')}
    <form id="report-form" class="form-layout" enctype="multipart/form-data">
      <section class="card form-card"><h3>Issue details</h3><p>Fields marked with an asterisk are required.</p>
        <div class="form-grid">
          <div class="field"><label for="report-category">Waste category *</label><select id="report-category" name="category" required><option value="">Choose a category</option>${['Overflowing bin','Roadside litter','Illegal dumping','Plastic waste','Electronic waste','Construction debris','Organic waste','Other'].map(c=>`<option>${c}</option>`).join('')}</select></div>
          <div class="field"><label for="report-area">Neighbourhood / area *</label><input id="report-area" name="area" required maxlength="100" placeholder="e.g. Lake Town, Block B" value="${escapeHtml(currentUser.area||'')}"></div>
          <div class="field field-full"><label for="report-description">Describe the problem *</label><textarea id="report-description" name="description" minlength="10" maxlength="1200" required placeholder="Describe what you observed, how much waste is present and any nearby landmark…"></textarea><span class="field-hint">10–1,200 characters. Avoid including personal or sensitive information.</span></div>
          <div class="field field-full"><label for="report-address">Nearby landmark (optional)</label><input id="report-address" name="address" maxlength="180" placeholder="e.g. Opposite the community market"></div>
          <div class="field field-full"><label>Photograph (optional)</label><label class="upload-box" for="report-image"><span style="font-size:24px">⇧</span><strong>Choose a photo of the waste issue</strong><span>JPG, PNG or WEBP · Maximum 8 MB</span><input id="report-image" name="image" type="file" accept="image/png,image/jpeg,image/webp"><img id="report-preview" class="upload-preview hidden" alt="Selected report photograph"></label></div>
          <div class="field field-full"><label>Selected coordinates *</label><input id="report-coordinates" readonly placeholder="Click on the map or use your current location"><span class="field-hint">Choose the location as accurately as possible. The map point is required.</span></div>
        </div>
        <div class="notice-box"><b>Before you submit</b>Only submit genuine waste-related issues. The report location is shared with authorised administrators and assigned collection staff to support resolution.</div>
        <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:18px"><button class="btn btn-outline" type="button" id="report-cancel">Cancel</button><button class="btn btn-primary" type="submit">Submit report <span>→</span></button></div>
      </section>
      <aside class="card map-card"><div class="map-card-head"><b>Pinpoint the issue location</b><p>Click directly on the map to place the report marker.</p><div class="map-tools"><button class="btn btn-secondary btn-small" type="button" id="use-location">◎ Use my location</button><button class="btn btn-outline btn-small" type="button" id="clear-location">Clear pin</button></div></div><div id="report-map" class="map-container"></div><div class="map-instruction">Map data © OpenStreetMap contributors. Location permission is optional; manual selection is available.</div></aside>
    </form>`;
  $('#report-cancel').addEventListener('click',()=>navigate('dashboard'));
  $('#report-image').addEventListener('change',previewReportImage);
  $('#report-form').addEventListener('submit',submitReport);
  const map = createMap('report-map');
  if (map) map.on('click', e=>setSelectedLocation(e.latlng.lat,e.latlng.lng));
  $('#use-location').addEventListener('click',useCurrentLocation);
  $('#clear-location').addEventListener('click',()=>{selectedLocation=null;$('#report-coordinates').value='';if(window.reportMarker){window.reportMarker.remove();window.reportMarker=null;}showToast('Map pin cleared.','info');});
}
function setSelectedLocation(lat,lng) {
  selectedLocation={latitude:Number(lat),longitude:Number(lng)};
  $('#report-coordinates').value=`${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
  if (window.reportMarker) window.reportMarker.remove();
  if (currentMap) {
    window.reportMarker=L.marker([lat,lng]).addTo(currentMap).bindPopup('Selected waste issue location').openPopup();
    currentMap.panTo([lat,lng]);
  }
}
function useCurrentLocation() {
  if (!navigator.geolocation) {showToast('This browser does not support location access.','error');return;}
  $('#use-location').disabled=true;
  navigator.geolocation.getCurrentPosition(pos=>{
    setSelectedLocation(pos.coords.latitude,pos.coords.longitude);
    if(currentMap) currentMap.setZoom(16);
    $('#use-location').disabled=false;
    showToast('Your current location has been selected.');
  },err=>{
    $('#use-location').disabled=false;
    showToast(err.code===1?'Location permission was denied. Select a point on the map instead.':'Could not determine your location. Select a point on the map instead.','error');
  },{enableHighAccuracy:true,timeout:10000,maximumAge:30000});
}
function previewReportImage(event) {
  const file=event.target.files[0];const img=$('#report-preview');
  if(!file){img.classList.add('hidden');return;}
  if(file.size>8*1024*1024){event.target.value='';showToast('Image must be 8 MB or smaller.','error');return;}
  img.src=URL.createObjectURL(file);img.classList.remove('hidden');
}
async function submitReport(event) {
  event.preventDefault();
  if(!selectedLocation){showToast('Select the waste issue location on the map.','error');return;}
  const form=$('#report-form');const fd=new FormData(form);
  fd.set('latitude',selectedLocation.latitude);fd.set('longitude',selectedLocation.longitude);
  const submit=$('button[type="submit"]',form);submit.disabled=true;submit.textContent='Submitting…';
  try {
    const result=await api('/complaints',{method:'POST',body:fd});
    showToast(`Report submitted. Reference: ${result.public_id}`);
    await showSuccessReference(result.public_id);
  } catch(e){showToast(e.message,'error');submit.disabled=false;submit.innerHTML='Submit report →';}
}
async function showSuccessReference(publicId) {
  $('#detail-content').innerHTML=`<div class="detail-head"><div><span class="eyebrow eyebrow-green">REPORT RECEIVED</span><h2 id="detail-title">Your report has been submitted</h2></div><button class="close-modal" id="close-detail">×</button></div><div class="detail-body"><div style="text-align:center;padding:20px 8px"><div class="stat-icon icon-green" style="width:58px;height:58px;font-size:25px;margin:auto">✓</div><h2 style="font-family:Manrope;font-size:25px;margin:16px 0 5px">${escapeHtml(publicId)}</h2><p class="muted">Keep this reference to identify your report.</p>${statusPill('Submitted')}<div class="notice-box" style="text-align:left;margin-top:22px"><b>What happens next?</b>An administrator will review your report. You can follow its status from My complaints. Collection work is not considered complete until evidence has been verified.</div><button class="btn btn-primary btn-full" style="margin-top:18px" id="success-view">View my complaints</button></div></div>`;
  $('#detail-modal').classList.remove('hidden');
  $('#close-detail').onclick=closeDetail;
  $('#success-view').onclick=()=>{closeDetail();navigate('complaints');};
}
async function renderComplaintsPage() {
  const content=$('#page-content');
  content.innerHTML=`${pageHeading(currentUser.role==='resident'?'RESIDENT SPACE':'OPERATIONS',currentUser.role==='resident'?'My complaints':'Complaint inbox','Search, filter and open a report to see its full lifecycle.',currentUser.role==='resident'?'<button class="btn btn-primary" data-go="report">＋ New report</button>':'')}
    <section class="card table-card"><div class="card-header"><div><div class="card-title">${currentUser.role==='resident'?'Your report history':'All waste reports'}</div><div class="card-subtitle">Select a report to inspect details, history and available actions.</div></div><span id="results-count" class="demo-pill">Loading…</span></div>
      <div class="toolbar"><div class="search-box"><input id="complaint-search" placeholder="Search reference, category or area…"></div><select id="status-filter"><option value="">All statuses</option>${['Submitted','Under Review','Needs Information','Accepted','Assigned','In Progress','Resolved – Pending Verification','Closed','Rejected','Duplicate','Reopened'].map(s=>`<option>${s}</option>`).join('')}</select><select id="category-filter"><option value="">All categories</option>${['Overflowing bin','Roadside litter','Illegal dumping','Plastic waste','Electronic waste','Construction debris','Organic waste','Other'].map(s=>`<option>${s}</option>`).join('')}</select></div>
      <div id="complaints-table">${'<div class="empty-state">Loading complaints…</div>'}</div></section>`;
  bindGoButtons();
  $('#complaint-search').addEventListener('input',debounce(applyComplaintFilters,250));
  $('#status-filter').addEventListener('change',applyComplaintFilters);
  $('#category-filter').addEventListener('change',applyComplaintFilters);
  await applyComplaintFilters();
}
let filterTimer;
function debounce(fn,wait){return (...args)=>{clearTimeout(filterTimer);filterTimer=setTimeout(()=>fn(...args),wait);};}
async function applyComplaintFilters() {
  try {
    const filters={q:$('#complaint-search')?.value||'',status:$('#status-filter')?.value||'',category:$('#category-filter')?.value||''};
    const items=await loadComplaints(filters);
    $('#results-count').textContent=`${items.length} reports`;
    $('#complaints-table').innerHTML=renderTable(items);
    bindComplaintButtons($('#complaints-table'));
  } catch(e){$('#complaints-table').innerHTML=`<div class="empty-state">${escapeHtml(e.message)}</div>`;}
}
async function renderMapPage() {
  const content=$('#page-content');
  content.innerHTML=`${pageHeading('GEOGRAPHIC INTELLIGENCE','Reported issue map','Explore where waste issues are being reported. Map markers represent reports, not verified waste measurements.')}
    <div class="map-legend"><span class="legend-item"><i class="legend-dot" style="background:#d45b51"></i>High / critical</span><span class="legend-item"><i class="legend-dot" style="background:#d39a37"></i>Medium / low</span><span class="legend-item"><i class="legend-dot" style="background:#4b9a70"></i>Closed</span></div>
    <div class="map-page-grid"><section class="card" style="overflow:hidden"><div id="all-complaints-map" class="map-large"></div></section><aside class="card map-side-list"><h3>Mapped reports <span id="map-count" class="muted"></span></h3><div id="map-side-items"><div class="muted">Loading…</div></div></aside></div>`;
  const complaints=await loadComplaints();
  $('#map-count').textContent=`(${complaints.length})`;
  $('#map-side-items').innerHTML=complaints.slice(0,12).map(c=>`<div class="activity-item"><span class="activity-dot" style="background:${c.status==='Closed'?'#4b9a70':c.priority==='High'||c.priority==='Critical'?'#d45b51':'#d39a37'}"></span><div><b>${escapeHtml(c.public_id)} · ${escapeHtml(c.category)}</b><p>${escapeHtml(c.area)} · ${escapeHtml(c.status)}</p><button class="text-button" data-open-complaint="${c.id}">Open report →</button></div></div>`).join('')||'<p class="muted">No report locations available.</p>';
  const map=createMap('all-complaints-map',[22.60,88.405],12);
  if(map){complaints.forEach(c=>addComplaintMarker(map,c));if(complaints.length){const bounds=complaints.map(c=>[Number(c.latitude),Number(c.longitude)]).filter(x=>Number.isFinite(x[0])&&Number.isFinite(x[1]));if(bounds.length>1)map.fitBounds(bounds,{padding:[35,35],maxZoom:14});}}
  bindComplaintButtons(content);
}
async function renderTeamsPage() {
  const content=$('#page-content');
  content.innerHTML=`${pageHeading('PEOPLE & CAPACITY','Collection teams','View field-team members and their current workload.')}
    <div id="team-cards" class="content-grid"><div class="empty-state">Loading team members…</div></div>`;
  try {
    const [teams,complaints]=await Promise.all([api('/teams'),loadComplaints()]);
    $('#team-cards').innerHTML=teams.teams.map(team=>{
      const assigned=complaints.filter(c=>c.assigned_to===team.id&&!['Closed','Rejected','Duplicate'].includes(c.status));
      const done=complaints.filter(c=>c.assigned_to===team.id&&c.status==='Closed').length;
      return `<div class="card" style="padding:19px"><div style="display:flex;align-items:center;gap:12px"><span class="avatar avatar-amber">${escapeHtml(team.name.charAt(0))}</span><div><b style="font-size:12px">${escapeHtml(team.name)}</b><div class="muted" style="font-size:10px;margin-top:3px">${escapeHtml(team.area)} · Field team</div></div></div><div class="mini-metric" style="margin-top:16px"><span>Active assignments</span><b>${assigned.length}</b></div><div class="mini-metric"><span>Verified completed</span><b>${done}</b></div><div class="mini-metric"><span>Contact</span><b>${escapeHtml(team.email)}</b></div><div class="notice-box">${assigned.length?'Team has active work assigned.':'No active assignment at this time.'}</div></div>`;
    }).join('');
  }catch(e){$('#team-cards').innerHTML=`<div class="empty-state">${escapeHtml(e.message)}</div>`;}
}
async function renderTasksPage() {
  const content=$('#page-content');
  content.innerHTML=`${pageHeading('FIELD OPERATIONS','Assigned tasks','Work assigned to your collection team. Start a task, complete the cleanup and submit evidence.')}
    <div id="task-list"><div class="empty-state">Loading assigned tasks…</div></div>`;
  try {
    const complaints=await loadComplaints();
    const open=complaints.filter(c=>!['Closed','Rejected','Duplicate'].includes(c.status));
    const closed=complaints.filter(c=>c.status==='Closed');
    $('#task-list').innerHTML=`<div class="stat-grid" style="margin-bottom:17px">${statCard('Open tasks',open.length,'Assigned or active','▣','icon-blue')}${statCard('In progress',open.filter(c=>c.status==='In Progress').length,'Work started','↗','icon-amber')}${statCard('Awaiting verification',open.filter(c=>c.status==='Resolved – Pending Verification').length,'Submitted evidence','✓','icon-green')}${statCard('Completed',closed.length,'Verified and closed','♧','icon-green')}</div><div>${open.map(taskCard).join('')||'<div class="card empty-state"><div class="empty-icon">✓</div><b>No active tasks</b><p>New assignments will appear here.</p></div>'}</div>${closed.length?`<section class="card table-card" style="margin-top:18px"><div class="card-header"><div><div class="card-title">Completed work</div><div class="card-subtitle">Previously verified tasks</div></div></div>${renderTable(closed)}</section>`:''}`;
    bindTaskButtons(content);bindComplaintButtons(content);
  }catch(e){$('#task-list').innerHTML=`<div class="empty-state">${escapeHtml(e.message)}</div>`;}
}
async function openComplaint(id) {
  try {
    const result=await api(`/complaints/${id}`);const c=result.complaint;
    const canAdmin=currentUser.role==='admin';const isResident=currentUser.role==='resident';const isWorker=currentUser.role==='worker';
    let actions='';
    if(canAdmin){
      if(['Submitted','Under Review','Needs Information','Reopened'].includes(c.status)){
        actions+=`<div class="detail-actions"><button class="btn btn-secondary btn-small" data-review="start_review">Start review</button><button class="btn btn-primary btn-small" data-review="accept">Accept report</button><button class="btn btn-outline btn-small" data-review="needs_info">Request information</button><button class="btn btn-danger btn-small" data-review="reject">Reject report</button></div>`;
      }
      actions+=`<div class="detail-actions"><div class="field"><label>Priority</label><select id="detail-priority">${['Low','Medium','High','Critical'].map(p=>`<option ${c.priority===p?'selected':''}>${p}</option>`).join('')}</select></div><button class="btn btn-outline btn-small" id="save-priority" style="align-self:end">Save priority</button></div>`;
      if(['Accepted','Assigned','Reopened','In Progress'].includes(c.status)){
        const teams=await api('/teams');
        actions+=`<div class="detail-actions"><div class="field"><label>Assign collection team</label><select id="assign-worker"><option value="">Choose team member</option>${teams.teams.map(t=>`<option value="${t.id}" ${c.assigned_to===t.id?'selected':''}>${escapeHtml(t.name)} · ${escapeHtml(t.area)}</option>`).join('')}</select></div><button class="btn btn-primary btn-small" id="assign-task" style="align-self:end">Assign / reassign</button></div>`;
      }
      if(c.status==='Resolved – Pending Verification'){
        actions+=`<div class="detail-actions"><button class="btn btn-primary btn-small" data-verify="verify">✓ Verify and close</button><button class="btn btn-danger btn-small" data-verify="return">Return for rework</button></div>`;
      }
    }
    if(isWorker && c.assigned_to===currentUser.id){
      if(c.status==='Assigned')actions+=`<div class="detail-actions"><button class="btn btn-primary btn-small" id="worker-start">Start this task</button></div>`;
      if(c.status==='In Progress')actions+=`<div class="detail-actions" style="display:block"><b style="font-size:11px">Submit completion evidence</b><form id="complete-work-form" class="inline-form" enctype="multipart/form-data"><input type="file" name="after_image" id="after-image" accept="image/png,image/jpeg,image/webp" required><input type="text" name="note" id="completion-note" placeholder="What work was completed?" minlength="5" required style="flex:1;min-width:180px"><button class="btn btn-primary btn-small" type="submit">Submit for verification</button></form><p class="work-note">An after-cleaning photograph is required. The administrator verifies the work before the complaint is closed.</p></div>`;
    }
    if(isResident && c.status==='Needs Information'){
      actions+=`<div class="detail-actions" style="display:block"><b style="font-size:11px">Additional information requested</b><textarea id="resident-extra-info" placeholder="Provide the requested details…" style="width:100%;min-height:75px;padding:9px;border:1px solid #e1e9e3;border-radius:8px;font-size:11px;margin-top:8px"></textarea><button class="btn btn-primary btn-small" id="send-extra-info" style="margin-top:8px">Send information</button></div>`;
    }
    if(isResident && c.status==='Closed'){
      actions+=`<div class="detail-actions" style="display:block"><b style="font-size:11px">How was the issue resolved?</b><div class="rating-row" style="margin:10px 0">${[1,2,3,4,5].map(n=>`<button data-rating="${n}" class="${n===selectedRating?'selected':''}" type="button">★ ${n}</button>`).join('')}</div><input id="feedback-comment" placeholder="Optional feedback" style="width:100%;padding:9px;border:1px solid #e1e9e3;border-radius:8px;font-size:11px"><button class="btn btn-primary btn-small" id="send-feedback" style="margin-top:9px">Submit feedback</button><button class="btn btn-outline btn-small" id="reopen-report" style="margin:9px 0 0 6px">Request reopening</button></div>`;
    }
    const timeline=c.events.map(ev=>`<div class="timeline-item"><b>${escapeHtml(ev.action)}</b><p>${escapeHtml(ev.note||'No additional note')}${ev.actor_name?` · ${escapeHtml(ev.actor_name)}`:''}</p><time>${escapeHtml(dateLong(ev.created_at))}</time></div>`).join('');
    $('#detail-content').innerHTML=`<div class="detail-head"><div><span class="eyebrow eyebrow-green">COMPLAINT RECORD</span><h2 id="detail-title">${escapeHtml(c.public_id)}</h2><div style="display:flex;gap:7px;align-items:center;margin-top:8px">${statusPill(c.status)}${priorityPill(c.priority)}</div></div><button class="close-modal" id="close-detail" aria-label="Close">×</button></div>
      <div class="detail-body"><div class="detail-grid"><div class="detail-field"><span>Waste category</span><b>${escapeHtml(c.category)}</b></div><div class="detail-field"><span>Reported by</span><b>${escapeHtml(c.resident_name)}</b></div><div class="detail-field"><span>Neighbourhood</span><b>${escapeHtml(c.area)}</b></div><div class="detail-field"><span>Submitted</span><b>${escapeHtml(dateLong(c.created_at))}</b></div><div class="detail-field"><span>Assigned collection team</span><b>${escapeHtml(c.worker_name||'Not assigned')}</b></div><div class="detail-field"><span>Location coordinates</span><b>${Number(c.latitude).toFixed(5)}, ${Number(c.longitude).toFixed(5)}</b></div></div>
      <b style="font-size:11px">Resident description</b><p class="detail-description">${escapeHtml(c.description)}</p>${c.address?`<p class="muted" style="font-size:10px">Landmark: ${escapeHtml(c.address)}</p>`:''}
      ${c.image_before_url?`<div><b style="font-size:11px">Submitted photograph</b><br><img class="detail-image" src="${escapeHtml(c.image_before_url)}" alt="Reported waste issue"></div>`:''}
      ${c.image_after_url?`<div><b style="font-size:11px">Completion evidence</b><br><img class="detail-image" src="${escapeHtml(c.image_after_url)}" alt="After-cleaning evidence"><p class="work-note">${escapeHtml(c.completion_note||'')}</p></div>`:''}
      ${c.rejection_reason?`<div class="rejected-note"><b>Reason recorded:</b> ${escapeHtml(c.rejection_reason)}</div>`:''}
      ${canAdmin?`<div class="detail-actions"><button class="btn btn-outline btn-small" id="check-similar">Check nearby similar reports</button><span id="similar-results" class="work-note"></span></div>`:''}
      <div style="margin-top:20px"><b style="font-size:12px">Complaint history</b><div class="timeline">${timeline||'<p class="muted">No history available.</p>'}</div></div>${actions}</div>`;
    $('#detail-modal').classList.remove('hidden');
    $('#close-detail').onclick=closeDetail;
    if(canAdmin){
      $$('[data-review]').forEach(btn=>btn.addEventListener('click',()=>adminReview(id,btn.dataset.review)));
      $('#save-priority')?.addEventListener('click',async()=>{try{await api(`/complaints/${id}/priority`,{method:'POST',body:JSON.stringify({priority:$('#detail-priority').value})});showToast('Priority updated.');await openComplaint(id);refreshCurrentPage();}catch(e){showToast(e.message,'error');}});
      $('#assign-task')?.addEventListener('click',async()=>{try{const workerId=$('#assign-worker').value;if(!workerId)throw new Error('Choose a collection team member.');await api(`/complaints/${id}/assign`,{method:'POST',body:JSON.stringify({worker_id:workerId})});showToast('Collection team assigned.');await openComplaint(id);refreshCurrentPage();}catch(e){showToast(e.message,'error');}});
      $$('[data-verify]').forEach(btn=>btn.addEventListener('click',()=>adminVerify(id,btn.dataset.verify)));
      $('#check-similar')?.addEventListener('click',async()=>{try{const r=await api(`/complaints/${id}/similar`);$('#similar-results').innerHTML=r.matches.length?`<div style="margin-top:10px;width:100%"><b style="font-size:10px">Possible nearby matches</b>${r.matches.map(x=>`<div class="mini-metric"><span>${escapeHtml(x.public_id)} · ${x.approx_distance_m}m</span><button class="btn btn-outline btn-small" data-mark-duplicate="${x.id}">Link as duplicate</button></div>`).join('')}</div>`:'No nearby same-category reports found.';$$('[data-mark-duplicate]').forEach(btn=>btn.addEventListener('click',async()=>{if(!confirm('Link this report as a duplicate of the selected existing complaint?'))return;try{await api(`/complaints/${id}/duplicate`,{method:'POST',body:JSON.stringify({canonical_id:Number(btn.dataset.markDuplicate)})});showToast('Report linked as a duplicate.');await openComplaint(id);refreshCurrentPage();}catch(e){showToast(e.message,'error');}}));}catch(e){showToast(e.message,'error');}});
    }
    if(isWorker && c.assigned_to===currentUser.id){
      $('#worker-start')?.addEventListener('click',async()=>{try{await api(`/complaints/${id}/work`,{method:'POST',body:JSON.stringify({action:'start',note:'Field work started'})});showToast('Task started.');await openComplaint(id);refreshCurrentPage();}catch(e){showToast(e.message,'error');}});
      $('#complete-work-form')?.addEventListener('submit',async ev=>{ev.preventDefault();const fd=new FormData(ev.target);fd.set('action','complete');try{await api(`/complaints/${id}/work`,{method:'POST',body:fd});showToast('Completion evidence submitted for verification.');await openComplaint(id);refreshCurrentPage();}catch(e){showToast(e.message,'error');}});
    }
    if(isResident && c.status==='Needs Information'){
      $('#send-extra-info')?.addEventListener('click',async()=>{try{await api(`/complaints/${id}/information`,{method:'POST',body:JSON.stringify({note:$('#resident-extra-info').value})});showToast('Additional information sent to the administrator.');await openComplaint(id);refreshCurrentPage();}catch(e){showToast(e.message,'error');}});
    }
    if(isResident && c.status==='Closed'){
      $$('[data-rating]').forEach(btn=>btn.addEventListener('click',()=>{selectedRating=Number(btn.dataset.rating);$$('[data-rating]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.rating)===selectedRating));}));
      $('#send-feedback')?.addEventListener('click',async()=>{try{await api(`/complaints/${id}/feedback`,{method:'POST',body:JSON.stringify({rating:selectedRating,comment:$('#feedback-comment').value})});showToast('Thank you for your feedback.');await openComplaint(id);}catch(e){showToast(e.message,'error');}});
      $('#reopen-report')?.addEventListener('click',async()=>{const note=prompt('Why does this issue need another inspection?');if(note===null)return;try{await api(`/complaints/${id}/reopen`,{method:'POST',body:JSON.stringify({note})});showToast('Reopening request submitted.');await openComplaint(id);refreshCurrentPage();}catch(e){showToast(e.message,'error');}});
    }
  } catch(e){showToast(e.message,'error');}
}
function closeDetail() {$('#detail-modal').classList.add('hidden');}
async function adminReview(id,action) {
  let reason='';
  if(action==='reject'||action==='needs_info'){reason=prompt(action==='reject'?'Provide a reason for rejecting this report:':'What information is needed from the resident?')||'';if(reason.trim().length<5){showToast('Please provide a clear note of at least 5 characters.','error');return;}}
  try{await api(`/complaints/${id}/review`,{method:'POST',body:JSON.stringify({action,reason,note:reason})});showToast(action==='accept'?'Complaint accepted.':action==='reject'?'Complaint rejected with a reason.':'Information requested from resident.');await openComplaint(id);refreshCurrentPage();}
  catch(e){showToast(e.message,'error');}
}
async function adminVerify(id,action) {
  let note='';if(action==='return'){note=prompt('Explain what needs to be corrected:')||'';if(note.trim().length<5){showToast('Provide a clear rework instruction.','error');return;}}
  try{await api(`/complaints/${id}/verify`,{method:'POST',body:JSON.stringify({action,note})});showToast(action==='verify'?'Resolution verified and complaint closed.':'Task returned to the field team.');await openComplaint(id);refreshCurrentPage();}
  catch(e){showToast(e.message,'error');}
}
function refreshCurrentPage(){setTimeout(()=>{if(activePage==='dashboard')renderDashboard();else if(activePage==='complaints')applyComplaintFilters();else if(activePage==='tasks')renderTasksPage();else if(activePage==='map')renderMapPage();else if(activePage==='teams')renderTeamsPage();},250);}
async function loadNotifications(){try{const d=await api('/notifications');const unread=d.notifications.some(n=>!n.is_read);$('#notification-dot').classList.toggle('hidden',!unread);}catch{}}
async function refreshNotificationDot(){await loadNotifications();}
async function toggleNotifications(){
  const pop=$('#notification-popover');
  if(!pop.classList.contains('hidden')){pop.classList.add('hidden');return;}
  try{const d=await api('/notifications');pop.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center"><h3>Notifications</h3><button class="text-button" id="mark-read">Mark all read</button></div>${d.notifications.length?d.notifications.map(n=>`<div class="notification-item ${n.is_read?'':'unread'}"><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.message)}</p><time>${escapeHtml(dateShort(n.created_at))}</time></div>`).join(''):'<p class="muted" style="font-size:11px;padding:10px 3px">You are all caught up.</p>'}`;
    pop.classList.remove('hidden');$('#mark-read')?.addEventListener('click',async()=>{await api('/notifications/read',{method:'POST',body:JSON.stringify({})});pop.classList.add('hidden');loadNotifications();showToast('Notifications marked as read.');});
  }catch(e){showToast(e.message,'error');}
}

$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();$('#login-error').textContent='';
  try{const d=await api('/login',{method:'POST',body:JSON.stringify({email:$('#login-email').value,password:$('#login-password').value})});setUser(d.user,d.csrf_token);}
  catch(e){$('#login-error').textContent=e.message;}
});
$$('[data-demo]').forEach(btn=>btn.addEventListener('click',()=>{
  const email=btn.dataset.demo==='resident'?'resident@cleantrack.demo':btn.dataset.demo==='admin'?'admin@cleantrack.demo':'worker@cleantrack.demo';
  $('#login-email').value=email;$('#login-password').value='demo123';$('#login-form').requestSubmit();
}));
$('#logout-button').addEventListener('click',async()=>{try{await api('/logout',{method:'POST',body:JSON.stringify({})});}catch{}currentUser=null;csrfToken=null;$('#app-shell').classList.add('hidden');$('#login-screen').classList.add('hidden');$('#landing-page')?.classList.remove('hidden');window.scrollTo({top:0,behavior:'smooth'});});
$('#notification-button').addEventListener('click',toggleNotifications);
$('#mobile-menu').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$('#detail-modal').addEventListener('click',event=>{if(event.target.id==='detail-modal')closeDetail();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDetail();$('#notification-popover').classList.add('hidden');$('#sidebar').classList.remove('open');}});
document.addEventListener('click',event=>{if(!event.target.closest('#notification-popover')&&!event.target.closest('#notification-button'))$('#notification-popover').classList.add('hidden');});

(async function bootstrap(){
  try{const d=await api('/session');if(d.user)setUser(d.user,d.csrf_token);}
  catch(e){console.error('Session bootstrap failed',e);}
})();


/* Public CleanTrack landing page interactions. No backend changes are required. */
(() => {
  const landing = document.getElementById('landing-page');
  if (!landing) return;

  const loginScreen = document.getElementById('login-screen');
  const openLogin = () => {
    loginScreen?.classList.remove('hidden');
    document.body.classList.add('auth-open');
    window.CleanTrackIntro?.open?.();
  };
  const closeLogin = () => {
    window.CleanTrackIntro?.close?.();
    loginScreen?.classList.add('hidden');
    document.body.classList.remove('auth-open');
  };

  document.querySelectorAll('[data-open-login]').forEach(button => button.addEventListener('click', openLogin));
  document.getElementById('close-login')?.addEventListener('click', closeLogin);
  loginScreen?.addEventListener('click', event => {
    if (event.target === loginScreen) closeLogin();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && loginScreen && !loginScreen.classList.contains('hidden')) closeLogin();
  });

  const menuButton = document.getElementById('site-menu-toggle');
  const siteNav = document.getElementById('site-nav');
  menuButton?.addEventListener('click', () => {
    const open = siteNav.classList.toggle('is-open');
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.textContent = open ? '×' : '☰';
  });
  siteNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
    siteNav.classList.remove('is-open');
    menuButton?.setAttribute('aria-expanded', 'false');
    if (menuButton) menuButton.textContent = '☰';
  }));

  // Reveal page sections as they enter the viewport.
  const revealItems = [...document.querySelectorAll('.reveal-item')];
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.13, rootMargin: '0px 0px -35px 0px' });
    revealItems.forEach(item => observer.observe(item));
  } else {
    revealItems.forEach(item => item.classList.add('is-visible'));
  }

  // Capability spotlight: advances one capability at a time, with manual controls.
  const slides = [
    {
      title: 'Make reporting simple and useful.',
      description: 'Residents can submit a clear report with a category, description, photograph and map location. A unique reference makes the issue easy to follow.',
      points: ['Structured issue categories', 'Photo evidence and location pin', 'Unique complaint reference'],
      icon: '✎', category: 'Overflowing bin', descriptionField: 'Waste is spilling outside the collection point.',
      status: 'DRAFT', cardTitle: 'New waste report', visual: 'report'
    },
    {
      title: 'See every issue in its place.',
      description: 'Location-aware reports help administrators understand where issues are being raised, filter the map and identify neighbourhoods that may need attention.',
      points: ['Interactive map markers', 'Filter by category and status', 'Area-wise reported-issue patterns'],
      icon: '⌖', category: 'Ward 04 · North block', descriptionField: 'A report is linked to a specific map location.',
      status: 'MAPPED', cardTitle: 'Location intelligence', visual: 'map'
    },
    {
      title: 'Turn accepted reports into assigned work.',
      description: 'Administrators can prioritise validated reports and assign them to a collection team. Field workers see task details, location and the next required action.',
      points: ['Priority and team assignment', 'Mobile-friendly task view', 'Progress recorded against the report'],
      icon: '↗', category: 'Assigned to field team', descriptionField: 'Work owner and task status are visible.',
      status: 'ASSIGNED', cardTitle: 'Team coordination', visual: 'team'
    },
    {
      title: 'Close the loop with evidence.',
      description: 'A field team submits completion notes and an after-cleaning photograph. An administrator verifies the evidence before the complaint can be closed.',
      points: ['Before-and-after evidence', 'Administrator verification', 'A complete status timeline'],
      icon: '✓', category: 'Awaiting verification', descriptionField: 'Completion is reviewed before closure.',
      status: 'CHECK', cardTitle: 'Verified resolution', visual: 'verify'
    },
    {
      title: 'Use operational records to improve response.',
      description: 'Dashboard summaries show complaint volumes, categories, overdue work, area patterns and resolution performance using the records already in the system.',
      points: ['Database-driven dashboard metrics', 'Overdue and reopened work visibility', 'Category and area-level summaries'],
      icon: '▥', category: 'Operations overview', descriptionField: 'Insights are based on stored complaint records.',
      status: 'INSIGHT', cardTitle: 'Operational insight', visual: 'insight'
    }
  ];
  let activeFeature = 0;
  let featureTimer = null;
  let featurePaused = false;
  const featurePanel = document.getElementById('feature-copy');
  const featureTabs = [...document.querySelectorAll('.feature-tab')];
  const progressFill = document.getElementById('feature-progress-fill');
  const pauseButton = document.getElementById('feature-pause');

  function renderFeatureVisual(item) {
    const visual = document.getElementById('feature-visual');
    visual.dataset.visual = item.visual;
    visual.setAttribute('aria-label', `${item.cardTitle} visual preview`);
    const sharedHead = `<div class="demo-panel-head"><span class="demo-app-mark">✳</span><b>${item.cardTitle}</b><span class="demo-live-tag">${item.status}</span></div>`;
    const views = {
      report: `<div class="feature-demo-card report-demo">${sharedHead}<div class="demo-field"><small>ISSUE CATEGORY</small><b>${item.category}</b></div><div class="demo-field"><small>DESCRIPTION</small><b>${item.descriptionField}</b></div><div class="demo-proof-row"><span class="demo-proof-icon">▧</span><span><b>Photo evidence attached</b><small>Issue photograph · JPG</small></span><strong>✓</strong></div><div class="demo-proof-row"><span class="demo-proof-icon">⌖</span><span><b>Location selected</b><small>Ward 04 · Map pin captured</small></span></div><div class="demo-action-row"><span>Ready for review</span><b>Submit report →</b></div></div>`,
      map: `<div class="feature-demo-card map-demo">${sharedHead}<div class="map-demo-toolbar"><span>ALL REPORTED ISSUES</span><span>FILTERS&nbsp; ▾</span></div><div class="map-demo-art"><div class="map-demo-road map-demo-road-a"></div><div class="map-demo-road map-demo-road-b"></div><div class="map-demo-road map-demo-road-c"></div><div class="map-demo-zone"></div><i class="map-demo-pin one">1</i><i class="map-demo-pin two">2</i><i class="map-demo-pin three">3</i><i class="map-demo-pin four">4</i></div><div class="map-demo-legend"><span><i></i> Submitted</span><span><i></i> In progress</span><span><i></i> Resolved</span></div><div class="map-demo-foot"><b>${item.category}</b><small>${item.descriptionField}</small></div></div>`,
      team: `<div class="feature-demo-card team-demo">${sharedHead}<div class="team-task-id"><small>TASK REFERENCE</small><b>CT-2026-00124</b><span>HIGH PRIORITY</span></div><div class="team-assignee"><span class="team-avatar">FT</span><span><b>Field team · North Zone</b><small>Assigned collection crew</small></span><span class="team-check">✓</span></div><div class="team-route"><div class="team-route-line"></div><span class="team-route-point">⌖</span><div><b>Ward 04 · Collection point</b><small>Location attached to report</small></div></div><div class="team-progress-head"><b>Work progress</b><span>2 of 3 steps</span></div><div class="team-progress"><i></i></div><div class="team-steps"><span class="done">✓ Report reviewed</span><span class="done">✓ Team assigned</span><span>○ Clean-up pending</span></div></div>`,
      verify: `<div class="feature-demo-card verify-demo">${sharedHead}<div class="verify-banner"><span>✓</span><div><b>Completion submitted</b><small>Awaiting administrator verification</small></div></div><div class="evidence-grid"><div><span class="evidence-image evidence-before">BEFORE</span><small>Initial report photo</small></div><div><span class="evidence-image evidence-after">AFTER</span><small>Field completion photo</small></div></div><div class="verify-checklist"><span><b>✓</b> Completion note received</span><span><b>✓</b> After-cleaning evidence attached</span><span><b>○</b> Administrator review pending</span></div><div class="demo-action-row"><span>Closure is controlled</span><b>Review evidence →</b></div></div>`,
      insight: `<div class="feature-demo-card insight-demo">${sharedHead}<div class="insight-total"><div><small>REPORTS THIS PERIOD</small><b>128</b></div><span>Illustrative data</span></div><div class="insight-chart"><div><i style="height:42%"></i><small>Mon</small></div><div><i style="height:68%"></i><small>Tue</small></div><div><i style="height:53%"></i><small>Wed</small></div><div><i style="height:88%"></i><small>Thu</small></div><div><i style="height:61%"></i><small>Fri</small></div><div><i style="height:75%"></i><small>Sat</small></div><div><i style="height:33%"></i><small>Sun</small></div></div><div class="insight-breakdown"><span>Most reported category <b>Overflowing bins</b></span><span>Open work <b>24 reports</b></span><span>Verified closed <b>86 reports</b></span></div></div>`
    };
    visual.innerHTML = `${views[item.visual] || views.report}<div class="visual-orbit orbit-one"></div><div class="visual-orbit orbit-two"></div>`;
  }

  function renderFeature(index) {
    activeFeature = (index + slides.length) % slides.length;
    const item = slides[activeFeature];
    featurePanel?.classList.remove('feature-copy');
    // Restart the entrance animation after replacing the content.
    if (featurePanel) void featurePanel.offsetWidth;
    featurePanel?.classList.add('feature-copy');
    document.getElementById('feature-index').textContent = `CAPABILITY ${String(activeFeature + 1).padStart(2, '0')} / 05`;
    document.getElementById('feature-icon-large').textContent = item.icon;
    document.getElementById('feature-title').textContent = item.title;
    document.getElementById('feature-description').textContent = item.description;
    document.getElementById('feature-points').innerHTML = item.points.map(point => `<li>${point}</li>`).join('');
    renderFeatureVisual(item);
    featureTabs.forEach((tab, tabIndex) => {
      const selected = tabIndex === activeFeature;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    if (progressFill) progressFill.style.width = `${((activeFeature + 1) / slides.length) * 100}%`;
  }
  function stopFeatureTimer() {
    if (featureTimer) window.clearInterval(featureTimer);
    featureTimer = null;
  }
  function startFeatureTimer() {
    stopFeatureTimer();
    if (featurePaused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    featureTimer = window.setInterval(() => renderFeature(activeFeature + 1), 6200);
  }
  function goToFeature(index) { renderFeature(index); startFeatureTimer(); }
  featureTabs.forEach(tab => tab.addEventListener('click', () => goToFeature(Number(tab.dataset.feature))));
  document.getElementById('feature-prev')?.addEventListener('click', () => goToFeature(activeFeature - 1));
  document.getElementById('feature-next')?.addEventListener('click', () => goToFeature(activeFeature + 1));
  pauseButton?.addEventListener('click', () => {
    featurePaused = !featurePaused;
    pauseButton.textContent = featurePaused ? '▶' : 'Ⅱ';
    pauseButton.setAttribute('aria-label', featurePaused ? 'Resume feature rotation' : 'Pause feature rotation');
    startFeatureTimer();
  });
  document.getElementById('feature-explorer')?.addEventListener('mouseenter', stopFeatureTimer);
  document.getElementById('feature-explorer')?.addEventListener('mouseleave', startFeatureTimer);
  document.addEventListener('visibilitychange', () => document.hidden ? stopFeatureTimer() : startFeatureTimer());
  renderFeature(0);
  startFeatureTimer();
})();
