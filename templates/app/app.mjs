// Customize app-specific behavior here. Shared persistence is provided by the SDK.
import {LocalStore} from './db.mjs';
const $=id=>document.getElementById(id),db=new LocalStore('app-data');
$('app-title').textContent=document.title;
const theme=globalThis.AetherAppInfo?.theme;
for(const [key,token] of Object.entries({primary:'primary',onPrimary:'on-primary',background:'background',surface:'surface',text:'text',line:'line'})){
 if(/^#[a-f0-9]{6}$/i.test(theme?.[key]||''))document.documentElement.style.setProperty('--'+token,theme[key]);
}
let busy=false;
function pending(value,message){busy=value;$('save').disabled=value;$('retry').disabled=value;$('status').textContent=message;}
async function load(){
 pending(true,'Opening saved items…');$('retry').hidden=true;
 try{
  const rows=await db.list('item',{limit:50});$('items').replaceChildren();
  for(const row of rows){const li=document.createElement('li');li.textContent=row.title||row.id;$('items').append(li);}
  $('status').textContent=rows.length?'Showing up to 50 saved items.':'No items yet. Add your first item below.';
 }catch(error){$('status').textContent=error.message;$('retry').hidden=false;}
 finally{busy=false;$('save').disabled=false;$('retry').disabled=false;}
}
$('retry').addEventListener('click',load);
$('add-form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;const title=$('title').value.trim();if(!title)return;
 pending(true,'Saving item…');
 try{await db.put('item',crypto.randomUUID(),{title});$('title').value='';await load();$('title').focus();}
 catch(error){pending(false,error.message);}
});
void load();
