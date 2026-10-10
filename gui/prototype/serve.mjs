// FontAlloy prototype dev server (Node, concurrent — 81 font files load in parallel).
// Usage: node serve.mjs [port]  (default 8123)
import http from 'node:http';
import {createReadStream,statSync} from 'node:fs';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const port=+(process.argv[2]||8123);
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json',
  '.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);
  if(p==='/')p='/index.html';
  if(p==='/favicon.ico'){res.writeHead(204);res.end();return}
  const f=normalize(join(root,p));
  if(!f.startsWith(root)){res.writeHead(403);res.end();return}
  try{
    const st=statSync(f);
    res.writeHead(200,{
      'content-type':MIME[extname(f).toLowerCase()]||'application/octet-stream',
      'content-length':st.size,
      'cache-control':f.endsWith('.html')?'no-cache':'public, max-age=3600'});
    createReadStream(f).pipe(res);
  }catch{res.writeHead(404);res.end('not found')}
}).listen(port,()=>console.log(`serving ${root} at http://127.0.0.1:${port}`));
