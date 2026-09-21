import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';
import './style.css';

const {RenderingEngine,Enums}=cornerstone;
const {MouseBindings,ToolGroupManager,StackScrollMouseWheelTool,PanTool,ZoomTool,WindowLevelTool,addTool}=cornerstoneTools;
const state={files:[],imageIds:[],imageMeta:[],currentIndex:0,renderingEngine:null,viewport:null,cineTimer:null,cinePlaying:false,originalVOI:null,initialized:false};
const $=id=>document.getElementById(id);
const el={viewport:$('viewport'),fileInput:$('fileInput'),folderInput:$('folderInput'),openFilesBtn:$('openFilesBtn'),openFolderBtn:$('openFolderBtn'),dropOverlay:$('dropOverlay'),patientName:$('patientName'),patientId:$('patientId'),studyDescription:$('studyDescription'),modality:$('modality'),studyDate:$('studyDate'),seriesList:$('seriesList'),imageCountBadge:$('imageCountBadge'),statusText:$('statusText'),fileInfo:$('fileInfo'),hudPatient:$('hudPatient'),hudStudy:$('hudStudy'),hudModality:$('hudModality'),hudSlice:$('hudSlice'),windowText:$('windowText'),zoomText:$('zoomText'),sliceSlider:$('sliceSlider'),sliceLabel:$('sliceLabel'),prevBtn:$('prevBtn'),nextBtn:$('nextBtn'),cineBtn:$('cineBtn'),loading:$('loading'),loadingText:$('loadingText')};
const VIEWPORT_ID='DICOM_VIEWPORT',RENDERING_ENGINE_ID='DICOM_RENDERING_ENGINE';
const clean=v=>v==null||v===''?'—':String(v).replaceAll('^',' ').trim()||'—';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function loading(show,text){el.loading.classList.toggle('hidden',!show);if(text)el.loadingText.textContent=text}
const setStatus=t=>el.statusText.textContent=t;

function parseBasic(file,buffer){
  try{
    const bytes=new Uint8Array(buffer);
    const hasP10=bytes.length>=132&&String.fromCharCode(...bytes.slice(128,132))==='DICM';
    const d=dicomParser.parseDicom(bytes,{});
    const g=t=>{try{return d.string(t)||''}catch{return''}};
    const sop=g('x00080018');
    if(!sop&&!hasP10)return null;
    return {patientName:clean(g('x00100010')),patientId:clean(g('x00100020')),studyDescription:clean(g('x00081030')),modality:clean(g('x00080060')),studyDate:clean(g('x00080020')),seriesDescription:clean(g('x0008103e')),seriesNumber:Number(g('x00200011'))||0,instanceNumber:Number(g('x00200013'))||0,seriesInstanceUID:g('x0020000e'),studyInstanceUID:g('x0020000d'),sopInstanceUID:sop,fileName:file.name,relativePath:file.webkitRelativePath||file.name};
  }catch{return null}
}
async function init(){
  if(state.initialized)return;
  await cornerstone.init();cornerstoneTools.init();
  dicomImageLoader.external.cornerstone=cornerstone;dicomImageLoader.external.dicomParser=dicomParser;
  dicomImageLoader.init({maxWebWorkers:Math.max(1,Math.min(4,navigator.hardwareConcurrency||2)),strict:false});
  [WindowLevelTool,PanTool,ZoomTool,StackScrollMouseWheelTool].forEach(addTool);
  state.renderingEngine=new RenderingEngine(RENDERING_ENGINE_ID);
  state.renderingEngine.enableElement({viewportId:VIEWPORT_ID,type:Enums.ViewportType.STACK,element:el.viewport,defaultOptions:{background:[0,0,0]}});
  state.viewport=state.renderingEngine.getViewport(VIEWPORT_ID);
  const tg=ToolGroupManager.createToolGroup('DICOM_TOOL_GROUP');
  [WindowLevelTool,PanTool,ZoomTool,StackScrollMouseWheelTool].forEach(t=>tg.addTool(t.toolName));
  tg.addViewport(VIEWPORT_ID,RENDERING_ENGINE_ID);
  tg.setToolActive(WindowLevelTool.toolName,{bindings:[{mouseButton:MouseBindings.Primary}]});
  tg.setToolActive(PanTool.toolName,{bindings:[{mouseButton:MouseBindings.Auxiliary}]});
  tg.setToolActive(ZoomTool.toolName,{bindings:[{mouseButton:MouseBindings.Secondary}]});
  tg.setToolActive(StackScrollMouseWheelTool.toolName);state.initialized=true;
  addEventListener('resize',()=>{state.renderingEngine?.resize(true,true);state.viewport?.render()});
}
function dedupeAndSort(parsed){
  const seen=new Set();
  return parsed.filter(x=>{const key=x.meta.sopInstanceUID||x.meta.fileName;if(seen.has(key))return false;seen.add(key);return true})
    .sort((a,b)=>String(a.meta.seriesInstanceUID||'').localeCompare(String(b.meta.seriesInstanceUID||''))||(a.meta.seriesNumber||0)-(b.meta.seriesNumber||0)||(a.meta.instanceNumber||0)-(b.meta.instanceNumber||0)||a.meta.fileName.localeCompare(b.meta.fileName));
}
async function loadFiles(list){
  const candidates=[...list].filter(f=>f&&f.size>0);
  if(!candidates.length){setStatus('No se encontraron archivos.');return}
  stopCine();loading(true,'Analizando estudio…');
  try{
    await init();const parsed=[];let skipped=0;
    for(let i=0;i<candidates.length;i++){
      if(i%8===0)loading(true,'Analizando '+(i+1)+' de '+candidates.length+' archivos…');
      const f=candidates[i],meta=parseBasic(f,await f.arrayBuffer());
      if(meta)parsed.push({file:f,meta});else skipped++;
    }
    const usable=dedupeAndSort(parsed);
    if(!usable.length){setStatus('No se encontraron archivos DICOM válidos.');alert('La carpeta no contiene archivos DICOM compatibles.');return}
    state.files=usable.map(x=>x.file);state.imageMeta=usable.map(x=>x.meta);
    state.imageIds=state.files.map(f=>dicomImageLoader.wadouri.fileManager.add(f));state.currentIndex=0;
    updateStudy();updateList();await displayStack();el.dropOverlay.classList.add('hidden');
    setStatus(usable.length+' imagen'+(usable.length===1?'':'es')+' DICOM cargada'+(usable.length===1?'':'s')+(skipped?' · '+skipped+' archivo'+(skipped===1?'':'s')+' omitido'+(skipped===1?'':'s'):'')+'.');
  }catch(e){console.error(e);setStatus('Error al cargar el estudio.');alert('No se pudo cargar el estudio DICOM. Pruebe con otra carpeta o archivo.')}
  finally{loading(false)}
}
async function collectDroppedItems(dataTransfer){
  const out=[];const items=[...(dataTransfer.items||[])];
  async function walk(entry,path=''){
    if(entry.isFile){await new Promise(resolve=>entry.file(f=>{try{Object.defineProperty(f,'webkitRelativePath',{value:path+f.name})}catch{}out.push(f);resolve()}))}
    else if(entry.isDirectory){
      const reader=entry.createReader();
      await new Promise(resolve=>{const read=()=>reader.readEntries(async entries=>{if(!entries.length){resolve();return}for(const child of entries)await walk(child,path+entry.name+'/');read()});read()});
    }
  }
  for(const item of items){const entry=item.webkitGetAsEntry?.();if(entry)await walk(entry);else{const f=item.getAsFile?.();if(f)out.push(f)}}
  return out;
}
async function displayStack(){if(!state.viewport||!state.imageIds.length)return;await state.viewport.setStack(state.imageIds,state.currentIndex);state.viewport.render();state.originalVOI=state.viewport.getProperties().voiRange||null;updateSlice();updateViewport()}
function updateStudy(){
  const m=state.imageMeta[0]||{};el.patientName.textContent=m.patientName||'—';el.patientId.textContent=m.patientId||'—';el.studyDescription.textContent=m.studyDescription||m.seriesDescription||'—';el.modality.textContent=m.modality||'—';el.studyDate.textContent=m.studyDate||'—';
  el.hudPatient.textContent='PACIENTE '+(m.patientName||'—');el.hudStudy.textContent='ESTUDIO '+(m.studyDescription||m.seriesDescription||'—');el.hudModality.textContent=m.modality||'—';
}
function updateList(){
  el.seriesList.innerHTML='';el.imageCountBadge.textContent=state.imageIds.length;
  state.imageMeta.forEach((m,i)=>{const n=document.createElement('div');n.className='series-item '+(i===state.currentIndex?'active':'');n.innerHTML='<div class="thumb">'+String(i+1).padStart(2,'0')+'</div><div><div class="series-name">'+esc(m.seriesDescription||m.fileName)+'</div><div class="series-sub">Imagen '+(i+1)+' · '+esc(m.modality||'DICOM')+'</div></div>';n.onclick=()=>setSlice(i);el.seriesList.appendChild(n)});
}
function updateSlice(){
  const total=state.imageIds.length;el.sliceSlider.max=Math.max(0,total-1);el.sliceSlider.value=state.currentIndex;el.sliceSlider.disabled=total<=1;el.sliceLabel.textContent=(total?state.currentIndex+1:0)+' / '+total;el.hudSlice.textContent=(total?state.currentIndex+1:0)+' / '+total;el.prevBtn.disabled=state.currentIndex<=0;el.nextBtn.disabled=state.currentIndex>=total-1;
  [...el.seriesList.children].forEach((n,i)=>n.classList.toggle('active',i===state.currentIndex));const m=state.imageMeta[state.currentIndex];el.fileInfo.textContent=m?.relativePath||m?.fileName||'Sin estudio cargado';
}
function updateViewport(){if(!state.viewport)return;const p=state.viewport.getProperties(),v=p.voiRange;if(v)el.windowText.textContent=Math.round(v.upper-v.lower)+' / '+Math.round((v.upper+v.lower)/2);const z=state.viewport.getZoom?.();if(typeof z==='number')el.zoomText.textContent=z.toFixed(2)+'×'}
async function setSlice(i){if(!state.imageIds.length)return;state.currentIndex=Math.max(0,Math.min(i,state.imageIds.length-1));await state.viewport.setImageIdIndex(state.currentIndex);state.viewport.render();updateSlice();updateViewport()}
function reset(){if(!state.viewport)return;state.viewport.resetCamera();if(state.originalVOI)state.viewport.setProperties({voiRange:state.originalVOI});state.viewport.setProperties({invert:false});state.viewport.render();updateViewport()}
function invert(){if(!state.viewport)return;state.viewport.setProperties({invert:!state.viewport.getProperties().invert});state.viewport.render()}
function zoom(f){if(!state.viewport)return;state.viewport.setZoom((state.viewport.getZoom?.()||1)*f);state.viewport.render();updateViewport()}
function fit(){if(!state.viewport)return;state.viewport.resetCamera({resetPan:false,resetZoom:true,resetToCenter:true});state.viewport.render();updateViewport()}
function fullscreen(){document.fullscreenElement?document.exitFullscreen():el.viewport.requestFullscreen?.()}
function stopCine(){state.cinePlaying=false;if(state.cineTimer)clearInterval(state.cineTimer);state.cineTimer=null;el.cineBtn.innerHTML='<i>▶</i><span>Cine</span>'}
function cine(){if(state.cinePlaying){stopCine();return}if(state.imageIds.length<2)return;state.cinePlaying=true;el.cineBtn.innerHTML='<i>■</i><span>Detener</span>';state.cineTimer=setInterval(()=>setSlice((state.currentIndex+1)%state.imageIds.length),90)}
el.openFilesBtn.onclick=()=>el.fileInput.click();el.openFolderBtn.onclick=()=>el.folderInput.click();el.fileInput.onchange=e=>loadFiles(e.target.files);el.folderInput.onchange=e=>{loadFiles(e.target.files);e.target.value=''};el.sliceSlider.oninput=e=>setSlice(+e.target.value);el.prevBtn.onclick=()=>setSlice(state.currentIndex-1);el.nextBtn.onclick=()=>setSlice(state.currentIndex+1);el.cineBtn.onclick=cine;
document.querySelectorAll('.toolbar button[data-action]').forEach(b=>{b.onclick=()=>({reset,invert,zoomIn:()=>zoom(1.2),zoomOut:()=>zoom(1/1.2),fit,fullscreen,cine}[b.dataset.action])()});
document.onkeydown=e=>{if(e.target.matches('input'))return;if(e.key==='ArrowLeft')setSlice(state.currentIndex-1);if(e.key==='ArrowRight')setSlice(state.currentIndex+1);if(e.key.toLowerCase()==='r')reset();if(e.key.toLowerCase()==='i')invert();if(e.key.toLowerCase()==='f')fullscreen();if(e.code==='Space'){e.preventDefault();cine()}};
['dragenter','dragover'].forEach(t=>el.viewport.addEventListener(t,e=>{e.preventDefault();el.dropOverlay.classList.remove('hidden')}));el.viewport.addEventListener('drop',async e=>{e.preventDefault();loadFiles(await collectDroppedItems(e.dataTransfer))});
init().catch(e=>{console.error(e);setStatus('No se pudo inicializar el visor.')});
