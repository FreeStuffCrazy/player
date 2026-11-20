// Plex as a media source: sign-in, library browsing, HLS playback through
// Plex's transcoder, and watch state. server.js talks to it only through the
// source interface described in sources.js, so other backends can sit beside it.

import crypto from 'node:crypto';
import { rewriteManifest } from './plex-manifest.js';
import { resolveAccountId, authorizedNextUp } from './profile-identity.js';
import { installationId } from './private-storage.js';
import { QUALITY_LEVELS, normalizeQuality, qualityTiers, plexProfileConstraints } from './public/engine/quality-tiers.js';
import { directPlexOrigin, fetchAvatar, mediaProxyPath, readBodyText, safeError } from './security.js';
import { plexSessionId, createPlexSessionProbe, fetchPlexSegment } from './plex-session.js';
import { sendMediaServerSlow } from './media-server-wait.js';
import { createPlexLibrary } from './plex-library.js';
import { createPlexAuth } from './plex-auth.js';
import { plexDeviceHeaders } from './plex-connection.js';
import { createOwnerLink } from './plex-owner-link.js';
import { TRACK_ID } from './subtitles.js';
import * as localProgress from './local-progress.js';
import { adminConfigured, adminSpec, plexEmail } from './admin-auth.js';
import { firstPluginWith } from './plugins.js';
import { createPlexAccountDirectory } from './plex-account-directory.js';

const PLAYLIST_LIMIT = 4 * 1024 * 1024;

export async function createPlexSource({ id = 'plex', config, plugins, store, pipeUpstream, env = process.env, signedIn = null }) {
  // Single tenant (no plugin choosing servers): only the Plex account whose
  // confirmed email is PLEX_EMAIL may sign in; its Home profiles still can.
  const SIGN_IN_EMAIL = firstPluginWith(plugins, 'resolveServer') ? null : plexEmail(env);
  // The server's address and ID are saved the first time that account signs in; no
  // Plex token is kept (see plex-owner-link.js).
  const PLUGIN_CHOOSES_SERVER = !!firstPluginWith(plugins, 'resolveServer');
  const CLIENT_ID = env.PLEX_CLIENT_ID || installationId();
  const PRODUCT_NAME = config.plex.productName;

  // Content routes pass the profile token.
  function plexHeaders(token) {
    return {
      'X-Plex-Client-Identifier': CLIENT_ID,
      ...plexDeviceHeaders(PRODUCT_NAME),
      'X-Plex-Version': '1.0',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Token': token,
    };
  }

  // The Plex server this install belongs to. The played threshold is read whenever the
  // owner's token is at hand.
  const ownerLink = createOwnerLink({
    env, clientId: CLIENT_ID, productName: PRODUCT_NAME, collection: store.collection('plex-link'),
    onLinked: async (linked) => {
      console.log(`Using Plex server at ${linked.url}`);
      // Identifies this install's server by machineIdentifier, not connection URI,
      // so the same server's data stays in one bucket regardless of which URI a
      // session happens to resolve to.
      localProgress.bindLegacyServer(linked.machineIdentifier, store);
    },
    // Use the server's played threshold; 90% until it has been read.
    onOwnerToken: async (linked, token) => {
      if (thresholdRead || !token) return;
      try {
        const prefsRes = await fetch(`${linked.url}/:/prefs`, { headers: { Accept: 'application/json', 'X-Plex-Token': token }, signal: AbortSignal.timeout(10000), redirect: 'error' });
        const prefsData = await prefsRes.json();
        const pref = (prefsData.MediaContainer.Setting || []).find((setting) => setting.id === 'LibraryVideoPlayedThreshold');
        if (pref?.value != null) localProgress.setFinishedThreshold(Number(pref.value) / 100, linked.machineIdentifier);
        thresholdRead = true;
      } catch (err) {
        console.warn(`Couldn't read LibraryVideoPlayedThreshold from Plex; using 90% default: ${safeError(err)}`);
      }
    },
  });
  let thresholdRead = false;
  const owner = ownerLink.owner;
  // With a plugin choosing each viewer's server there is no server of this install's own.
  if (PLUGIN_CHOOSES_SERVER) {
    // Progress saved before it was kept per server belongs to a server only the owner
    // link could name, and there is none here. Anything already kept per server is untouched.
    localProgress.bindLegacyServer('legacy-unassigned', store);
  } else {
    await ownerLink.restore();
  }

  // Accounts seen at sign-in, so admin pages can find them by name. Only kept
  // when the admin area is configured; nothing else reads it.
  const accountDirectory = adminConfigured(env) && env.SESSION_SECRET
    ? createPlexAccountDirectory({ collection: store.collection('plex-accounts'), secret: env.SESSION_SECRET }) : null;

  const plexAuth = createPlexAuth({
    owner, clientId: CLIENT_ID, productName: PRODUCT_NAME, plugins, store, sourceId: id, signedIn,
    onAccount: accountDirectory && (identity => accountDirectory.remember(identity)),
  });

  // The admin is the server owner's Home profile on the account whose
  // confirmed plex.tv email is named in FREESTUFFCRAZY_ADMIN=plex:<email>, or by
  // default the PLEX_EMAIL account.
  const spec = adminSpec(env);
  const adminEmail = spec ? (spec.type === 'plex' ? spec.who : null) : plexEmail(env);
  plexAuth.getAdminIdentity = async req => {
    if (!adminEmail || !plexAuth.getSessionIsAdmin(req)) return null;
    const identity = await plexAuth.getSessionIdentity(req);
    // The name reaches the browser (passkey user name), so it's the Plex
    // username, never the email.
    return identity?.confirmedEmail === adminEmail ? { id: `plex:${identity.id}`, name: identity.username || `Plex account ${identity.id}` } : null;
  };

  // Use the session’s profile token, with a configured-token fallback when auth is disabled.
  function tokenForRequest(req) {
    const token = req && plexAuth.getSessionPlexToken(req);
    if (req && config.auth.enabled && !token) throw new Error('Not authenticated');
    if (!token) throw new Error('Not authenticated');
    return token;
  }

  // Mirrors tokenForRequest -- which Plex server this request's token is
  // valid against, defaulting to the owner's server.
  function urlForRequest(req) {
    return (req && plexAuth.getSessionPlexUrl(req)) || owner.url;
  }

  // Create lightweight library clients per request; session probes are cached separately.
  function libraryFor(token, plexUrl = owner.url, clientId = CLIENT_ID) {
    return createPlexLibrary({ plexUrl, token, clientId, productName: PRODUCT_NAME });
  }

  // A stable identifier per Home profile, not one app-wide CLIENT_ID for
  // everyone, so Plex's hub personalization resolves the right account.
  function clientIdForRequest(req) {
    const profileId = req && plexAuth.getSessionProfileId(req);
    return profileId ? `${CLIENT_ID}-${profileId}` : CLIENT_ID;
  }

  // The common case of every argument above derived from the same request.
  function libraryForRequest(req) {
    return libraryFor(tokenForRequest(req), urlForRequest(req), clientIdForRequest(req));
  }

  // Owner-only lookups (the account list and watch history) use the signed-in
  // account's own token, not the Home profile's. When this is the server's owner,
  // which it always is on a single-tenant install, that is the owner's token.
  function adminLibraryFor(req, url) {
    return libraryFor(plexAuth.getSessionCredential(req)?.accountToken || tokenForRequest(req), url);
  }

  // Keys local-progress.js's storage by physical server, not connection URI.
  function serverIdForRequest(req) {
    return (req && plexAuth.getSessionMachineIdentifier(req)) || owner.machineIdentifier;
  }

  // Resolves the verified Home profile to a PMS account ID, caching accounts
  // per physical server rather than per connection URI.
  const accountsCacheByMachineId = new Map(); // machineIdentifier -> { accounts, at }
  async function accountIdForRequest(req) {
    const profile = await plexAuth.getVerifiedProfile(req);
    if (!profile) return null;
    const url = urlForRequest(req);
    const machineId = plexAuth.getSessionMachineIdentifier(req) || url;
    let entry = accountsCacheByMachineId.get(machineId);
    if (!entry || Date.now() - entry.at > 60_000) {
      entry = { accounts: await adminLibraryFor(req, url).accounts(), at: Date.now() };
      if (accountsCacheByMachineId.size >= config.auth.maxSessions) accountsCacheByMachineId.delete(accountsCacheByMachineId.keys().next().value);
      accountsCacheByMachineId.set(machineId, entry);
    }
    return resolveAccountId(profile, entry.accounts, config.plex.profileAccountIds);
  }

  const sessionProbesByToken = new Map();
  function sessionProbeFor(token, plexUrl = owner.url) {
    const key = `${plexUrl}::${token}`;
    if (!sessionProbesByToken.has(key)) {
      if (sessionProbesByToken.size >= config.auth.maxSessions) sessionProbesByToken.delete(sessionProbesByToken.keys().next().value);
      sessionProbesByToken.set(key, createPlexSessionProbe({ baseUrl: plexUrl, token }));
    }
    return sessionProbesByToken.get(key);
  }

  // Never expose the configured installation token to anonymous/auth-disabled clients.
  function directTokenForRequest(req) {
    return directPlexOrigin(plexAuth.getSessionPlexUrl(req) || owner.url)
      ? plexAuth.getSessionPlexToken(req) || '' : '';
  }

  // ---- Playback -----------------------------------------------------------

  async function stopTranscode({ sessionId, token, plexUrl = owner.url, kind = 'video' }) {
    if (!sessionId) return;
    const params = new URLSearchParams({ session: sessionId });
    try {
      await fetch(`${plexUrl}/${kind === 'music' ? 'music' : 'video'}/:/transcode/universal/stop?${params}`, {
        headers: plexHeaders(token), redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      console.error('Failed to stop Plex transcode session');
    }
  }

  // The client picks a starting tier and can step down if playback struggles.
  function qualityTierFor(value) {
    return typeof value === 'string' && QUALITY_LEVELS.includes(value) ? value : 'high';
  }

  function plexTranscodeParams(path, session, quality = 'high', subtitle = null) {
    quality = normalizeQuality(quality);
    const tier = qualityTiers(config.plex.videoBitrate)[quality];
    return new URLSearchParams({
      // A chosen subtitle track is drawn into the picture by the transcoder (see selectSubtitle). Without
      // one, a track chosen in another Plex app is left out.
      ...(subtitle ? { subtitles: 'burn', subtitleStreamID: subtitle } : { subtitles: 'none' }),
      hasMDE: '1',
      path,
      mediaIndex: '0',
      partIndex: '0',
      protocol: 'hls',
      fastSeek: '1',
      directPlay: '0',
      directStream: '0',
      directStreamAudio: '0',
      videoCodec: 'h264',
      audioCodec: 'aac',
      maxAudioChannels: '2',
      'X-Plex-Client-Profile-Extra': plexProfileConstraints(quality),
      subtitleSize: '100',
      audioBoost: '100',
      location: 'lan',
      session,
      maxVideoBitrate: String(tier.videoBitrate),
      videoBitrate: String(tier.videoBitrate),
      videoResolution: tier.videoResolution,
      videoQuality: '100',
      'X-Plex-Incomplete-Segments': '1',
    });
  }

  // A track is transcoded by Plex's music endpoint, which wants a bitrate and a profile that
  // allows audio-only HLS (the same request Plex Web makes). The tier sets how much to send.
  // 48 kHz unless the browser says it can take the track as it is: a car's audio hardware runs at 48 kHz, and a
  // 44.1 kHz stream is resampled live by its slow browser, which stutters (MCU2). Plex does the conversion
  // instead. (The page works out whether it is one; see public/engine/audio-rate.js.)
  const MUSIC_BITRATE_KBPS = { ultra: 320, high: 256, medium: 192, low: 128 };
  const MUSIC_TARGET = 'add-transcode-target(type=musicProfile&context=streaming&protocol=hls&container=mpegts&audioCodec=aac)';
  const MUSIC_48K = '+add-limitation(scope=musicCodec&scopeName=aac&type=match&name=audio.samplingRate&list=48000&replaceAudioCodec=aac)';
  function plexMusicParams(path, session, quality = 'high', { sourceRate = false } = {}) {
    return new URLSearchParams({
      hasMDE: '1',
      path,
      mediaIndex: '0',
      partIndex: '0',
      protocol: 'hls',
      directPlay: '0',
      directStream: '0',
      directStreamAudio: '0',
      musicBitrate: String(MUSIC_BITRATE_KBPS[normalizeQuality(quality)]),
      mediaBufferSize: '12288',
      session,
      'X-Plex-Client-Profile-Extra': sourceRate ? MUSIC_TARGET : MUSIC_TARGET + MUSIC_48K,
    });
  }

  // Runs the decision call Plex needs before start.m3u8 will serve a
  // playlist, then proxies that playlist back with its URIs rewritten through /proxy/.
  async function startStream(req, res, { itemId, state, stopState }) {
    const token = tokenForRequest(req);
    const plexUrl = urlForRequest(req);
    const sessionId = crypto.randomUUID();
    const timing = { startedAt: performance.now(), details: 0, decision: 0, playlist: 0 };
    const subtitle = typeof req.query.subtitle === 'string' && TRACK_ID.test(req.query.subtitle) ? req.query.subtitle : null;
    // A track is not a video: Plex plays it through its music transcoder. Which one is asked of the item
    // itself; if that cannot be read, it is treated as video, as before.
    const lib = libraryFor(token, plexUrl);
    const kind = (await lib.itemDetails(itemId).catch(() => null))?.type === 'track' ? 'music' : 'video';
    if (kind === 'video' && subtitle) {
      await lib.selectSubtitle(itemId, subtitle).catch(error => console.warn('Plex subtitle selection failed:', error.message));
    }
    timing.details = performance.now();
    const params = kind === 'music'
      ? plexMusicParams(`/library/metadata/${itemId}`, sessionId, qualityTierFor(req.query.quality), { sourceRate: req.query.rate === 'source' })
      : plexTranscodeParams(`/library/metadata/${itemId}`, sessionId, qualityTierFor(req.query.quality), subtitle);

    const decisionRes = await fetch(`${plexUrl}/${kind}/:/transcode/universal/decision?${params}`, {
      headers: { ...plexHeaders(token), Accept: 'application/json' },
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!decisionRes.ok) {
      await decisionRes.body?.cancel();
      console.error('Plex transcode decision failed', decisionRes.status);
      await stopState(state);
      res.status(decisionRes.status).send('Plex playback request failed');
      return;
    }
    await decisionRes.body?.cancel();
    timing.decision = performance.now();

    const active = { source: id, sessionId, token, plexUrl, kind };
    state.active = active;
    const upstreamUrl = `${plexUrl}/${kind}/:/transcode/universal/start.m3u8?${params}`;
    const plexRes = await fetch(upstreamUrl, { headers: plexHeaders(token), signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!plexRes.ok) {
      await plexRes.body?.cancel();
      console.error('Plex start.m3u8 failed', plexRes.status);
      await stopState(state);
      res.status(plexRes.status).send('Plex playback request failed');
      return;
    }
    state.active = active;

    const manifest = await readBodyText(plexRes, PLAYLIST_LIMIT);
    timing.playlist = performance.now();
    if (process.env.NODE_ENV !== 'production') {
      console.info('[plex-start-timing]', JSON.stringify({ kind, detailsMs: Math.round(timing.details - timing.startedAt), decisionMs: Math.round(timing.decision - timing.details), playlistMs: Math.round(timing.playlist - timing.decision) }));
    }
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewriteManifest(manifest, upstreamUrl, sessionId, req.query.direct === '1' ? directTokenForRequest(req) : ''));
  }

  // Relay playlists and segments of a stream this viewer owns.
  async function proxyMedia(req, res, { ownsSession }) {
    try {
      const token = tokenForRequest(req);
      const plexUrl = urlForRequest(req);
      const targetPath = req.params[0];
      const ownedSession = plexSessionId('/' + targetPath);
      if (!mediaProxyPath(targetPath, ownedSession) || !ownsSession(ownedSession)) return res.status(403).end();
      const url = new URL(`${plexUrl}/${targetPath}`);
      for (const [k, v] of Object.entries(req.query)) {
        if (/^X-Plex-/i.test(k) || !['offset', 'copyts', 'wait', 'partIndex', 'mediaIndex'].includes(k)) continue;
        if (typeof v === 'string' && v.length <= 128) url.searchParams.set(k, v);
      }

      const headers = plexHeaders(token);
      const askedAt = performance.now();
      const result = await fetchPlexSegment(url, { headers, probe: sessionProbeFor(token, plexUrl), session: ownedSession });
      // Outside production, say when Plex was slow to hand over a playlist or segment (a stream that is only starting).
      const waitedMs = Math.round(performance.now() - askedAt);
      if (process.env.NODE_ENV !== 'production' && waitedMs >= 1500) console.info('[plex-slow-segment]', JSON.stringify({ waitedMs, file: String(targetPath).split('/').pop().slice(0, 40) }));
      if (result.expired) {
        return res.status(410).json({ code: 'PLEX_SESSION_EXPIRED', error: 'Plex playback session expired' });
      }
      if (result.slow) return sendMediaServerSlow(res);

      const upstream = result.response;
      const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
      if (!upstream.ok) { await upstream.body?.cancel(); return res.status(upstream.status).end(); }
      if (!/^(video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|octet-stream))/.test(contentType)) { await upstream.body?.cancel(); return res.status(502).end(); }

      if (contentType.includes('mpegurl')) {
        const text = await readBodyText(upstream, PLAYLIST_LIMIT);
        res.status(upstream.status);
        res.set('Content-Type', contentType);
        res.send(rewriteManifest(text, url, ownedSession, req.query.direct === '1' ? directTokenForRequest(req) : ''));
        return;
      }

      res.status(upstream.status);
      res.set('Content-Type', contentType);
      if (upstream.body) pipeUpstream(upstream, res);
      else res.end();
    } catch (err) {
      console.error('Plex request failed');
      res.status(err.code === 'RESPONSE_TOO_LARGE' ? 502 : 500).send(safeError(err));
    }
  }

  // ---- Watch state --------------------------------------------------------

  // Records episode completions locally to supplement Plex history for next-up.
  // plexUrl looks the item up; serverId is the stable machineIdentifier
  // local-progress.js stores against -- the two can legitimately differ.
  async function recordFinishedEpisodeIfApplicable(accountId, ratingKey, token, plexUrl = owner.url, serverId = owner.machineIdentifier) {
    try {
      const details = await libraryFor(token, plexUrl).itemDetails(ratingKey);
      if (details.type !== 'episode') return;
      await localProgress.recordFinishedEpisode(accountId, {
        grandparentKey: details.grandparentKey,
        parentKey: details.parentKey,
        ratingKey: details.ratingKey,
        grandparentTitle: details.showTitle,
        librarySectionId: details.librarySectionId,
      }, serverId);
    } catch {
      // Item lookup failed -- skip silently, same as other best-effort spots.
    }
  }

  async function scrobbleToPlex(req, ratingKey, action) {
    const params = new URLSearchParams({
      key: ratingKey,
      identifier: 'com.plexapp.plugins.library',
    });
    await fetch(`${urlForRequest(req)}/:/${action}?${params}`, { headers: plexHeaders(tokenForRequest(req)), signal: AbortSignal.timeout(5000), redirect: 'error' });
  }

  async function reportProgress(req, { itemId, timeMs, state, durationMs }) {
    const finished = localProgress.isFinished(Math.floor(timeMs), Number.isFinite(durationMs) ? Math.floor(durationMs) : 0, serverIdForRequest(req));
    if (finished) {
      await scrobbleToPlex(req, itemId, 'scrobble');
      const accountId = await accountIdForRequest(req);
      if (accountId) await recordFinishedEpisodeIfApplicable(accountId, itemId, tokenForRequest(req), urlForRequest(req), serverIdForRequest(req));
      return;
    }
    const params = new URLSearchParams({
      key: itemId,
      identifier: 'com.plexapp.plugins.library',
      time: String(Math.floor(timeMs)),
      state: state === 'stopped' || state === 'paused' ? state : 'playing',
    });
    await fetch(`${urlForRequest(req)}/:/progress?${params}`, { headers: plexHeaders(tokenForRequest(req)), signal: AbortSignal.timeout(5000), redirect: 'error' });
  }

  async function markWatched(req, itemId) {
    const accountId = await accountIdForRequest(req);
    if (accountId) await recordFinishedEpisodeIfApplicable(accountId, itemId, tokenForRequest(req), urlForRequest(req), serverIdForRequest(req));
    await scrobbleToPlex(req, itemId, 'scrobble');
  }

  async function markUnwatched(req, itemId) {
    const accountId = await accountIdForRequest(req);
    if (accountId) {
      try {
        const details = await libraryForRequest(req).itemDetails(itemId);
        await localProgress.clearFinishedEpisodeIfCurrent(accountId, details.grandparentKey, details.ratingKey, serverIdForRequest(req));
      } catch {
        // Item lookup failed -- skip silently, same as other best-effort spots.
      }
    }
    await scrobbleToPlex(req, itemId, 'unscrobble');
  }

  // Combine profile-scoped section hubs with history-derived next-up items.
  async function continueWatching(req) {
    const url = urlForRequest(req);
    const accountId = await accountIdForRequest(req);
    const hubItems = await libraryForRequest(req).hubContinueWatching();
    // Without a mapped account, return the profile-token-scoped hub unchanged.
    if (!accountId) return hubItems;

    const hubKeys = new Set(hubItems.map((i) => i.ratingKey));
    const personalizedEpisodes = await adminLibraryFor(req, url).continueWatchingForAccount(accountId, {
      localFinished: await localProgress.finishedEpisodesForAccount(accountId, serverIdForRequest(req)),
    });
    const upNext = await authorizedNextUp(personalizedEpisodes, libraryForRequest(req), hubKeys);
    return [...hubItems, ...upNext];
  }

  async function sendThumbnail(req, res) {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!path || path.length > 4096) return res.status(400).end();
    const width = Number(req.query.width || 300);
    const height = Number(req.query.height || 450);
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 2048)) return res.status(400).end();
    try {
      const upstreamUrl = libraryForRequest(req).thumbnailUpstreamUrl(path, width, height);
      const upstream = await fetch(upstreamUrl, { headers: plexHeaders(tokenForRequest(req)), signal: AbortSignal.timeout(10000), redirect: 'error' });
      res.status(upstream.status);
      const type = upstream.headers.get('content-type')?.split(';')[0];
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) { await upstream.body?.cancel(); return res.status(502).end(); }
      res.set('Content-Type', type);
      // Every /api answer is "no-store" unless it says otherwise, which made the browser fetch each picture
      // again every time it scrolled into view. A picture's address changes when its art does (it carries
      // the art's version), so it can be kept; it is private to this viewer's browser.
      if (upstream.ok) res.set('Cache-Control', 'private, max-age=86400');
      // The address does not say whose picture it is, so the browser keeps one copy per session cookie: signing in as
      // someone else in the same browser asks again instead of being handed the last person's.
      res.vary('Cookie');
      if (upstream.body) pipeUpstream(upstream, res);
      else res.end();
    } catch {
      res.status(502).end();
    }
  }

  // ---- Sign-in routes -----------------------------------------------------

  // Plex's PIN sign-in and Home profile switching. Registered after core's
  // session and auth middleware; these paths are public in plex-auth.js.
  function registerRoutes(app, { rateLimit, endPlayback }) {
    app.use('/api/auth/plex/pin', rateLimit({ maximum: 10, windowMs: 600000 }));
    app.use(['/api/auth/plex/select-user', '/api/auth/switch-user', '/api/auth/plex/select-server', '/api/auth/plex/servers', '/api/auth/plex/switch-server'], rateLimit({ maximum: 20, windowMs: 600000 }));

    // Finishes a sign-in once the profile, and so its own token, is known. An account
    // whose servers answer more than one is asked to choose; with one answering it goes
    // straight there; an install with a single server never asks. `serverId` is a
    // choice already made. Listing never stops a sign-in: if it fails, the first
    // server that answers is used, as before.
    async function finishSignIn(res, { consume, login, accountToken, profileToken, profile, pinId, serverId = null, serverCount = 1 }) {
      let chosen = serverId;
      if (!chosen) {
        const list = await plexAuth.listServers(profileToken).catch(() => null);
        if (list?.ok && list.servers.length > 1) {
          serverCount = list.servers.length;
          const online = list.servers.filter((server) => server.online);
          if (!online.length) return res.json({ authenticated: false, pending: false, error: 'None of your Plex servers are reachable right now' });
          if (online.length === 1) {
            chosen = online[0].id;
          } else {
            // The choice's next request reads the profile's token back from the encrypted login cookie.
            login.remember(accountToken, { profileToken, serverCount, profile: { id: profile.id, title: profile.title, thumb: profile.thumb, admin: !!profile.admin } });
            return res.json({ authenticated: false, pending: false, needsServerSelection: true, pinId, servers: list.servers });
          }
        }
      }
      const resolved = await plexAuth.resolveServer(profileToken, chosen ? { serverId: chosen } : undefined);
      if (!resolved.ok) {
        return res.json({ authenticated: false, pending: false, error: resolved.error || 'This Plex account is not authorized for this server' });
      }
      // Use the per-server accessToken resolveServer found (see plex-auth.js), not the
      // profile's account token: PMS hub personalization needs the server-scoped token,
      // not one that merely proves identity (confirmed by direct testing -- the local
      // hub endpoints fall back to the server owner's data otherwise).
      await plexAuth.setSession(res, {
        accountToken, profileToken, userToken: resolved.accessToken || profileToken,
        title: profile.title, thumb: profile.thumb, profileId: profile.id, admin: profile.admin,
        plexUrl: resolved.plexUrl, machineIdentifier: resolved.machineIdentifier, serverName: resolved.serverName, serverCount,
      });
      consume();
      res.json({ authenticated: true });
    }

    app.post('/api/auth/plex/pin', async (req, res) => {
      try {
        res.json(await plexAuth.createPin(req, res));
      } catch (err) {
        res.status(502).json({ error: safeError(err) });
      }
    });

    // Poll Plex sign-in status; accounts with multiple Home profiles require selection.
    app.get('/api/auth/plex/poll', async (req, res) => {
      const pinId = req.query.id;
      if (typeof pinId !== 'string' || !/^\d+$/.test(pinId)) return res.status(400).json({ error: 'Valid id required' });
      try {
        await plexAuth.withLogin(req, res, pinId, async (consume, login) => {
          const accountToken = await plexAuth.checkPin(pinId);
          if (!accountToken) return res.json({ authenticated: false, pending: true });
          if (SIGN_IN_EMAIL && (await plexAuth.identityForToken(accountToken))?.confirmedEmail !== SIGN_IN_EMAIL) {
            // Deliberately vague: nothing about which account, or how it is chosen.
            return res.json({ authenticated: false, pending: false, error: 'This Plex account can\'t sign in to this server.' });
          }
          // The first time the owner signs in, this finds and saves the server's address;
          // later sign-ins keep that address current. (Not with a plugin choosing servers.)
          if (PLUGIN_CHOOSES_SERVER) {
            // Each viewer's server is chosen below; there is none to link.
          } else if (!owner.url) {
            try { await ownerLink.connect(accountToken); }
            catch (err) {
              // Server log only; the viewer gets the generic message below.
              console.warn(`Could not link the Plex server after sign-in: ${err?.message ?? err}${err?.cause?.code ? ` (${err.cause.code})` : ''}`);
              return res.json({ authenticated: false, pending: false, error: 'Signed in, but no Plex server owned by this account could be reached. Check that the server is online, then try again.' });
            }
          } else {
            await ownerLink.refresh(accountToken).catch(() => console.warn('Could not refresh the Plex server address'));
          }

          const users = await plexAuth.listHomeUsers(accountToken);
          if (!users.length) throw new Error('Unable to resolve account profiles');
          if (users.length > 1 || users[0]?.protected) {
            // The profile picker's next request reads the token back from the encrypted login cookie.
            login.remember(accountToken);
            // Place Guest after named profiles in the picker.
            const sortedUsers = [...users].sort((a, b) => (a.guest === b.guest ? 0 : a.guest ? 1 : -1));
            return res.json({
              authenticated: false,
              pending: false,
              needsUserSelection: true,
              pinId,
              users: sortedUsers.map((u) => ({ id: u.id, title: u.title, thumb: u.thumb, protected: u.protected, admin: u.admin })),
            });
          }

          // No Home picker here (single-user account).
          return finishSignIn(res, { consume, login, accountToken, profileToken: accountToken, profile: users[0], pinId });
        });
      } catch (err) {
        res.status(502).json({ error: safeError(err) });
      }
    });

    // Profile identity and display fields come exclusively from Plex.
    app.post('/api/auth/plex/select-user', async (req, res) => {
      const { pinId, userId, pin } = req.body || {};
      if (!pinId || !userId) return res.status(400).json({ error: 'pinId and userId required' });
      try {
        await plexAuth.withLogin(req, res, pinId, async (consume, login) => {
          const accountToken = login.accountToken;
          if (!accountToken) throw new Error('Sign-in session expired or invalid');
          const homeUsers = await plexAuth.listHomeUsers(accountToken);
          const picked = homeUsers.find((u) => u.id === String(userId));
          if (!picked) throw new Error('Invalid profile');
          // Same formula as clientIdForRequest -- the device this switch
          // registers with Plex must match what every later request for this
          // profile sends, or Plex's hub personalization falls back to
          // resolving via whichever account actually owns the request's
          // client identifier. See switchHomeUser's own comment.
          const switchedToken = await plexAuth.switchHomeUser(accountToken, userId, pin, `${CLIENT_ID}-${picked.id}`);
          return finishSignIn(res, { consume, login, accountToken, profileToken: switchedToken, profile: picked, pinId });
        });
      } catch (err) {
        res.status(safeError(err) === 'Incorrect PIN' ? 401 : 502).json({ error: safeError(err) });
      }
    });

    // Finishes a sign-in that was waiting for the viewer to choose a server. The choice
    // can only be one of the profile's own servers: the plugin looks it up on plex.tv.
    app.post('/api/auth/plex/select-server', async (req, res) => {
      const { pinId, serverId } = req.body || {};
      if (!pinId || typeof serverId !== 'string' || !serverId || serverId.length > 100) return res.status(400).json({ error: 'pinId and serverId required' });
      try {
        await plexAuth.withLogin(req, res, pinId, async (consume, login) => {
          const { accountToken, pending } = login;
          if (!accountToken || !pending) throw new Error('Sign-in session expired or invalid');
          await finishSignIn(res, { consume, login, accountToken, profileToken: pending.profileToken, profile: pending.profile, pinId, serverId, serverCount: pending.serverCount });
        });
      } catch (err) {
        res.status(502).json({ error: safeError(err) });
      }
    });

    // The servers this signed-in profile can switch between, and the one it is on.
    app.get('/api/auth/plex/servers', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await plexAuth.listServersForSession(req));
      } catch (err) {
        res.status(safeError(err) === 'Not authenticated' ? 401 : 502).json({ error: safeError(err) });
      }
    });

    // Moves this session to another of the profile's servers without a new sign-in.
    // Playback on the old server stops first.
    app.post('/api/auth/plex/switch-server', async (req, res) => {
      const { serverId } = req.body || {};
      if (typeof serverId !== 'string' || !serverId || serverId.length > 100) return res.status(400).json({ error: 'serverId required' });
      try {
        await endPlayback(req);
        await plexAuth.switchServerForSession(req, res, serverId);
        res.json({ ok: true });
      } catch (err) {
        const message = safeError(err);
        res.status(message === 'Not authenticated' ? 401 : 502).json({ error: message });
      }
    });

    // Switch Home profiles using the account token carried in the encrypted session cookie.
    app.get('/api/auth/home-users', async (req, res) => {
      try {
        const users = await plexAuth.listHomeUsersForSession(req);
        const sortedUsers = [...users].sort((a, b) => (a.guest === b.guest ? 0 : a.guest ? 1 : -1));
        res.json(sortedUsers);
      } catch (err) {
        res.status(safeError(err) === 'Not authenticated' ? 401 : 502).json({ error: safeError(err) });
      }
    });

    app.post('/api/auth/switch-user', async (req, res) => {
      const { userId, pin } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId required' });
      try {
        await endPlayback(req);
        await plexAuth.switchUserForSession(req, res, userId, pin);
        res.json({ ok: true });
      } catch (err) {
        const status = safeError(err) === 'Not authenticated' ? 401 : safeError(err) === 'Incorrect PIN' ? 401 : 502;
        res.status(status).json({ error: safeError(err) });
      }
    });

    // Proxy only validated Plex avatar URLs and allowed redirects.
    app.get('/api/auth/plex/avatar', async (req, res) => {
      try {
        const avatar = await fetchAvatar(req.query.url);
        res.set('Content-Type', avatar.type);
        res.set('Cache-Control', 'private, max-age=3600');
        res.send(avatar.body);
      } catch { res.status(502).end(); }
    });
  }

  // ---- Accounts -----------------------------------------------------------

  // Account keys are plex:<plex.tv account ID>; every Home profile shares one.
  const ACCOUNT_KEY = /^plex:([1-9][0-9]{0,31})$/;
  const accountView = (accountId, username) => ({
    key: `plex:${accountId}`,
    label: username || `Plex account ${accountId}`,
    detail: `Plex account ${accountId}`,
  });
  const accounts = {
    // Username, exact email or account ID. A bare ID is offered even before
    // that account has signed in, so a limit can be set ahead of time.
    async search(query) {
      // The ID a viewer copies from their watch-time panel is written plex:<ID>.
      const value = query.trim().replace(/^plex:(?=[1-9][0-9]{0,31}$)/i, '');
      const found = accountDirectory ? await accountDirectory.search(value) : [];
      const results = found.map(account => accountView(account.id, account.username));
      if (/^[1-9][0-9]{0,31}$/.test(value) && !found.some(account => account.id === value)) results.unshift(accountView(value));
      return results;
    },
    async list() {
      return accountDirectory ? (await accountDirectory.list()).map(account => accountView(account.id, account.username)) : [];
    },
    async describe(key) {
      const accountId = ACCOUNT_KEY.exec(key)?.[1];
      if (!accountId) return null;
      return accountView(accountId, (await accountDirectory?.get(accountId).catch(() => null))?.username);
    },
  };

  return {
    id,
    type: 'plex',
    name: 'Plex',
    accounts,
    // Plex item keys are numeric ratingKeys.
    isValidId: value => typeof value === 'string' && /^\d+$/.test(value),
    auth: plexAuth,
    registerRoutes,
    library(req) {
      const lib = libraryForRequest(req);
      return {
        libraries: () => lib.libraries(),
        libraryItems: (libraryId, options) => lib.libraryItems(libraryId, options),
        recentlyAdded: libraryId => lib.recentlyAdded(libraryId),
        showSeasons: showId => lib.showSeasons(showId),
        showEpisodes: showId => lib.showEpisodes(showId),
        seasonEpisodes: seasonId => lib.seasonEpisodes(seasonId),
        itemDetails: itemId => lib.itemDetails(itemId),
        subtitleTracks: itemId => lib.subtitleTracks(itemId),
        subtitleText: (itemId, trackId) => lib.subtitleText(itemId, trackId),
        playlists: () => lib.playlists(),
        playlistItems: playlistId => lib.playlistItems(playlistId),
        similarArtists: artistId => lib.similarArtists(artistId),
        popularTracks: artistId => lib.popularTracks(artistId),
        similarTracks: trackId => lib.similarTracks(trackId),
        lyricTracks: itemId => lib.lyricTracks(itemId),
        lyricText: (itemId, trackId) => lib.lyricText(itemId, trackId),
        search: query => lib.search(query),
        continueWatching: () => continueWatching(req),
      };
    },
    sendThumbnail,
    watchState: { reportProgress, markWatched, markUnwatched, watchedFraction: req => localProgress.finishedThreshold(serverIdForRequest(req)) },
    playback: {
      start: startStream,
      proxy: proxyMedia,
      stop: stopTranscode,
      // Whether the browser could fetch media straight from this server.
      directCapable: req => !!directPlexOrigin(plexAuth.getSessionPlexUrl(req) || owner.url),
      // The media origin the player page may load from directly, if any.
      mediaOrigin: req => directTokenForRequest(req) ? urlForRequest(req) : '',
    },
    // Plex helpers plugins received before sources existed; kept so older
    // plugins keep working. New plugins should use sourceFor(req).
    legacyPluginContext: { plexHeaders, tokenForRequest, urlForRequest, sessionProbeFor, rewriteManifest },
  };
}
