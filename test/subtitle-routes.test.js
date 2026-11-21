import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// Captions through the real server and the Plex source. A subtitle file Plex can hand
// over is a text track; every other one can only be drawn into the picture by the
// transcoder. Plex and plex.tv are mocked.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-subtitles-test-'));
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: 'owner@example.test',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', FREESTUFFCRAZY_PLUGIN_MODULES: '', EMBY_URL: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '',
});

const SRT = '1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <i>there</i>\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,250\r\nSecond line\r\nwraps\r\n';
const streams = [
  { id: 11, streamType: 3, codec: 'srt', format: 'srt', key: '/library/streams/11', languageCode: 'eng', displayTitle: 'English (SRT External)' },
  { id: 12, streamType: 3, codec: 'srt', languageCode: 'spa', displayTitle: 'Spanish', extendedDisplayTitle: 'Spanish (SRT)' },
  { id: 15, streamType: 3, codec: 'srt', languageCode: 'eng', displayTitle: 'English', extendedDisplayTitle: ' (English SRT)', selected: true },
  { id: 13, streamType: 3, codec: 'pgs', languageCode: 'fre', displayTitle: 'French (PGS)', forced: true },
  { id: 14, streamType: 3, codec: 'ass', format: 'ass', key: '/library/streams/14', languageCode: 'ger', displayTitle: 'German (ASS External)' },
  { id: 20, streamType: 2, codec: 'aac', languageCode: 'eng' },
];
const originalFetch = globalThis.fetch;
const calls = [];
let pinSequence = 800;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  calls.push({ url, options });
  const json = body => Response.json(body);
  const p = url.pathname;
  if (p === '/identity') return json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (p === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (p === '/api/v2/pins') return json({ id: ++pinSequence, code: 'TEST' });
  if (/^\/api\/v2\/pins\/\d+$/.test(p)) return json({ authToken: 'test-account-token' });
  if (p === '/api/v2/home/users') return json({ users: [{ id: 10, title: 'Owner', admin: true }] });
  if (p === '/api/v2/user') return json({ id: 1, username: 'Owner', email: 'Owner@Example.test', confirmed: true });
  if (p === '/api/v2/resources') return json([{ clientIdentifier: 'test-server', provides: 'server', owned: true, accessToken: 'test-server-token', connections: [{ uri: 'https://plex.example', relay: false }] }]);
  if (p === '/library/metadata/7') return json({ MediaContainer: { Metadata: [{ ratingKey: '7', type: 'movie', title: 'Subtitled', duration: 100000, Media: [{ Part: [{ id: 70, Stream: streams }] }] }] } });
  if (p === '/library/metadata/8') return json({ MediaContainer: { Metadata: [{ ratingKey: '8', type: 'movie', title: 'Silent', duration: 100000, Media: [{ Part: [{ Stream: [] }] }] }] } });
  if (p === '/library/streams/11') return new Response(SRT, { headers: { 'Content-Type': 'application/x-subrip' } });
  if (p === '/library/streams/14') return new Response('[Script Info]', { headers: { 'Content-Type': 'text/plain' } });
  if (p === '/library/parts/70' && options.method === 'PUT') return new Response('');
  if (p === '/video/:/transcode/universal/decision') return json({ MediaContainer: {} });
  if (p === '/video/:/transcode/universal/start.m3u8') return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nsession/${url.searchParams.get('session')}/base/index.m3u8\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (p === '/video/:/transcode/universal/stop') return new Response('');
  throw new Error(`Unexpected mocked upstream request: ${p}`);
};
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url, { method = 'GET', body, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    req.url = url; req.method = method;
    const payload = body === undefined ? null : JSON.stringify(body);
    req.headers = { host: 'dash.example', origin: 'https://dash.example', cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) };
    const res = new ServerResponse(req);
    const chunks = [];
    res.write = function (chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
    res.end = function (chunk) {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      const type = String(res.getHeader('content-type') || '');
      const text = /json|text|mpegurl/.test(type) ? buffer.toString() : '';
      resolve({ status: res.statusCode, headers: res.getHeaders(), bytes: buffer.length, text,
        json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];
const callsTo = pathname => calls.filter(call => call.url.pathname === pathname);

async function signIn() {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const poll = await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: cookieFrom(start, 'freeStuffCrazyPlayerLogin') });
  assert.equal(poll.json.authenticated, true);
  return cookieFrom(poll, 'freeStuffCrazyPlayerSession');
}

test('captions need a signed-in viewer', async () => {
  assert.equal((await request('/api/library/subtitles/7')).status, 401);
  assert.equal((await request('/api/library/subtitle/7/11')).status, 401);
});

test('an item lists its subtitle tracks: a file Plex hands over is text, the rest are drawn by the server', async () => {
  const cookie = await signIn();
  const listed = await request('/api/library/subtitles/7', { cookie });
  assert.equal(listed.status, 200, listed.text);
  const byId = Object.fromEntries(listed.json.tracks.map(track => [track.id, track]));
  assert.deepEqual(Object.keys(byId).sort(), ['11', '12', '13', '14', '15'], 'only subtitle streams, never the audio one');
  assert.equal(byId[11].kind, 'text');
  assert.equal(byId[11].language, 'eng');
  assert.equal(byId[12].kind, 'burn', 'a subtitle inside the video file cannot be fetched as text');
  assert.equal(byId[13].kind, 'burn');
  assert.equal(byId[13].forced, true);
  assert.equal(byId[13].language, 'fra', 'French is the same language under either of its codes');
  assert.equal(byId[14].kind, 'burn', 'a format the player cannot read is drawn by the server');
  assert.equal(byId[12].label, 'Spanish (SRT)', 'the longer title tells a track in the file from a separate one');
  assert.equal(byId[15].label, 'English', 'a longer title with no name of its own is not used');
  assert.equal(listed.json.tracks[0].kind, 'text', 'text tracks come first');
  assert.ok(!/library\/streams|token/i.test(listed.text), 'no server paths or tokens reach the page');
  assert.deepEqual((await request('/api/library/subtitles/8', { cookie })).json, { tracks: [] });
  assert.equal((await request('/api/library/subtitles/not-a-key', { cookie })).status, 400);
});

test('a text track comes back as WebVTT, and nothing else can be fetched', async () => {
  const cookie = await signIn();
  const vtt = await request('/api/library/subtitle/7/11', { cookie });
  assert.equal(vtt.status, 200, vtt.text);
  assert.match(vtt.headers['content-type'], /^text\/vtt/);
  assert.equal(vtt.text.startsWith('WEBVTT\n'), true);
  assert.match(vtt.text, /00:00:01\.500 --> 00:00:03\.000\nHello <i>there<\/i>/);
  assert.match(vtt.text, /00:00:04\.000 --> 00:00:05\.250\nSecond line\nwraps/);
  assert.equal((await request('/api/library/subtitle/7/12', { cookie })).status, 404, 'not a text track');
  assert.equal((await request('/api/library/subtitle/7/14', { cookie })).status, 404, 'an unreadable format');
  assert.equal((await request('/api/library/subtitle/7/999', { cookie })).status, 404, 'not one of this item\'s streams');
  assert.equal((await request('/api/library/subtitle/7/20', { cookie })).status, 404, 'the audio stream is not a subtitle');
  assert.equal((await request('/api/library/subtitle/7/..%2F11', { cookie })).status, 400);
  assert.equal((await request('/api/library/subtitle/7/abc', { cookie })).status, 400);
});

test('a chosen subtitle track is burned into the stream, and only a real track ID is passed on', async () => {
  const cookie = await signIn();
  const startedWith = async query => {
    const started = await request(`/api/start?key=7&quality=low&playbackId=${query.playbackId}${query.extra || ''}`, { cookie });
    assert.equal(started.status, 200, started.text);
    return calls.filter(call => call.url.pathname === '/video/:/transcode/universal/decision').at(-1).url.searchParams;
  };
  const selections = () => calls.filter(call => call.url.pathname.startsWith('/library/parts/'));
  const plain = await startedWith({ playbackId: 'cc-1' });
  assert.equal(plain.get('subtitles'), 'none', 'a track chosen in another Plex app is left out');
  assert.equal(plain.get('subtitleStreamID'), null);
  assert.equal(selections().length, 0, 'turning captions off leaves the choice on the file alone');
  const burned = await startedWith({ playbackId: 'cc-2', extra: '&subtitle=12' });
  assert.equal(burned.get('subtitles'), 'burn');
  assert.equal(burned.get('subtitleStreamID'), '12');
  // Plex burns the track chosen on the file, so it is chosen there before the stream starts.
  const [selection] = selections();
  assert.equal(selection.options.method, 'PUT');
  assert.equal(selection.url.searchParams.get('subtitleStreamID'), '12');
  assert.equal(selection.url.searchParams.get('allParts'), '1');
  assert.equal(selection.options.headers['X-Plex-Token'], 'test-server-token');
  assert.ok(calls.indexOf(selection) < calls.findLastIndex(call => call.url.pathname === '/video/:/transcode/universal/decision'));
  await startedWith({ playbackId: 'cc-2b', extra: '&subtitle=15' });
  assert.equal(selections().length, 1, 'a track already chosen is not chosen again');
  await startedWith({ playbackId: 'cc-2c', extra: '&subtitle=999' });
  assert.equal(selections().length, 1, 'only one of the item\'s own tracks is chosen');
  const junk = await startedWith({ playbackId: 'cc-3', extra: '&subtitle=12%26path%3D%2Fx' });
  assert.equal(junk.get('subtitles'), 'none', 'anything but digits is ignored');
  assert.equal(junk.get('path'), '/library/metadata/7');
});
