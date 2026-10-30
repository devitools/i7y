(()=>{var LOGO='<img src="/assets/brand.svg" alt="" width="20" height="20">';
var IC={org:"M4 20V6l8-3 8 3v14M9 20v-5h6v5",ws:"M4 5h16v14H4zM8 9h8",srv:"M4 5h16v5H4zM4 14h16v5H4z",prj:"M3 6h7l2 2h9v11H3z",ctr:"M12 3l8 4.5v9L12 21l-8-4.5v-9z",img:"M4 4h16v16H4zM8 14l3-3 5 5",tel:"M3 12h4l3-6 4 12 3-6h4",alr:"M6 17v-6a6 6 0 0 1 12 0v6l2 2H4zM10 21h4",inc:"M12 3l10 18H2zM12 10v5",edt:"M4 20h4l10-10-4-4L4 16z",del:"M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"};
function ic(k,c){return '<svg class="'+(c||"")+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+IC[k]+'"/></svg>'}
function c(v){return v>=90?"crit":v>=70?"warn":"ok"}
function bar(v){return '<div><div class="bar"><i class="'+c(v)+'" style="width:'+v+'%"></i></div><span class="val">'+v+'%</span></div>'}
function vbar(v){return '<div class="vertical-metric"><span class="vertical-track"><i class="'+c(v)+'" style="height:'+v+'%"></i></span><span class="vertical-value">'+v+'%</span></div>'}
function containerBar(count){const [healthy,total]=count.split('/').map(Number);const state=healthy===total?'ok':'warn';return '<div class="vertical-metric"><span class="vertical-track"><i class="'+state+'" style="height:100%"></i></span><span class="vertical-value">'+healthy+' / '+total+'</span></div>'}
var NAV=[["org","Organizations"],["ws","Workspaces"],["srv","Servers"],["prj","Projects"],["ctr","Containers"],["img","Images"],["tel","Telemetry"],["alr","Alerts"],["inc","Incidents"]];
var WS=[["ana@example.com",6],["bruno@example.com",1],["carla@example.com",2],["dev@example.com",12],["ops@example.com",1],["team@example.com",6]];
function shell(on,sel,page){
  return '<div class="tb"><span class="lights"><i></i><i></i><i></i></span><span>EN \u25be</span><span><i class="dot ok"></i> API</span><span class="logo">'+LOGO+'i7y</span><span class="sp"></span><span class="bell">'+ic("alr")+'<b>3</b></span><span class="user">demo@example.com</span></div>'+
  '<div class="body"><div class="side"><div class="org"><small>Organization</small>Mobile Lab A</div><h6>INVENTORY</h6>'+
  NAV.map(function(n){return '<a class="'+(n[1]===on?"on":"")+'">'+ic(n[0])+'<span class="t">'+n[1]+'</span></a>'}).join("")+
  '<h6>YOUR WORKSPACES <span>'+WS.length+'</span></h6><div class="sw"><i></i>Only workspaces with servers</div>'+
  WS.map(function(w,i){return '<a class="'+(i===sel?"on":"")+'">'+ic("srv")+'<span class="t">'+w[0]+'</span><em>'+w[1]+'</em></a>'}).join("")+
  '</div><div class="main">'+page+'</div></div>';
}
var SRCH='<div class="search">Search domain, IP, project or image\u2026</div>';
var SCR={
servers:function(){
  var d=[["alisa.example.com","ana@example.com","192.0.2.11",33,64,52,"4/4"],["beacon.example.com","bruno@example.com","192.0.2.12",28,93,40,"10/11"],["cedar.example.com","carla@example.com","192.0.2.13",41,72,91,"13/15"],["delta.example.com","dev@example.com","192.0.2.14",16,38,29,"3/3"],["echo.example.com","ops@example.com","192.0.2.15",58,44,84,"5/5"]];
  return shell("Servers",2,'<h4>Servers</h4><div class="card2"><div class="tools">'+SRCH+'<span class="b l">Clear all filters</span><span class="b p">+ Create</span><span class="b">Export current page</span></div><div class="tbl"><div class="tr h cs"><span>Server</span><span>IP address</span><span>CPU</span><span>Memory</span><span>Disk</span><span>Containers</span></div>'+
  d.map(function(r){var s=Math.max(r[3],r[4],r[5]);return '<div class="tr cs"><div><b><i class="dot '+c(s)+'"></i> '+r[0]+'</b><br><span class="muted">'+r[1]+'</span></div><span>'+r[2]+'</span>'+vbar(r[3])+vbar(r[4])+vbar(r[5])+containerBar(r[6])+'</div>'}).join("")+'</div></div>');
},
containers:function(){
  var r=[["store-mysql","mysql:5.7"],["store-server","example/php-nginx:7.4"],["store-cache","redis:7"]];
  return shell("Containers",2,'<div class="crumb"><span>\u2190 Workspaces</span><span>\u203a</span><span>carla@example.com</span><span>\u203a</span><span>cedar.example.com</span></div><h4>store</h4><div class="card2"><div class="fl">'+
  [["Server","cedar.example.com"],["Project","store"],["Image","All images"],["Status","Running"]].map(function(f){return '<div class="fld"><small>'+f[0]+'</small>'+f[1]+'</div>'}).join("")+
  '</div><div class="tools">'+SRCH+'<span class="b l">Clear all filters</span><span class="b d">Delete selected (0)</span><span class="b o">Telemetry</span><span class="b p">+ Create</span><span class="b">Export current page</span><span class="b p">Refresh</span></div>'+
  '<div class="tbl"><div class="tr h cc"><i class="cb"></i><span></span><span>State</span><span>Container</span><span>Project</span><span>Image</span><span>Server</span><span>IP address</span></div>'+
  r.map(function(x){return '<div class="tr cc"><i class="cb"></i><span class="acts">'+ic("edt")+ic("del","x")+'</span><span><span class="tag ok">Running</span></span><span>'+x[0]+'</span><div>store<br><span class="muted">/srv/projects/store/app</span></div><span><span class="img">'+x[1]+'</span></span><div>cedar.example.com<br><span class="muted">carla@example.com</span></div><span>192.0.2.13</span></div>'}).join("")+
  '</div><div class="pg">Records per page: 10 \u25be &nbsp;&nbsp; 1\u20133 of 3</div></div>');
},
telemetry:function(){
  var T=[["CPU","41.0%","brand","Host usage"],["Memory","72.0%","warn","2.5 GB available"],["Disk usage","91.0%","crit","Most used filesystem"],["Containers","13 / 15","warn","Healthy"]];
  var sv=function(col,p){return '<svg viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true"><path d="'+p+'" fill="none" stroke="var(--'+col+')" stroke-width="2.5"/></svg>'};
  return shell("Telemetry",2,'<h4>Telemetry</h4><div class="card2"><div class="fl" style="grid-template-columns:2fr 1fr 2fr;margin:0"><div class="fld"><small>Server</small>cedar.example.com</div><div class="fld"><small>History</small>8 hours</div><span></span></div></div>'+
  '<div class="pills" style="margin-top:12px;align-items:center"><b>cedar.example.com</b><span class="muted">192.0.2.13</span><span class="tag ok">Healthy</span><span class="sp"></span><span class="b">Server details</span><span class="b p">Refresh</span></div>'+
  '<div class="tiles">'+T.map(function(t){return '<div><small>'+t[0]+'</small><b style="color:var(--'+t[2]+')">'+t[1]+'</b><small>'+t[3]+'</small></div>'}).join("")+'</div>'+
  '<div class="charts"><div class="ch"><small>CPU, average 29.8%, peak 41.0%</small>'+sv("brand","M0 80 C30 60 50 90 80 70 S130 35 160 62 S220 95 250 55 S280 50 300 60")+'</div><div class="ch"><small>Memory, average 59.6%, peak 72.0%</small>'+sv("ok","M0 52 C60 50 120 44 180 38 S260 30 300 26")+'</div></div>'+
  '<div class="charts telemetry-lower" style="margin-top:12px"><div class="ch"><b>Container health</b><br><small>15 containers</small><div class="health-content"><div class="health-donut"><strong>13</strong><small>Healthy</small></div><div class="health-legend"><span><i class="dot ok"></i> Healthy <b>13</b></span><span><i class="dot warn"></i> Needs attention <b>2</b></span><span><i class="dot neutral"></i> No telemetry <b>0</b></span></div></div></div><div class="ch"><b>Disk usage</b><br><small>Used space by filesystem</small><div class="disk-rows"><div>/ '+bar(72)+'</div><div>/boot '+bar(19)+'</div><div>/home '+bar(43)+'</div></div></div></div>');
},
alerts:function(){
  var a=[["Disk almost full","Disk usage above 90% for 10 min","Primary","crit","Firing"],["Memory pressure","Memory above 85% for 15 min","Primary","warn","Pending"],["Container down","Any container unhealthy","All workspaces","ok","OK"],["High CPU","CPU above 90% for 5 min","All workspaces","ok","OK"]];
  return shell("Alerts",2,'<h4>Alerts</h4><div class="card2"><div class="tools"><div class="search">Search rules\u2026</div><span class="b p">+ Create</span><span class="b p">Refresh</span></div><div class="tbl"><div class="li head"><span>Rule</span><span>Condition</span><span>Scope</span><span>Status</span></div>'+
  a.map(function(r){return '<div class="li"><b>'+r[0]+'</b><span>'+r[1]+'</span><span>'+r[2]+'</span><span class="tag '+r[3]+'">'+r[4]+'</span></div>'}).join("")+'</div></div>');
},
incidents:function(){
  var l=[["Disk almost full","cedar.example.com","crit","Open",1],["Memory pressure","beacon.example.com","warn","Owned",0],["Container down","delta.example.com","ok","Resolved",0]];
  return shell("Incidents",2,'<h4>Incidents</h4><div class="split"><div>'+
  l.map(function(i){return '<div class="inc'+(i[4]?" sel":"")+'"><span class="tag '+i[2]+'" style="float:right">'+i[3]+'</span><b>'+i[0]+'</b><span class="muted">'+i[1]+'</span></div>'}).join("")+
  '</div><div class="detail"><b>Disk almost full</b><br><span class="muted">cedar.example.com, carla@example.com</span><div class="who" style="margin-top:14px"><span class="av">A</span><div><b>Ana took ownership</b><br><span class="muted">Due today, 4:00 PM</span></div></div><ul class="tl"><li>Alert fired at 91.0% disk usage</li><li>Incident opened with server context</li><li>Ana took ownership</li></ul></div></div>');
}};
document.querySelectorAll("[data-screen]").forEach(function(m){m.innerHTML=SCR[m.dataset.screen]()});

const pt=document.documentElement.lang.startsWith('pt');if(pt){const map={'Servers':'Servidores','Server':'Servidor','Organizations':'Organiza\u00e7\u00f5es','Organization':'Organiza\u00e7\u00e3o','Containers':'Cont\u00eaineres','Telemetry':'Telemetria','Alerts':'Alertas','Incidents':'Incidentes','Memory':'Mem\u00f3ria','Disk':'Disco','History':'Hist\u00f3rico','Healthy':'Saud\u00e1vel','Running':'Em execu\u00e7\u00e3o','Open':'Aberto','Resolved':'Resolvido'};document.querySelectorAll('[data-screen]').forEach(el=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const text=n.nodeValue.trim();if(map[text])n.nodeValue=n.nodeValue.replace(text,map[text])}})}document.querySelectorAll('.demo-tabs button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.demo-tabs button').forEach(t=>{const active=t===b;t.setAttribute('aria-pressed',String(active));document.getElementById(t.getAttribute('aria-controls')).hidden=!active})}));})();