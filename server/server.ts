import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createGzip } from 'node:zlib';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { feature, fields, boundedInteger } from './demo.ts';
import { fixtureFilter } from './filter.ts';
import { setImmediate } from 'node:timers/promises';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const maxPoints = 50_000_000;
const xml = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export function capabilities(base: string) {
  return `<?xml version="1.0"?><wfs:WFS_Capabilities version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:demo="urn:demo">
  <ows:ServiceIdentification><ows:Title>Deterministic million-point WFS development fixture</ows:Title><ows:ServiceType>WFS</ows:ServiceType><ows:ServiceTypeVersion>2.0.0</ows:ServiceTypeVersion></ows:ServiceIdentification>
  <ows:OperationsMetadata>${['GetCapabilities', 'DescribeFeatureType', 'GetFeature'].map(n => `<ows:Operation name="${n}"><ows:DCP><ows:HTTP><ows:Get xlink:href="${xml(base)}"/></ows:HTTP></ows:DCP>${n === 'GetFeature' ? '<ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>application/json</ows:Value><ows:Value>application/gml+xml; version=3.2</ows:Value></ows:AllowedValues></ows:Parameter>' : ''}</ows:Operation>`).join('')}
  <ows:Constraint name="ImplementsResultPaging"><ows:DefaultValue>TRUE</ows:DefaultValue></ows:Constraint></ows:OperationsMetadata>
  <wfs:FeatureTypeList><wfs:FeatureType><wfs:Name>demo:points</wfs:Name><wfs:Title>Generated points (8 fields)</wfs:Title><wfs:DefaultCRS>urn:ogc:def:crs:OGC:1.3:CRS84</wfs:DefaultCRS><wfs:OtherCRS>urn:ogc:def:crs:EPSG::4326</wfs:OtherCRS><ows:WGS84BoundingBox><ows:LowerCorner>-179 -70</ows:LowerCorner><ows:UpperCorner>179 70</ows:UpperCorner></ows:WGS84BoundingBox></wfs:FeatureType></wfs:FeatureTypeList></wfs:WFS_Capabilities>`;
}
export function schema() { return `<?xml version="1.0"?><xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:demo="urn:demo" targetNamespace="urn:demo" elementFormDefault="qualified"><xsd:import namespace="http://www.opengis.net/gml/3.2" schemaLocation="http://schemas.opengis.net/gml/3.2.1/gml.xsd"/><xsd:element name="points" type="demo:pointsType" substitutionGroup="gml:AbstractFeature"/><xsd:complexType name="pointsType"><xsd:complexContent><xsd:extension base="gml:AbstractFeatureType"><xsd:sequence><xsd:element name="geometry" type="gml:PointPropertyType"/>${Object.entries(fields).map(([n,t]) => `<xsd:element name="${n}" type="xsd:${t}"/>`).join('')}</xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType></xsd:schema>`; }
export async function handle(req: IncomingMessage, res: ServerResponse, testWfs = { running: false }) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url!, 'http://localhost');
  if (u.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
  if (u.pathname === '/api/site-config') {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ bannerText: process.env.PAGE_BANNER_TEXT ?? '', bannerBackground: process.env.PAGE_BANNER_BACKGROUND ?? '#eaf0f4' })); return;
  }
  if (u.pathname === '/api/test-wfs' || u.pathname === '/api/test-wfs/start') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (u.pathname.endsWith('/start')) {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end('{"error":"Use POST to start the test server"}'); return; }
      // This only activates our built-in fixture; it cannot launch arbitrary processes.
      // Cross-origin WFS reads are allowed; server lifecycle requests are same-origin.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { res.writeHead(403); res.end('{"error":"Same-origin request required"}'); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415); res.end('{"error":"Use application/json"}'); return; }
      testWfs.running = true;
      req.resume();
    } else if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    res.end(JSON.stringify({ running: testWfs.running, endpoint: '/test-wfs' })); return;
  }
  if (u.pathname === '/test-wfs' && !testWfs.running) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"Start the test WFS server from Data sources first"}'); return; }
  if (!['/wfs', '/test-wfs'].includes(u.pathname)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const file = resolve(root, '.' + decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('Run npm run build first; development UI uses port 5173.'); return; }
    res.setHeader('Content-Type', ({ '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' } as Record<string,string>)[extname(file)] ?? 'application/octet-stream');
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
    return;
  }
  try {
    // WFS KVP parameter names are case insensitive.
    const p = new Map([...u.searchParams].map(([k,v]) => [k.toLowerCase(),v]));
    const op = (p.get('request') ?? 'GetCapabilities').toLowerCase();
    if (p.has('version') && p.get('version') !== '2.0.0') throw new Error('This development fixture supports WFS 2.0.0 only.');
    if (op === 'getcapabilities') { res.setHeader('Content-Type','application/xml'); res.end(capabilities(`http://${req.headers.host}${u.pathname}`)); return; }
    if (op === 'describefeaturetype') { res.setHeader('Content-Type','application/xml'); res.end(schema()); return; }
    if (op !== 'getfeature') throw new Error('Unsupported operation');
    if ((p.get('typenames') ?? p.get('typename')) !== 'demo:points') throw new Error('typeNames must be demo:points');
    if (p.has('cql_filter')) throw new Error('Use standard XML FILTER for fixture time and map area bounds.');
    if (p.has('filter') && p.has('bbox')) throw new Error('FILTER and BBOX are mutually exclusive.');
    const filter = fixtureFilter(p.get('filter'));
    if (p.has('sortby') && !/^id(\s+A)?$/i.test(p.get('sortby')!)) throw new Error('Fixture only supports sortBy=id A');
    const n = boundedInteger(p.get('points') ?? process.env.POINTS, 3_000_000, maxPoints);
    const offset = boundedInteger(p.get('startindex'), 0, maxPoints);
    const count = boundedInteger(p.get('count'), 50_000, 100_000);
    const distribution = p.get('distribution') ?? 'uk';
    if (!['uk','world','dense'].includes(distribution)) throw new Error('distribution must be uk, world, or dense');
    const crs = p.get('srsname') ?? 'urn:ogc:def:crs:OGC:1.3:CRS84';
    if (!/CRS84|4326/i.test(crs)) throw new Error('Fixture only supports CRS84 and EPSG:4326');
    const gml = /gml/i.test(p.get('outputformat') ?? '');
    if (!gml && p.has('outputformat') && !/json/i.test(p.get('outputformat')!)) throw new Error('Unsupported outputFormat');
    const bbox = p.get('bbox')?.split(',').slice(0,4).map(Number);
    if (bbox && (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v)))) throw new Error('Invalid bbox');
    // BBOX fixture uses CRS84 lon/lat. Full layer iteration is deliberately lazy.
    const matches = (f: ReturnType<typeof feature>) => filter(f) && (!bbox || (f.geometry.coordinates[0]>=bbox[0] && f.geometry.coordinates[1]>=bbox[1] && f.geometry.coordinates[0]<=bbox[2] && f.geometry.coordinates[1]<=bbox[3]));
    let matched = n;
    const filtered = !!bbox || p.has('filter');
    if (filtered) {
      matched = 0;
      for (let i = 0; i < n; i++) {
        if (i % 16384 === 0) { await setImmediate(); if (res.destroyed) return; }
        if (matches(feature(i, distribution))) matched++;
      }
    }
    if (p.get('resulttype')?.toLowerCase() === 'hits') { res.setHeader('Content-Type','application/xml'); res.end(`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${matched}" numberReturned="0" timeStamp="${new Date().toISOString()}"/>`); return; }
    const returned = Math.max(0, Math.min(count, matched - offset));
    res.setHeader('Content-Type', gml ? 'application/gml+xml; version=3.2' : 'application/geo+json');
    res.setHeader('Cache-Control','no-store');
    const compress = /gzip/.test(req.headers['accept-encoding'] ?? '');
    if (compress) res.setHeader('Content-Encoding','gzip');
    res.setHeader('Vary','Accept-Encoding');
    const out = compress ? createGzip({ level: 1 }) : res;
    if (compress) out.pipe(res);
    // Abort generation if the client cancels; no pending background scan.
    res.on('close', () => { if (compress) out.destroy(); });
    async function write(s: string) { if (res.destroyed) throw new Error('Client disconnected'); if (!out.write(s)) await once(out,'drain'); }
    await write(gml ? `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:demo="urn:demo" numberMatched="${matched}" numberReturned="${returned}">` : `{"type":"FeatureCollection","numberMatched":${matched},"numberReturned":${returned},"features":[`);
    let emitted=0, skipped=0, batch='';
    const selected = p.get('propertyname')?.split(',');
    for(let i=filtered ? 0 : offset; i<n && emitted<returned; i++) {
      if (filtered && i % 16384 === 0) { await setImmediate(); if (res.destroyed) return; }
      const f=feature(i,distribution);
      if (!matches(f)) continue;
      if (filtered && skipped++ < offset) continue;
      if (gml) {
        const pos=/4326/i.test(crs) ? [...f.geometry.coordinates].reverse() : f.geometry.coordinates;
        batch += `<wfs:member><demo:points gml:id="points.${i}"><demo:geometry><gml:Point srsName="${xml(crs)}"><gml:pos>${pos.join(' ')}</gml:pos></gml:Point></demo:geometry>${Object.entries(f.properties).filter(([k])=>!selected||selected.includes(k)).map(([k,v])=>`<demo:${k}>${xml(v)}</demo:${k}>`).join('')}</demo:points></wfs:member>`;
      } else {
        if(selected) f.properties=Object.fromEntries(Object.entries(f.properties).filter(([k])=>selected.includes(k))) as typeof f.properties;
        batch += (emitted?',':'')+JSON.stringify(f);
      }
      emitted++;
      if(emitted%2048===0) { await write(batch); batch=''; }
    }
    if(batch) await write(batch);
    out.end(gml ? '</wfs:FeatureCollection>' : ']}');
  } catch(e) {
    if(res.headersSent) { res.destroy(); return; }
    res.writeHead(400,{'Content-Type':'application/xml'});
    res.end(`<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>${xml((e as Error).message)}</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`);
  }
}
export function start(port = Number(process.env.PORT ?? 8787)) {
  const testWfs = { running: false };
  const server=createServer((req,res)=>{ void handle(req,res,testWfs).catch(()=>res.destroy()); });
  server.listen(port,process.env.HOST ?? '127.0.0.1',()=>console.log(`WFS + built application: http://${process.env.HOST ?? '127.0.0.1'}:${port}`));
  return server;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) start();
