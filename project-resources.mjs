import { relative } from './documents.mjs';
// Read-only sibling of source/data. Never included in source builds or writable
// through the web bridge. The native document service enforces the selected tree.
export async function readProjectResource(project, args, signal) {
  const name = relative(args.path);
  if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid resource path.');
  const offset = args.offset ?? 0, limit = args.limit ?? 262144;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 262144)
    throw new Error('Invalid bounded resource range.');
  const path = project.id + '/resources/' + name;
  const info = await project.io.stat(path, false);
  if (!info.exists || info.directory) throw new Error('Resource is not installed: ' + name);
  if (!Number.isSafeInteger(info.bytes) || info.bytes < 0 || info.bytes > 8 * 1048576 || offset > info.bytes)
    throw new Error('Resource exceeds the 8 MiB read budget.');
  const chunks = []; let at = offset;
  const end = Math.min(info.bytes, offset + limit);
  while (at < end) {
    if (signal?.aborted) throw new Error('Resource read cancelled.');
    const result = await project.io.invoke('read', {path, offset: at, limit: Math.min(65536, end-at)});
    const bytes = Buffer.from(result.base64, 'base64');
    if (!bytes.length || bytes.length > Math.min(65536, end-at)) throw new Error('Resource changed during reading.');
    chunks.push(bytes); at += bytes.length;
  }
  return {base64: Buffer.concat(chunks).toString('base64'), offset, bytes: at-offset, total: info.bytes};
}
