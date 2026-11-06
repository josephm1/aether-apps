import { hostedRequest } from './hosted-client.mjs';
export async function readResource(path, {sha256, maximum=8*1048576, signal}={}) {
  if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('Resource needs its expected SHA-256.');
  const chunks=[]; let offset=0, total;
  do {
    const part=await hostedRequest('resource.read',{path,offset,limit:262144},signal);
    if (!Number.isSafeInteger(part.total) || part.total < 0 || part.total>maximum || part.offset!==offset || (total!==undefined && total!==part.total)) throw new Error('Resource size changed or exceeds its budget.');
    total=part.total;
    const bytes=Uint8Array.from(atob(part.base64),c=>c.charCodeAt(0));
    if (part.bytes!==bytes.length || offset+bytes.length>total || (!bytes.length && offset<total)) throw new Error('Resource range failed validation.');
    chunks.push(bytes); offset+=bytes.length;
  } while(offset<total);
  const bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(digest!==sha256)throw new Error('Resource checksum changed. Reinstall the matching resource pack.');
  return bytes;
}
