// Adapted from drive-in (server/index.js Plex API routes + server/plex-thumbnails.js),
// trimmed: no disk cache for thumbnails, no retry wrapper.

import { plexDeviceHeaders } from './plex-connection.js';
import { describeTrack, orderTracks, toWebVtt, readSubtitleText, TEXT_FORMATS, TRACK_ID } from './subtitles.js';
import { parseLyrics } from './lyrics.js';

const THUMBNAIL_PRESETS = {
  landscape: { width: 600, height: 338 },
  poster: { width: 390, height: 585 },
  backdrop: { width: 1280, height: 720 },
  // Music artwork is square, in the size it is shown: a track's row is 56 pixels, a card in a grid
  // about 150-200, and the cover on the player's screen is large. Asking Plex for more than is
  // shown makes it resize (and the viewer download) far more than needed.
  tiny: { width: 128, height: 128 },
  square: { width: 320, height: 320 },
  cover: { width: 512, height: 512 },
};

// Music, as sources present it (see sources.js): an artist holds albums and an album holds
// tracks, the way a show holds seasons and a season holds episodes.
const MUSIC_TYPES = new Set(['artist', 'album', 'track']);
// The pictures a page may ask for: an item's art, or a playlist's composite of its tracks' art.
const THUMBNAIL_PATH = /^\/(?:library\/metadata\/\d+\/(?:thumb|art|banner)|playlists\/\d+\/composite)(?:\/\d+)?$/;
const MUSIC_VIEWS = [{ id: 'artists', label: 'Artists' }, { id: 'albums', label: 'Albums' }, { id: 'tracks', label: 'Tracks' }];

export function createPlexLibrary({ plexUrl, token, clientId, productName = 'FreeStuffCrazy Player' }) {
  // Without a client identifier, two different profiles' requests are
  // indistinguishable to Plex beyond the token itself. For ordinary reads
  // that's fine, but hub/shelf endpoints like /hubs/sections/{id} (see
  // hubContinueWatching below) are exactly the kind of personalized,
  // possibly server-cached response where that ambiguity is risky --
  // sending a distinct, per-profile identifier removes it rather than
  // relying on Plex keying correctly off the token alone.
  async function plexApi(path) {
    const headers = { Accept: 'application/json', 'X-Plex-Token': token, ...plexDeviceHeaders(productName) };
    if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
    const res = await fetch(`${plexUrl}${path}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Plex API ${res.status}: ${res.statusText}`);
    return res.json();
  }

  // Plex can send an empty title for an item whose name it keeps only as the sort title (some albums); Plex's own
  // apps show that name, so this does too.
  const titleOf = (m) => m.title || m.titleSort || '';

  function thumbnailProxyUrl(path, preset = 'landscape') {
    if (!path) return null;
    const dimensions = THUMBNAIL_PRESETS[preset];
    const params = new URLSearchParams({ path, width: String(dimensions.width), height: String(dimensions.height) });
    return `/api/library/thumb?${params}`;
  }

  function thumbnailUpstreamUrl(path, width, height) {
    const plexBase = new URL(plexUrl);
    const source = new URL(path, plexBase);
    if (source.origin !== plexBase.origin || source.search || !THUMBNAIL_PATH.test(source.pathname)) throw new TypeError('Invalid Plex thumbnail path');
    const upstream = new URL('/photo/:/transcode', plexBase);
    upstream.searchParams.set('width', String(width));
    upstream.searchParams.set('height', String(height));
    upstream.searchParams.set('minSize', '1');
    upstream.searchParams.set('upscale', '0');
    upstream.searchParams.set('url', `${source.pathname}${source.search}`);
    return upstream;
  }

  async function libraries() {
    const data = await plexApi('/library/sections');
    // Plex calls a music library "artist"; sources call it "music". An "Other Videos" library is a film
    // library that uses no metadata agent (YouTube downloads, home videos): sources call it "video".
    const typeOf = (d) => (d.type === 'artist' ? 'music' : d.type === 'movie' && /\.none$/.test(d.agent || '') ? 'video' : d.type);
    return data.MediaContainer.Directory.map((d) => ({
      id: d.key, title: d.title, type: typeOf(d),
      // Ways to list a library besides its default (the first): see "Music" in PLUGIN_DEVELOPMENT.md.
      ...(d.type === 'artist' ? { views: MUSIC_VIEWS } : {}),
    }));
  }

  // A music library can be listed by artist, or straight to every album or every track.
  // Plex asks for those with a numeric type (9 albums, 10 tracks) on the section's /all.
  const VIEW_TYPES = { albums: 9, tracks: 10 };

  async function libraryItems(id, { sort = 'addedAt:desc', start = 0, size, view } = {}) {
    // Albums and tracks are left in Plex's own order (by artist, then album, then track), as Plex
    // Web lists them; a sort by title would scatter an artist's albums through the alphabet.
    const query = [
      VIEW_TYPES[view] ? `type=${VIEW_TYPES[view]}` : `sort=${encodeURIComponent(sort)}`,
      ...(size ? [`X-Plex-Container-Start=${start}`, `X-Plex-Container-Size=${size}`] : []),
    ].join('&');
    const data = await plexApi(`/library/sections/${encodeURIComponent(id)}/all?${query}`);
    if (view === 'tracks') return { total: data.MediaContainer.totalSize, items: (data.MediaContainer.Metadata || []).map(mapEpisode) };
    const items = (data.MediaContainer.Metadata || []).map((m) => {
      const media = m.Media?.[0];
      return {
        ratingKey: m.ratingKey,
        title: titleOf(m),
        // What the list is in the order of (an artist is under the surname: "Abbott, Gregory"), so the # A-Z bar
        // can put each letter where that order has it.
        sortTitle: m.titleSort || titleOf(m),
        year: m.year,
        type: m.type,
        thumbnail: thumbnailProxyUrl(m.thumb, MUSIC_TYPES.has(m.type) ? 'square' : 'poster'),
        duration: m.duration ? Math.round(m.duration / 60000) : null,
        durationMs: m.duration || null,
        viewOffset: m.viewOffset || 0,
        videoCodec: media?.videoCodec,
        audioCodec: media?.audioCodec,
        resolution: media ? `${media.width}x${media.height}` : null,
        childCount: m.childCount,
        leafCount: m.leafCount,
        viewedLeafCount: m.viewedLeafCount || 0,
        // An album listed on its own still belongs to an artist, which it opens under.
        ...(m.type === 'album' ? { showRatingKey: m.parentRatingKey, showTitle: m.parentTitle } : {}),
      };
    });
    return { total: data.MediaContainer.totalSize, items };
  }

  async function showEpisodes(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}/allLeaves`);
    return (data.MediaContainer.Metadata || []).map(mapEpisode);
  }

  function mapEpisode(m) {
    const media = m.Media?.[0];
    if (m.type === 'track') {
      return {
        ratingKey: m.ratingKey,
        type: 'track',
        title: titleOf(m),
        // Track number, and the disc when the album has several.
        episode: m.index,
        season: m.parentIndex,
        artist: m.originalTitle || m.grandparentTitle || null,
        album: m.parentTitle || null,
        duration: m.duration ? Math.round(m.duration / 60000) : null,
        durationMs: m.duration || null,
        viewOffset: m.viewOffset || 0,
        // The album's art first, so every track of an album shares one picture, fetched once.
        thumbnail: thumbnailProxyUrl(m.parentThumb || m.thumb || m.grandparentThumb, 'tiny'),
        audioCodec: media?.audioCodec,
      };
    }
    return {
      ratingKey: m.ratingKey,
      title: titleOf(m),
      season: m.parentIndex,
      episode: m.index,
      duration: m.duration ? Math.round(m.duration / 60000) : null,
      durationMs: m.duration || null,
      viewOffset: m.viewOffset || 0,
      thumbnail: thumbnailProxyUrl(m.thumb, 'landscape'),
      videoCodec: media?.videoCodec,
    };
  }

  // A show's direct children are its seasons.
  async function showSeasons(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}/children`);
    const mapAlbum = (m, group = null) => ({
      ratingKey: m.ratingKey,
      // An artist's children are albums.
      type: m.type === 'album' ? 'album' : 'season',
      title: titleOf(m),
      index: m.index,
      year: m.year,
      showRatingKey: m.parentRatingKey,
      showTitle: m.parentTitle,
      thumbnail: thumbnailProxyUrl(m.thumb, m.type === 'album' ? 'square' : 'poster'),
      leafCount: m.leafCount,
      viewedLeafCount: m.viewedLeafCount || 0,
      ...(group ? { group } : {}),
    });
    const items = (data.MediaContainer.Metadata || []).map((m) => mapAlbum(m));
    // Plex keeps an artist's compilations, singles and EPs, live albums, soundtracks, demos and remixes in sections of
    // their own (the artist's "related" hubs) rather than among its children, so an artist with only those has no
    // albums above. They are listed after the others; a failure to read them just leaves them out.
    try {
      const related = await plexApi(`/library/metadata/${encodeURIComponent(id)}/related?includeAugmentations=1&includeMeta=1`);
      const seen = new Set(items.map((item) => String(item.ratingKey)));
      for (const hub of related.MediaContainer?.Hub || []) {
        if (!String(hub.hubIdentifier || '').startsWith('artist.albums.')) continue;
        for (const m of hub.Metadata || []) {
          if (m.type !== 'album' || seen.has(String(m.ratingKey))) continue;
          seen.add(String(m.ratingKey));
          items.push(mapAlbum(m, hub.title));
        }
      }
    } catch { /* just the albums above */ }
    return items;
  }

  // A season's direct children are its episodes.
  async function seasonEpisodes(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}/children`);
    return (data.MediaContainer.Metadata || []).map(mapEpisode);
  }

  // Full metadata for the details screen shown before a fresh (non-resume) play.
  async function itemDetails(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}`);
    const m = (data.MediaContainer.Metadata || [])[0];
    if (!m) throw new Error('Item not found');
    const media = m.Media?.[0];
    return {
      ratingKey: m.ratingKey,
      type: m.type,
      librarySectionId: m.librarySectionID != null ? String(m.librarySectionID) : null,
      title: titleOf(m),
      showTitle: m.grandparentTitle || null,
      // Keep season and show references for next-up reconstruction.
      parentKey: m.parentKey || null,
      grandparentKey: m.grandparentKey || null,
      season: m.parentIndex,
      episode: m.index,
      year: m.year,
      summary: m.summary || '',
      contentRating: m.contentRating || null,
      audienceRating: m.audienceRating || m.rating || null,
      genres: (m.Genre || []).map((g) => g.tag),
      duration: m.duration ? Math.round(m.duration / 60000) : null,
      durationMs: m.duration || null,
      viewOffset: m.viewOffset || 0,
      // A track's cover is its album's, large because the player shows it that way.
      thumbnail: thumbnailProxyUrl(m.type === 'track' ? (m.parentThumb || m.thumb) : m.thumb, m.type === 'track' ? 'cover' : MUSIC_TYPES.has(m.type) ? 'square' : 'poster'),
      backdrop: thumbnailProxyUrl(m.art || m.thumb, 'backdrop'),
      // Music: who and what a track is part of (an album's own artist is its showTitle).
      ...(m.type === 'track' ? { artist: m.originalTitle || m.grandparentTitle || null, album: m.parentTitle || null } : {}),
      videoCodec: media?.videoCodec,
      resolution: media ? `${media.width}x${media.height}` : null,
    };
  }

  // An item's subtitle streams. One Plex can hand over as a text file (an external
  // SubRip file) is `text`; the rest, including every one inside the video file, can
  // only be drawn into the picture by the transcoder, so they are `burn`.
  async function subtitlePart(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}`);
    const part = data.MediaContainer.Metadata?.[0]?.Media?.[0]?.Part?.[0];
    return { partId: part?.id, streams: (part?.Stream || []).filter(stream => stream.streamType === 3 && TRACK_ID.test(String(stream.id))) };
  }

  async function subtitleStreams(id) {
    return (await subtitlePart(id)).streams;
  }

  // Plex burns in the subtitle chosen on the file for the account playing it, not the one a
  // transcode request names, so a track to burn is chosen there first, as Plex's own apps do.
  // Plex's other apps then show that choice for this item too.
  async function selectSubtitle(id, trackId) {
    const { partId, streams } = await subtitlePart(id);
    const stream = streams.find(candidate => String(candidate.id) === String(trackId));
    if (!stream || !TRACK_ID.test(String(partId)) || stream.selected === true || stream.selected === 1) return;
    const headers = { 'X-Plex-Token': token, ...plexDeviceHeaders(productName) };
    if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
    const params = new URLSearchParams({ subtitleStreamID: String(stream.id), allParts: '1' });
    const res = await fetch(`${plexUrl}/library/parts/${partId}?${params}`, { method: 'PUT', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`Plex subtitle selection ${res.status}`);
  }

  // Plex's longer title says which file a track is in, "English (SRT External)" next to
  // "English (SRT)". A track with no title of its own gets one like " (English SRT)", which reads
  // worse than the short one.
  const subtitleLabel = stream => {
    const extended = String(stream.extendedDisplayTitle || '').trim();
    return extended && !extended.startsWith('(') ? extended : stream.displayTitle || extended || stream.language;
  };

  async function subtitleTracks(id) {
    return orderTracks((await subtitleStreams(id)).map(stream => describeTrack({
      id: stream.id,
      label: subtitleLabel(stream),
      language: stream.languageCode || stream.languageTag,
      kind: typeof stream.key === 'string' && stream.key.startsWith('/library/streams/') && TEXT_FORMATS.has(String(stream.codec || stream.format).toLowerCase()) ? 'text' : 'burn',
      forced: stream.forced === true || stream.forced === 1,
      isDefault: stream.default === true || stream.default === 1,
    })));
  }

  // A text track as WebVTT. Only one of this item's own streams can be asked for.
  async function subtitleText(id, trackId) {
    const stream = (await subtitleStreams(id)).find(candidate => String(candidate.id) === String(trackId));
    if (!stream || typeof stream.key !== 'string' || !stream.key.startsWith('/library/streams/')
      || !TEXT_FORMATS.has(String(stream.codec || stream.format).toLowerCase())) return null;
    const headers = { 'X-Plex-Token': token, ...plexDeviceHeaders(productName) };
    if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
    const res = await fetch(`${plexUrl}${stream.key}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Plex subtitle ${res.status}`); }
    return toWebVtt(await readSubtitleText(res));
  }

  // A track's lyrics. Plex keeps each set as a stream of type 4 on the track's file: one from a
  // lyrics provider, which has times for each line, and maybe one embedded in the file.
  async function lyricStreams(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}`);
    const media = data.MediaContainer.Metadata?.[0]?.Media || [];
    return media.flatMap(entry => (entry.Part || []).flatMap(part => part.Stream || []))
      .filter(stream => stream.streamType === 4 && TRACK_ID.test(String(stream.id)));
  }

  const lyricsLabel = stream => {
    const provider = String(stream.provider || '');
    if (/lyricfind/i.test(provider)) return 'LyricFind';
    if (/musixmatch/i.test(provider)) return 'Musixmatch';
    return String(stream.displayTitle || stream.title || (provider ? 'Lyrics' : 'Embedded')).slice(0, 60);
  };

  async function lyricTracks(id) {
    return (await lyricStreams(id)).map(stream => ({
      id: String(stream.id),
      label: lyricsLabel(stream),
      // A set with times for its lines can follow the song.
      timed: stream.timed === true || stream.timed === 1 || stream.timed === '1' || String(stream.format || '').toLowerCase() === 'lrc',
    }));
  }

  // One set of lyrics as { timed, lines }. Only one of this track's own lyric streams can be asked for.
  async function lyricText(id, trackId) {
    const stream = (await lyricStreams(id)).find(candidate => String(candidate.id) === String(trackId));
    if (!stream) return null;
    const headers = { 'X-Plex-Token': token, ...plexDeviceHeaders(productName) };
    if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
    // Plex Web asks for the XML form, which carries the timing of each line.
    for (const query of ['?format=xml', '']) {
      const res = await fetch(`${plexUrl}/library/streams/${encodeURIComponent(stream.id)}${query}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!res.ok) { await res.body?.cancel(); continue; }
      return parseLyrics(await readSubtitleText(res));
    }
    throw new Error('Plex lyrics unavailable');
  }

  // Playlists of music, as a list of playlists and then the tracks of one. (Plex keeps playlists on the
  // server, not in a library.)
  async function playlists() {
    const data = await plexApi('/playlists?playlistType=audio');
    return (data.MediaContainer.Metadata || []).map((m) => ({
      ratingKey: String(m.ratingKey),
      type: 'playlist',
      title: titleOf(m),
      thumbnail: thumbnailProxyUrl(m.composite || m.thumb, 'square'),
      leafCount: m.leafCount,
      duration: m.duration ? Math.round(m.duration / 60000) : null,
      durationMs: m.duration || null,
    }));
  }

  async function playlistItems(id) {
    const data = await plexApi(`/playlists/${encodeURIComponent(id)}/items`);
    // A playlist's tracks are numbered by their place in it, not by their number on their album.
    return (data.MediaContainer.Metadata || []).filter((m) => m.type === 'track').map((m, index) => ({ ...mapEpisode(m), episode: index + 1, season: null }));
  }

  // An artist's most played tracks, as Plex Web's "Popular Tracks": from the artist's own list of them,
  // else from the artist's details when they carry it.
  async function popularTracks(id) {
    const asTracks = (list) => (Array.isArray(list) ? list : list?.Metadata || [])
      .filter((m) => m && m.type === 'track' && /^\d+$/.test(String(m.ratingKey)))
      .slice(0, 20).map((m, index) => ({ ...mapEpisode(m), episode: index + 1, season: null }));
    const direct = await plexApi(`/library/metadata/${encodeURIComponent(id)}/popularLeaves`).then((data) => asTracks(data.MediaContainer.Metadata)).catch(() => []);
    if (direct.length) return direct;
    const details = await plexApi(`/library/metadata/${encodeURIComponent(id)}?includePopularLeaves=1`).catch(() => null);
    return asTracks(details?.MediaContainer?.Metadata?.[0]?.PopularLeaves);
  }

  // Tracks that sound like this one (Plex's sonic analysis of the library), nearest first. Plex answers with
  // nothing for a library it has not analysed, which is just no list.
  async function similarTracks(id) {
    const data = await plexApi(`/library/metadata/${encodeURIComponent(id)}/nearest?limit=40&maxDistance=0.25`).catch(() => null);
    return (data?.MediaContainer?.Metadata || [])
      .filter((m) => m && m.type === 'track' && /^\d+$/.test(String(m.ratingKey)) && String(m.ratingKey) !== String(id))
      .slice(0, 40).map((m) => ({ ...mapEpisode(m), season: null }));
  }

  // Artists like this one: those Plex relates it to in the library, and those that sound like it.
  async function similarArtists(id) {
    const toArtist = (m) => ({ ratingKey: String(m.ratingKey), type: 'artist', title: titleOf(m), thumbnail: thumbnailProxyUrl(m.thumb, 'square'), leafCount: m.leafCount });
    const usable = (m) => m && m.type === 'artist' && /^\d+$/.test(String(m.ratingKey)) && String(m.ratingKey) !== String(id);
    const sections = [];
    const [similar, related] = await Promise.all([
      plexApi(`/library/metadata/${encodeURIComponent(id)}/similar?count=50`).catch(() => null),
      plexApi(`/library/metadata/${encodeURIComponent(id)}/related`).catch(() => null),
    ]);
    const seen = new Set();
    const add = (title, metadata) => {
      const items = (metadata || []).filter(usable).filter((m) => !seen.has(String(m.ratingKey))).map(toArtist);
      items.forEach((item) => seen.add(item.ratingKey));
      if (items.length) sections.push({ title, items });
    };
    add('Similar Artists', similar?.MediaContainer?.Metadata);
    // A hub of artists that sound alike (Plex's sonic analysis), under whatever name Plex gives it.
    for (const hub of related?.MediaContainer?.Hub || []) {
      if (/sonic/i.test(`${hub.hubIdentifier || ''} ${hub.title || ''}`)) add('Sonically Similar Artists', hub.Metadata);
    }
    return sections;
  }

  // Normalize section hubs, including seasons mixed into Recently Added.
  function mapHubItem(m) {
    const isEpisode = m.type === 'episode';
    // A season of a show, or an album of an artist: both belong to something above them.
    const isSeason = m.type === 'season' || m.type === 'album';
    return {
      ratingKey: m.ratingKey,
      type: m.type,
      librarySectionId: m.librarySectionID != null ? String(m.librarySectionID) : null,
      title: titleOf(m),
      year: m.year,
      season: isEpisode ? m.parentIndex : undefined,
      episode: isEpisode ? m.index : undefined,
      showTitle: isEpisode ? m.grandparentTitle : (isSeason ? m.parentTitle : undefined),
      showRatingKey: isSeason ? m.parentRatingKey : undefined,
      thumbnail: thumbnailProxyUrl(m.thumb, isEpisode ? 'landscape' : MUSIC_TYPES.has(m.type) ? 'square' : 'poster'),
      duration: m.duration ? Math.round(m.duration / 60000) : null,
      durationMs: m.duration || null,
      viewOffset: m.viewOffset || 0,
      leafCount: m.leafCount,
      viewedLeafCount: m.viewedLeafCount || 0,
    };
  }

  async function sectionHubItems(sectionId, pattern, { count = 12 } = {}) {
    const data = await plexApi(`/hubs/sections/${encodeURIComponent(sectionId)}?count=${count}&includeMeta=1`);
    const hub = (data.MediaContainer.Hub || []).find((h) => pattern.test(h.hubIdentifier || ''));
    return hub?.Metadata || [];
  }

  // Read section-level Continue Watching with the requesting profile’s token.
  async function hubContinueWatching() {
    const sectionsData = await plexApi('/library/sections');
    const sectionIds = (sectionsData.MediaContainer.Directory || [])
      .filter((d) => d.type === 'movie' || d.type === 'show')
      .map((d) => d.key);

    const results = [];
    for (const id of sectionIds) {
      try {
        const items = await sectionHubItems(id, /inprogress/i);
        for (const m of items) results.push({ ...mapHubItem(m), lastViewedAt: m.lastViewedAt || 0 });
      } catch {
        // One section's hub lookup failed -- skip it, same as other
        // best-effort spots, rather than losing every other section's.
      }
    }
    results.sort((a, b) => b.lastViewedAt - a.lastViewedAt);
    return results.map(({ lastViewedAt, ...rest }) => rest);
  }

  // Read Recently Added from the section’s hubs.
  async function recentlyAdded(sectionId, { count = 12 } = {}) {
    const items = await sectionHubItems(sectionId, /recentlyadded/i, { count });
    return items.map(mapHubItem);
  }

  // PMS account IDs may differ from Home IDs; use stable IDs or explicit mappings.
  async function accounts() {
    const data = await plexApi('/accounts');
    return (data.MediaContainer.Account || []).map((a) => ({ id: String(a.id), name: a.name }));
  }

  // Read completed playback history scoped to a PMS account ID.
  async function historyForAccount(accountId, { limit = 100 } = {}) {
    const data = await plexApi(`/status/sessions/history/all?accountID=${encodeURIComponent(accountId)}&sort=viewedAt:desc&X-Plex-Container-Size=${limit}`);
    return data.MediaContainer.Metadata || [];
  }

  function parseMetadataId(key) {
    const m = /\/library\/metadata\/(\d+)/.exec(key || '');
    return m ? m[1] : null;
  }

  // Reconstruct next-up from completed episodes, merging Plex history with local
  // completions and keeping the newest record per show.
  async function continueWatchingForAccount(accountId, { limit = 20, localFinished = {} } = {}) {
    const history = await historyForAccount(accountId, { limit: 200 });

    const perShow = new Map(); // grandparentKey -> { parentKey, ratingKey, grandparentTitle, librarySectionId, updatedAt }
    for (const entry of history) {
      if (entry.type !== 'episode' || !entry.grandparentKey) continue;
      if (perShow.has(entry.grandparentKey)) continue; // sorted desc -- first hit is newest
      perShow.set(entry.grandparentKey, {
        parentKey: entry.parentKey,
        ratingKey: entry.ratingKey,
        grandparentTitle: entry.grandparentTitle,
        librarySectionId: entry.librarySectionID,
        updatedAt: entry.viewedAt * 1000, // Plex history timestamps are in seconds
      });
    }
    for (const [grandparentKey, local] of Object.entries(localFinished)) {
      const existing = perShow.get(grandparentKey);
      if (!existing || local.updatedAt > existing.updatedAt) {
        perShow.set(grandparentKey, {
          parentKey: local.parentKey,
          ratingKey: local.ratingKey,
          grandparentTitle: local.grandparentTitle,
          librarySectionId: local.librarySectionId,
          updatedAt: local.updatedAt,
        });
      }
    }

    const candidates = [...perShow.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);

    const results = [];
    for (const entry of candidates) {
      const seasonId = parseMetadataId(entry.parentKey);
      if (!seasonId) continue;
      try {
        const episodes = await seasonEpisodes(seasonId);
        const idx = episodes.findIndex((e) => e.ratingKey === entry.ratingKey);
        const next = idx >= 0 ? episodes[idx + 1] : null;
        if (!next) continue;
        results.push({
          ...next,
          type: 'episode',
          librarySectionId: entry.librarySectionId != null ? String(entry.librarySectionId) : null,
          showTitle: entry.grandparentTitle,
          viewOffset: 0,
        });
      } catch {
        // Season/episode lookup failed (deleted since watched, etc) -- skip.
      }
    }
    return results;
  }

  async function search(query) {
    const data = await plexApi(`/hubs/search?query=${encodeURIComponent(query)}&limit=10`);
    const results = [];
    for (const hub of data.MediaContainer.Hub || []) {
      for (const m of hub.Metadata || []) {
        results.push({
          ratingKey: m.ratingKey,
          title: titleOf(m),
          year: m.year,
          type: m.type,
          thumbnail: thumbnailProxyUrl(m.thumb, MUSIC_TYPES.has(m.type) ? 'square' : 'poster'),
        });
      }
    }
    return results;
  }

  return {
    subtitleTracks, subtitleText, selectSubtitle, lyricTracks, lyricText, playlists, playlistItems, similarArtists, popularTracks, similarTracks,
    libraries, libraryItems, showEpisodes, showSeasons, seasonEpisodes, itemDetails, hubContinueWatching, recentlyAdded, search, thumbnailUpstreamUrl,
    accounts, historyForAccount, continueWatchingForAccount,
  };
}
