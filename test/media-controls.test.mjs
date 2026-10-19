import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../media-controls.js', import.meta.url), 'utf8');

function fixture({ host = 'music.youtube.com', paused = false, ad = false, wrapper = false, mse = false, fetch, background = false } = {}) {
    const calls = [];
    const response = { videoDetails: { videoId: 'clip', title: 'Fixture clip', thumbnail: { thumbnails: [
        { url: 'https://i.ytimg.com/vi/clip/small.jpg', width: 320 },
        { url: 'https://i.ytimg.com/vi/clip/medium.jpg', width: 800 },
        { url: 'https://i.ytimg.com/vi/clip/large.jpg', width: 1920 }
    ] } }, streamingData: { formats: [{ itag: 18 }] } };
    class FixtureMedia {
        play() { this.playCalls = (this.playCalls || 0) + 1; this.paused = false; return Promise.resolve(); }
        get duration() { return this.nativeDuration ?? NaN; }
        addEventListener(type, listener, options) {
            const listeners = this.listeners.get(type) || new Map();
            listeners.set(listener, options);
            this.listeners.set(type, listeners);
        }
        removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
        dispatchEvent(event) {
            this.events.push(event.type);
            for (const [listener, options] of [...(this.listeners.get(event.type) || [])]) {
                if (options?.once) this.removeEventListener(event.type, listener);
                listener(event);
            }
        }
    }
    const media = Object.assign(new FixtureMedia(), { paused, videoWidth: 854, readyState: 4, events: [], listeners: new Map() });
    if (background) Object.assign(media, { isConnected: true, ended: false, currentSrc: 'blob:clip', userHitPause: false });
    const stats = { fmt: '244', afmt: '251' };
    const images = [];
    const timers = new Map();
    const timeouts = new Map();
    let nextTimer = 0;
    const nativeState = { player: { audioOnly: false, adPlaying: ad } };
    const renderer = { navigationEndpoint: { watchEndpoint: { videoId: 'clip', playlistId: 'queue', playerParams: 'original' } } };
    const controller = {
        store: {
            getState: () => nativeState,
            dispatch: action => { nativeState.player.audioOnly = action.payload; calls.push(action); }
        },
        queue: {
            getItems: () => [wrapper
                ? { playlistPanelVideoWrapperRenderer: { primaryRenderer: { playlistPanelVideoRenderer: renderer } } }
                : { playlistPanelVideoRenderer: renderer }],
            getCurrentItemIndex: () => 0
        }
    };
    const api = {
        getPlayerResponse: () => response,
        getCurrentTime: () => 92.5,
        getVideoStats: () => stats,
        querySelector: () => media,
        classList: { contains: () => false },
        appendChild: image => { image.isConnected = true; image.parentElement = api; },
        getAvailableQualityLevels: () => ['tiny', 'medium', 'auto'],
        loadVideoByPlayerVars: variables => calls.push(variables),
        setPlaybackQualityRange: (...args) => calls.push(args)
    };
    const windowListeners = [];
    const documentListeners = [];
    const windowEvents = [];
    const context = vm.createContext({
        ...(mse ? { ManagedMediaSource: class {} } : {}),
        ...(fetch ? { fetch } : {}),
        location: { hostname: host, href: 'https://' + host + '/watch?v=clip' },
        addEventListener: (type, listener, options) => windowListeners.push({ type, listener, options }),
        removeEventListener: (type, listener) => {
            const index = windowListeners.findIndex(entry => entry.type === type && entry.listener === listener);
            if (index >= 0) windowListeners.splice(index, 1);
        },
        dispatchEvent: event => { windowEvents.push(event); return true; },
        URL,
        HTMLMediaElement: FixtureMedia,
        HTMLVideoElement: FixtureMedia,
        __anyPWABackgroundMedia: background,
        Event,
        AbortController,
        setTimeout: callback => { const id = ++nextTimer; timeouts.set(id, callback); return id; },
        clearTimeout: id => timeouts.delete(id),
        setInterval: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearInterval: id => timers.delete(id),
        document: {
            hasFocus: () => context.focused !== false,
            addEventListener: (type, listener, options) => documentListeners.push({ type, listener, options }),
            removeEventListener: (type, listener) => {
                const index = documentListeners.findIndex(entry => entry.type === type && entry.listener === listener);
                if (index >= 0) documentListeners.splice(index, 1);
            },
            getElementById: () => api,
            createElement: () => {
                const image = { style: {}, isConnected: false,
                    setAttribute() {}, remove() { this.isConnected = false; this.parentElement = null; } };
                images.push(image);
                return image;
            },
            querySelector: selector => selector === 'ytmusic-player'
                ? { 'JSC$changed_playerController': controller }
                : media
        }
    });
    context.window = context;
    vm.runInContext(source, context);
    return { controls: context.__anyPWAMediaControls, context, calls, api, response, nativeState, renderer, media, stats, images, timers, timeouts, windowListeners, windowEvents, documentListeners };
}

const hlsMaster = 'https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1791845947/id/clip/itag/0/source/youtube/playlist/index.m3u8';
const hlsPlaylist = itag => 'https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1791845947/id/clip/itag/' + itag + '/source/youtube/playlist/index.m3u8';
const hlsVideo = [[160, 256, 144, 'avc1.4D400C'], [134, 640, 360, 'avc1.4D401E'], [136, 1280, 720, 'avc1.4D401F'], [137, 1920, 1080, 'avc1.640028']];
// Shape of the VISIONOS master: HE-AAC (233) and AAC-LC (234) groups, AVC renditions and VP9 duplicates.
const hlsManifest = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:URI="' + hlsPlaylist(233) + '",TYPE=AUDIO,GROUP-ID="233",NAME="Default",DEFAULT=YES,AUTOSELECT=YES',
    '#EXT-X-MEDIA:URI="' + hlsPlaylist(234) + '",TYPE=AUDIO,GROUP-ID="234",NAME="Default",DEFAULT=YES,AUTOSELECT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=192117,CODECS="avc1.4D400C,mp4a.40.5",RESOLUTION=256x144,FRAME-RATE=30,VIDEO-RANGE=SDR,AUDIO="233",CLOSED-CAPTIONS=NONE',
    hlsPlaylist(160),
    ...hlsVideo.flatMap(([itag, width, height, codec]) => [
        '#EXT-X-STREAM-INF:BANDWIDTH=' + height * 3000 + ',CODECS="' + codec + ',mp4a.40.2",RESOLUTION=' + width + 'x' + height
            + ',FRAME-RATE=30,VIDEO-RANGE=SDR,AUDIO="234",CLOSED-CAPTIONS=NONE',
        hlsPlaylist(itag)]),
    '#EXT-X-STREAM-INF:BANDWIDTH=2573381,CODECS="vp09.00.40.08,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30,VIDEO-RANGE=SDR,AUDIO="234",CLOSED-CAPTIONS=NONE',
    hlsPlaylist(248)
].join('\n');
const qualityOf = height => ({ 144: 'tiny', 360: 'medium', 720: 'hd720', 1080: 'hd1080' })[height];

// WebKit without MediaSource (Mac): the website response offers only progressive 360p. The player
// model plays whatever response it was loaded with, but like YouTube's own player it soon reports
// the website's original response again from getPlayerResponse().
function hlsFixture({ host = 'm.youtube.com', paused = false, playerState } = {}) {
    const f = fixture({ host, paused });
    const progressive = 'https://r.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4';
    f.response.streamingData = { expiresInSeconds: '21540', formats: [{ itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', url: progressive }] };
    f.response.playerConfig = { audioConfig: { loudnessDb: -3 } };
    Object.assign(f.media, { currentSrc: progressive, currentTime: 92.5, videoWidth: 640, videoHeight: 360, readyState: 4,
        canPlayType: type => type.includes('vp09') ? '' : 'probably' });
    f.stats.fmt = '18';
    let current = f.response;
    const show = height => Object.assign(f.media, { videoWidth: Math.round(height * 16 / 9), videoHeight: height });
    f.api.getPlayerResponse = () => f.response;
    f.api.getCurrentTime = () => f.media.currentTime;
    if (playerState !== undefined) f.api.getPlayerState = () => playerState;
    f.api.getAvailableQualityLevels = () => current.streamingData?.hlsFormats
        ? [...current.streamingData.hlsFormats.filter(format => format.height).map(format => qualityOf(format.height)).reverse(), 'auto']
        : ['medium', 'auto'];
    f.api.setPlaybackQualityRange = (low, high) => {
        f.calls.push(['quality', low, high]);
        const format = current.streamingData?.hlsFormats?.find(format => qualityOf(format.height) === low);
        if (format) { show(format.height); f.stats.fmt = String(format.itag); }
    };
    f.api.loadVideoByPlayerVars = variables => {
        f.calls.push(variables);
        current = JSON.parse(variables.player_response);
        const data = current.streamingData;
        Object.assign(f.media, { readyState: 1, currentTime: variables.start, paused: variables.pause_at_start });
        // Every load starts on the automatic master; suggested qualities are not read.
        if (data.hlsFormats) {
            f.media.currentSrc = 'data:application/x-mpegurl;charset=utf-8,%23EXTM3U';
            show(360);
            f.stats.fmt = '93';
        } else if (data.hlsManifestUrl) {
            f.media.currentSrc = data.hlsManifestUrl + '?cpn=fixture&ibw=1369843';
            show(0);
            f.stats.fmt = '93';
        }
    };
    f.lookups = [];
    f.fetches = [];
    f.context.ytcfg = { get: () => ({ client: { visitorData: 'guest-visitor', hl: 'en' } }) };
    f.context.fetch = async (url, options) => {
        if (url === '/youtubei/v1/player') {
            f.lookups.push(options);
            return { ok: true, text: async () => JSON.stringify({ playabilityStatus: { status: 'OK' },
                videoDetails: { videoId: JSON.parse(options.body).videoId }, streamingData: { hlsManifestUrl: hlsMaster } }) };
        }
        f.fetches.push({ url, signal: options.signal });
        return { ok: true, text: async () => hlsManifest };
    };
    f.tick = () => { for (const callback of [...f.timers.values()]) callback(); };
    f.ready = () => { f.media.readyState = 4; f.tick(); };
    f.loads = () => f.calls.filter(call => call.player_response);
    f.current = () => current;
    return f;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('inactive controls preserve website audio mode and quality without timers or player writes', () => {
    for (const host of ['music.youtube.com', 'm.youtube.com']) {
        const f = fixture({ host, mse: true });
        f.nativeState.player.audioOnly = true;
        f.response.playerConfig = { audioConfig: { playAudioOnly: false } };
        f.controls.disable();
        for (const entry of f.documentListeners.filter(entry => entry.type === 'loadeddata' || entry.type === 'playing')) {
            entry.listener({ target: f.media });
        }
        assert.equal(f.timers.size, 0);
        assert.equal(f.timeouts.size, 0);
        assert.deepEqual(f.calls, []);
        assert.equal(f.nativeState.player.audioOnly, true);
        const parsed = vm.runInContext('JSON.parse(\'{"playerConfig":{"audioConfig":{"playAudioOnly":false}},"videoDetails":{"videoId":"next"}}\')', f.context);
        assert.equal(parsed.playerConfig.audioConfig.playAudioOnly, false);
        assert.equal(f.windowListeners.filter(entry => entry.type === 'pointerdown').length, 1);
    }
});

test('inactive controls pass through the website player response unchanged', async () => {
    const response = { json: async () => ({ videoDetails: { videoId: 'next' },
        playerConfig: { audioConfig: { playAudioOnly: false } } }) };
    const promise = Promise.resolve(response);
    const f = fixture({ host: 'm.youtube.com', mse: true, fetch: () => promise });
    f.controls.disable();
    const reply = f.context.fetch('/youtubei/v1/player');
    assert.equal(reply, promise);
    assert.equal(await reply, response);
    assert.equal((await response.json()).playerConfig.audioConfig.playAudioOnly, false);
    assert.deepEqual(f.calls, []);
});

test('disabling active controls preserves playback and later website choices, and can be reenabled', () => {
    const f = fixture({ paused: true });
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    const before = f.calls.length;
    f.controls.disable();
    assert.equal(f.calls.length, before);
    assert.equal(f.nativeState.player.audioOnly, true);
    assert.equal(f.media.paused, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.images.filter(image => image.isConnected).length, 0);
    f.nativeState.player.audioOnly = false;
    for (const entry of f.documentListeners.filter(entry => entry.type === 'loadeddata' || entry.type === 'playing')) {
        entry.listener({ target: f.media });
    }
    for (const callback of [...f.timeouts.values()]) callback();
    assert.equal(f.calls.length, before);
    assert.equal(f.nativeState.player.audioOnly, false);
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    assert.equal(f.nativeState.player.audioOnly, true);
    assert.ok(f.calls.length > before);
    f.controls.dispose();
});

test('disabling controls cancels a pending HLS lookup and ignores its late response', async () => {
    const f = hlsFixture();
    let complete;
    let signal;
    f.context.fetch = (_, options) => {
        signal = options.signal;
        return new Promise(resolve => { complete = resolve; });
    };
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    assert.ok(signal);
    f.controls.disable();
    assert.equal(signal.aborted, true);
    complete({ ok: true, text: async () => JSON.stringify({ playabilityStatus: { status: 'OK' },
        videoDetails: { videoId: 'clip' }, streamingData: { hlsManifestUrl: hlsMaster } }) });
    await settle();
    await settle();
    assert.equal(f.loads().length, 0);
    assert.equal(f.fetches.length, 0);
    assert.deepEqual(f.calls, []);
    assert.equal(f.timers.size, 0);
});

function stalledStartupFixture(storage = new Map()) {
    const f = fixture({ host: 'm.youtube.com' });
    let now = 10000;
    f.context.Date = { now: () => now };
    f.context.location.href = 'https://m.youtube.com/watch?v=ybNP3CRv7Ds&list=original';
    f.context.location.replace = url => { f.calls.push('reload'); f.context.location.href = url; };
    f.context.sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
    f.response.videoDetails.videoId = 'ybNP3CRv7Ds';
    f.response.playabilityStatus = { status: 'OK' };
    f.api.getPlayerState = () => 3;
    Object.assign(f.media, { readyState: 0, networkState: 0, currentTime: 0, currentSrc: '', getAttribute: () => null });
    f.tick = milliseconds => { now += milliseconds; for (const callback of f.timers.values()) callback(); };
    f.controls.configure({ audioOnly: false, quality: 'auto' });
    return f;
}

test('media configuration never reloads the page for buffering or missing sources', () => {
    for (const change of [
        () => {},
        f => { f.media.currentSrc = 'https://example.test/video.mp4'; },
        f => { f.media.networkState = 2; },
        f => { f.media.currentTime = 10; },
        f => { f.context.location.href = 'https://m.youtube.com/watch?v=other_video'; },
        f => { f.context.location.hostname = 'music.youtube.com'; },
        f => { f.response.playabilityStatus.status = 'UNPLAYABLE'; },
        f => { f.context.sessionStorage.setItem = () => { throw new Error('Storage denied'); }; }
    ]) {
        const f = stalledStartupFixture();
        change(f);
        f.tick(9000);
        assert.deepEqual(f.calls, []);
    }
});

test('document-start configuration remains safe before the website creates its player', () => {
    const f = fixture();
    f.context.document.getElementById = () => null;
    f.context.document.querySelector = () => null;
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: message => publications.push(message) } } };
    assert.doesNotThrow(() => f.controls.configure({ audioOnly: false, quality: 'hd1080' }));
    assert.equal(publications.at(-1).status, 'waiting');
});

test('changing quality during an audio-only transition does not restart the pending source', () => {
    const f = fixture();
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    assert.equal(f.calls.filter(call => call.video_id).length, 1);
    f.controls.configure({ audioOnly: true, quality: 'hd720' });
    assert.equal(f.calls.filter(call => call.video_id).length, 1);
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(f.calls.filter(call => call.video_id).length, 1);
});

test('Music HLS fmt=0 is video, and audio selection removes all HLS sources from the AAC response', () => {
    const f = fixture();
    f.media.currentSrc = hlsMaster;
    f.stats.fmt = '0';
    f.response.streamingData.hlsManifestUrl = hlsMaster;
    f.response.streamingData.adaptiveFormats = [{ itag: 140, mimeType: 'audio/mp4', url: 'https://r.googlevideo.com/audio' }];
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: message => publications.push(message) } } };
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    const request = f.calls.find(call => call.player_response);
    assert.ok(request);
    assert.equal(JSON.parse(request.player_response).streamingData.hlsManifestUrl, undefined);
    assert.equal(publications.at(-1).observedAudioOnly, false);
});

test('unrelated domains receive no prototype and duplicate installation preserves identity', () => {
    assert.equal(fixture({ host: 'example.com' }).controls, undefined);
    const f = fixture();
    vm.runInContext(source, f.context);
    assert.equal(f.context.__anyPWAMediaControls, f.controls);
});

test('next-track mode uses native state without restarting current playback', () => {
    const f = fixture();
    assert.equal(f.controls.setAudioOnly(true).status, 'next-track-requested');
    assert.equal(f.nativeState.player.audioOnly, true);
    assert.equal(f.calls.length, 1);
});

test('active switch preserves queue, position, explicit pause and original response', () => {
    for (const paused of [true, false]) {
        const f = fixture({ paused, wrapper: true });
        assert.equal(f.controls.setAudioOnly(true, { reloadCurrent: true }).status, 'reload-requested');
        const vars = f.calls[1];
        assert.equal(vars.audio_only, '1');
        assert.equal(vars.start, 92.5);
        assert.equal(vars.pause_at_start, paused);
        assert.equal(vars.list, 'queue');
        assert.equal(vars.player_params, 'original');
        // YouTube reads playerConfig.audioConfig.playAudioOnly like audio_only, so both agree.
        assert.deepEqual(JSON.parse(vars.player_response), { ...f.response, playerConfig: { audioConfig: { playAudioOnly: true } } });
        assert.equal(f.response.streamingData.formats[0].itag, 18);
        f.controls.setAudioOnly(false, { reloadCurrent: true });
        assert.equal(f.calls[3].audio_only, '0');
        assert.deepEqual(JSON.parse(f.calls[3].player_response), f.response);
    }
});

test('ads and stale queue identity prevent active reload without changing native state', () => {
    for (const f of [fixture({ ad: true }), fixture()]) {
        if (!f.nativeState.player.adPlaying) f.renderer.navigationEndpoint.watchEndpoint.videoId = 'other';
        assert.equal(f.controls.setAudioOnly(true, { reloadCurrent: true }).status, 'current-track-unavailable');
        assert.equal(f.calls.length, 0);
    }
});

test('failed native reload restores the prior audio-only preference', () => {
    const f = fixture();
    f.api.loadVideoByPlayerVars = () => { throw new Error('Unavailable'); };
    assert.equal(f.controls.setAudioOnly(true, { reloadCurrent: true }).status, 'failed');
    assert.equal(f.nativeState.player.audioOnly, false);
});

test('quality selector accepts only native advertised levels and passes both range limits', () => {
    const f = fixture({ host: 'www.youtube.com' });
    assert.equal(f.controls.setAudioOnly(true).status, 'next-track-requested');
    assert.equal(f.controls.setQuality('hd2160').status, 'unsupported');
    assert.equal(f.calls.length, 0);
    assert.equal(f.controls.setQuality('tiny').status, 'quality-requested');
    assert.deepEqual(Array.from(f.calls[0]), ['tiny', 'tiny']);
});

test('quality policy leaves a loading player untouched and does not report it as playing video', () => {
    const f = fixture({ host: 'www.youtube.com' });
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: message => publications.push(message) } } };
    f.media.readyState = 0;
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    assert.equal(f.calls.length, 0);
    assert.equal(publications.at(-1).status, 'waiting');
    f.media.readyState = 4;
    for (const callback of [...f.timers.values()]) callback();
    assert.deepEqual(Array.from(f.calls[0]), ['medium', 'medium']);
    assert.equal(publications.at(-1).status, 'ready');
});

test('requested preference does not misreport the observed stream as audio-only', () => {
    const f = fixture();
    f.controls.setAudioOnly(true);
    const s = f.controls.state();
    assert.equal(s.requestedAudioOnly, true);
    assert.equal(s.videoFormat, '244');
    assert.equal(s.videoWidth, 854);
    assert.equal(s.artworkVisible, false);
    assert.equal(f.images.length, 0);
});

test('confirmed audio-only displays the current thumbnail without touching playback or obscuring controls', () => {
    const f = fixture();
    f.stats.fmt = '0';
    // A paused source switch can retain the preceding video's dimensions.
    f.controls.setAudioOnly(true);
    const image = f.images[0];
    assert.equal(image.src, 'https://i.ytimg.com/vi/clip/medium.jpg');
    assert.equal(image.hidden, true);
    image.onload();
    assert.equal(f.controls.state().artworkVisible, true);
    assert.equal(image.alt, 'Fixture clip');
    assert.match(image.style.cssText, /pointer-events:none/);
    assert.match(image.style.cssText, /object-fit:contain/);
    const count = f.calls.length;
    f.timers.get(1)();
    assert.equal(f.calls.length, count);
    assert.equal(f.images.length, 1);
    f.controls.setAudioOnly(false);
    assert.equal(image.isConnected, false);
    assert.equal(f.timers.size, 0);
});

test('track changes replace artwork only for matching queue identity and loaded image', () => {
    const f = fixture();
    f.stats.fmt = '0';
    f.controls.setAudioOnly(true);
    f.images[0].onload();
    const oldLoad = f.images[0].onload;
    f.response.videoDetails.videoId = 'next';
    f.controls.refreshArtwork();
    assert.equal(f.controls.state().artworkVisible, false);
    oldLoad();
    assert.equal(f.controls.state().artworkVisible, false);
    f.renderer.navigationEndpoint.watchEndpoint.videoId = 'next';
    f.response.videoDetails.title = 'Next clip';
    f.response.videoDetails.thumbnail.thumbnails = [{ url: 'https://i.ytimg.com/vi/next/thumb.jpg', width: 400 }];
    f.controls.refreshArtwork();
    const image = f.images.at(-1);
    assert.equal(image.hidden, true);
    image.onload();
    assert.equal(image.src, 'https://i.ytimg.com/vi/next/thumb.jpg');
    assert.equal(image.alt, 'Next clip');
    assert.equal(f.controls.state().artworkVisible, true);
});

test('ads, loading, video fallback and failed image loads never present misleading artwork', () => {
    for (const invalidate of [
        f => { f.nativeState.player.adPlaying = true; },
        f => { f.api.classList.contains = () => true; },
        f => { f.media.readyState = 0; },
        f => { f.stats.fmt = '244'; }
    ]) {
        const f = fixture();
        f.stats.fmt = '0';
        f.controls.setAudioOnly(true);
        f.images[0].onload();
        invalidate(f);
        f.timers.get(1)();
        assert.equal(f.controls.state().artworkVisible, false);
    }
    const f = fixture();
    f.stats.fmt = '0';
    f.controls.setAudioOnly(true);
    f.images[0].onerror();
    f.controls.refreshArtwork();
    assert.equal(f.controls.state().artworkVisible, false);
    assert.equal(f.images.length, 1);
});

test('missing or invalid thumbnails leave playback intact and disposal cleans up monitoring', () => {
    const f = fixture();
    f.stats.fmt = '0';
    f.response.videoDetails.thumbnail.thumbnails = [{url:'javascript:alert(1)'}, {url:'https://user:secret@example.com/image'}];
    f.controls.setAudioOnly(true);
    assert.equal(f.controls.state().thumbnailURL, null);
    assert.equal(f.images.length, 0);
    assert.equal(f.calls.length, 1);
    f.controls.dispose();
    assert.equal(f.timers.size, 0);
    assert.equal(f.context.__anyPWAMediaControls, undefined);
    assert.equal(f.nativeState.player.audioOnly, true);
});

test('configured policy switches both ways once, preserving paused source variables', () => {
    const f = fixture({paused:true});
    f.api.loadVideoByPlayerVars = variables => {
        f.calls.push(variables);
        f.stats.fmt = variables.audio_only === '1' ? '0' : '244';
    };
    f.controls.configure({audioOnly:true,quality:'auto'});
    for (const callback of [...f.timers.values()]) callback();
    f.controls.configure({audioOnly:true,quality:'auto'});
    assert.equal(f.calls.filter(call=>call.audio_only === '1').length, 1);
    f.controls.configure({audioOnly:false,quality:'tiny'});
    for (const callback of [...f.timers.values()]) callback();
    const reloads = f.calls.filter(call=>'audio_only' in call);
    assert.equal(reloads.length, 2);
    assert.equal(reloads[1].audio_only, '0');
    for (const variables of reloads) {
        assert.equal(variables.pause_at_start, true);
        assert.equal(variables.start, 92.5);
        assert.equal(variables.list, 'queue');
    }
    f.controls.dispose();
    assert.equal(f.timers.size, 0);
});

test('configured quality uses an available lower level and reapplies on a new track', () => {
    const f = fixture({host:'www.youtube.com'});
    f.controls.configure({audioOnly:false,quality:'hd720'});
    for (const callback of [...f.timers.values()]) callback();
    const qualityCalls = () => f.calls.filter(Array.isArray);
    assert.equal(qualityCalls().length, 1);
    assert.deepEqual(Array.from(qualityCalls()[0]), ['medium','medium']);
    f.response.videoDetails.videoId = 'next';
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(qualityCalls().length, 2);
});

test('configured policy waits for ads and a failed reload never causes a restart loop', () => {
    const f = fixture({ad:true});
    f.controls.configure({audioOnly:true,quality:'auto'});
    assert.equal(f.calls.length, 0);
    f.nativeState.player.adPlaying = false;
    let attempts = 0;
    f.api.loadVideoByPlayerVars = () => { attempts++; throw new Error('Player unavailable'); };
    for (let iteration = 0; iteration < 4; iteration++) {
        for (const callback of [...f.timers.values()]) callback();
    }
    assert.equal(attempts, 1);
    assert.equal(f.controls.state().artworkVisible, false);
    assert.ok(f.calls.some(call=>Array.isArray(call)&&call[0] === 'tiny'));
});

test('WebKit without MediaSource receives an AAC-only native response and can restore video', () => {
    const f = fixture();
    f.response.streamingData.formats[0].mimeType = 'video/mp4';
    f.response.streamingData.adaptiveFormats = [
        {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',signatureCipher:'native-player-cipher'},
        {itag:251,mimeType:'audio/webm; codecs="opus"',url:'https://example.com/opus'}
    ];
    const original = JSON.parse(JSON.stringify(f.response));
    f.controls.setAudioOnly(true,{reloadCurrent:true});
    const audioResponse = JSON.parse(f.calls[1].player_response);
    assert.equal(audioResponse.streamingData.formats.length, 1);
    assert.equal(audioResponse.streamingData.adaptiveFormats.length, 0);
    assert.equal(audioResponse.streamingData.formats[0].itag, 140);
    assert.equal(audioResponse.streamingData.formats[0].signatureCipher, 'native-player-cipher');
    assert.deepEqual(f.response, original);
    f.api.getPlayerResponse = () => audioResponse;
    f.controls.setAudioOnly(false,{reloadCurrent:true});
    assert.deepEqual(JSON.parse(f.calls[3].player_response), original);
});

test('progressive AAC format is recognized as audio even when the player calls it fmt=140', () => {
    const f = fixture();
    f.stats.fmt = '140';
    f.media.currentSrc = 'https://example.com/videoplayback?mime=audio%2Fmp4';
    f.controls.configure({audioOnly:true,quality:'auto'});
    f.images[0].onload();
    assert.equal(f.controls.state().artworkVisible, true);
    assert.equal(f.calls.filter(call=>'audio_only' in call).length, 0);
    f.media.currentSrc = 'https://example.com/videoplayback?mime=video%2Fmp4';
    f.controls.refreshArtwork();
    assert.equal(f.controls.state().artworkVisible, false);
});

test('video requested while audio is loading restores video after the audio source becomes ready', () => {
    const f = fixture({ paused: true });
    f.api.loadVideoByPlayerVars = variables => {
        f.calls.push(variables);
        f.media.readyState = 0;
    };
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    f.controls.configure({ audioOnly: false, quality: 'auto' });
    f.media.readyState = 4;
    f.stats.fmt = '0';
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(f.calls.filter(call => call.audio_only === '0').length, 1);
});

test('audio source selection preserves original pause and play commands', () => {
    const f = fixture();
    f.api.pauseVideo = () => { f.media.paused = true; };
    f.api.playVideo = () => { f.media.paused = false; };
    f.media.pause = () => { f.media.paused = true; };
    f.api.loadVideoByPlayerVars = variables => { f.calls.push(variables); f.media.readyState = 0; };
    const originalPause = f.api.pauseVideo;
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    f.api.pauseVideo();
    f.media.readyState = 4;
    f.stats.fmt = '0';
    f.media.dispatchEvent(new Event('loadeddata'));
    assert.equal(f.media.paused, true);
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(f.api.pauseVideo, originalPause);
});

test('autoplay mute is owned by YouTube and is never overridden by the adapter', () => {
    const f = fixture({ host: 'm.youtube.com' });
    f.media.muted = true;
    f.api.isMutedByMutedAutoplay = () => true;
    f.api.unMute = () => assert.fail('Unexpected unmute');
    f.controls.configure({ audioOnly: false, quality: 'auto' });
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(f.media.muted, true);
});

test('real mouse and trackpad presses reach YouTube as its touch signal, touches and synthetic events do not', () => {
    const f = fixture({ host: 'm.youtube.com' });
    const pointer = f.windowListeners.filter(entry => entry.type === 'pointerdown');
    assert.equal(pointer.length, 1);
    assert.equal(pointer[0].options.capture, true);
    assert.equal(pointer[0].options.passive, true);
    const press = event => pointer[0].listener(event);
    press({ isTrusted: true, pointerType: 'mouse' });
    press({ isTrusted: true, pointerType: 'pen' });
    press({ isTrusted: true, pointerType: 'touch' });
    press({ isTrusted: false, pointerType: 'mouse' });
    assert.deepEqual(f.windowEvents.map(event => event.type), ['touchstart', 'touchstart']);
    assert.equal(f.windowEvents.some(event => event.bubbles), false);
    f.controls.dispose();
    assert.equal(f.windowListeners.some(entry => entry.type === 'pointerdown'), false);
    assert.equal(fixture({ host: 'example.com' }).windowListeners.length, 0);
});

test('without MediaSource the player receives its own per-quality HLS formats and selects 1080p and 720p exactly', async () => {
    const f = hlsFixture();
    // A website hook that strips HLS from parsed responses must not affect the lookup.
    vm.runInContext(`JSON.parse = new Proxy(JSON.parse, { apply(target, self, values) {
        const value = Reflect.apply(target, self, values);
        if (value?.streamingData) delete value.streamingData.hlsManifestUrl;
        return value;
    } });`, f.context);
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    await settle();
    assert.equal(f.lookups.length, 1);
    assert.equal(f.lookups[0].credentials, 'omit');
    assert.equal(JSON.parse(f.lookups[0].body).context.client.visitorData, 'guest-visitor');
    assert.equal(f.fetches[0].url, hlsMaster);
    assert.equal(f.loads().length, 1);
    const load = f.loads()[0];
    const response = JSON.parse(load.player_response);
    assert.equal(response.streamingData.hlsManifestUrl, undefined);
    assert.equal(response.streamingData.formats, undefined);
    assert.equal(response.streamingData.expiresInSeconds, '21540');
    assert.deepEqual(response.streamingData.hlsFormats.map(format => format.itag), [160, 134, 136, 137, 234, 233]);
    const video1080 = response.streamingData.hlsFormats.find(format => format.itag === 137);
    assert.deepEqual(video1080, { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', url: hlsPlaylist(137),
        bitrate: 1080 * 3000 - 128000, width: 1920, height: 1080, fps: 30 });
    assert.deepEqual(response.streamingData.hlsFormats.at(-2), { itag: 234, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        url: hlsPlaylist(234), bitrate: 128000, audioChannels: 2 });
    assert.deepEqual(response.playerConfig.audioPairingConfig.pairs.slice(0, 2), [{ videoItag: 160, audioItag: 234 }, { videoItag: 134, audioItag: 234 }]);
    assert.deepEqual(response.playerConfig.audioPairingConfig.pairs.at(-1), { videoItag: 160, audioItag: 233 });
    assert.equal(response.playerConfig.audioConfig.loudnessDb, -3);
    assert.equal(load.audio_only, '0');
    assert.equal(load.start, 92.5);
    assert.equal(load.pause_at_start, false);
    assert.equal(f.api.querySelector('video'), f.media);
    // The level is locked before the new source has data; readiness only repeats the same level.
    assert.deepEqual(Array.from(f.calls.at(-1)), ['quality', 'hd1080', 'hd1080']);
    const calls = f.calls.length;
    f.ready();
    assert.deepEqual(f.calls.slice(calls).map(call => Array.from(call)), [['quality', 'hd1080', 'hd1080']]);
    assert.equal(f.controls.state().quality, 'hd1080');
    assert.deepEqual(Array.from(f.controls.state().availableQualities), ['hd1080', 'hd720', 'medium', 'tiny', 'auto']);
    f.controls.configure({ audioOnly: false, quality: 'hd720' });
    assert.deepEqual(Array.from(f.calls.at(-1)), ['quality', 'hd720', 'hd720']);
    assert.equal(f.controls.state().quality, 'hd720');
    f.controls.configure({ audioOnly: false, quality: 'large' });
    assert.deepEqual(Array.from(f.calls.at(-1)), ['quality', 'medium', 'medium']);
    assert.equal(f.loads().length, 1);
    assert.equal(f.lookups.length, 1);
    f.controls.dispose();
    assert.equal(f.timeouts.size, 0);
});

test('Automatic keeps the website stream and an available level needs no HLS lookup', async () => {
    for (const quality of ['auto', 'medium']) {
        const f = hlsFixture();
        f.controls.configure({ audioOnly: false, quality });
        await settle();
        assert.equal(f.lookups.length, 0);
        assert.equal(f.loads().length, 0);
        assert.deepEqual(Array.from(f.calls.at(-1)), ['quality', quality, quality]);
        f.controls.dispose();
    }
});

test('YouTube audio-only without MediaSource plays the declared AAC-LC rendition with artwork, then returns to exact video', async () => {
    const f = hlsFixture({ paused: true });
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: value => publications.push(value) } } };
    f.controls.configure({ audioOnly: true, quality: 'hd720' });
    await settle();
    assert.equal(f.loads().length, 1);
    const audio = f.loads()[0];
    assert.deepEqual(JSON.parse(audio.player_response).streamingData, { expiresInSeconds: '21540', hlsManifestUrl: hlsPlaylist(234) });
    assert.equal(audio.audio_only, '1');
    assert.equal(f.calls.at(-1), audio);
    assert.equal(audio.pause_at_start, true);
    assert.equal(audio.start, 92.5);
    f.ready();
    assert.equal(f.media.paused, true);
    assert.equal(f.controls.state().requestedAudioOnly, true);
    assert.equal(publications.at(-1).observedAudioOnly, true);
    assert.equal(publications.at(-1).status, 'ready');
    assert.equal(f.images.length, 1);
    f.images[0].onload();
    assert.equal(f.controls.state().artworkVisible, true);
    f.tick();
    assert.equal(f.loads().length, 1);
    f.controls.configure({ audioOnly: false, quality: 'hd720' });
    assert.equal(f.images[0].isConnected, false);
    assert.equal(f.loads().length, 2);
    const video = f.loads()[1];
    assert.equal(JSON.parse(video.player_response).streamingData.hlsFormats.length, 6);
    assert.equal(video.audio_only, '0');
    assert.equal(video.pause_at_start, true);
    assert.deepEqual(Array.from(f.calls.at(-1)), ['quality', 'hd720', 'hd720']);
    const calls = f.calls.length;
    f.ready();
    assert.deepEqual(f.calls.slice(calls).map(call => Array.from(call)), [['quality', 'hd720', 'hd720']]);
    assert.equal(f.controls.state().quality, 'hd720');
    assert.equal(publications.at(-1).observedAudioOnly, false);
    assert.equal(f.lookups.length, 1);
    assert.equal(f.fetches.length, 1);
    f.controls.dispose();
});

test('Music without MediaSource keeps its queue and explicit pause through audio and video sources', async () => {
    const f = hlsFixture({ host: 'music.youtube.com', paused: true });
    f.controls.configure({ audioOnly: true, quality: 'hd1080' });
    await settle();
    assert.equal(f.nativeState.player.audioOnly, true);
    const audio = f.loads()[0];
    assert.equal(JSON.parse(audio.player_response).streamingData.hlsManifestUrl, hlsPlaylist(234));
    assert.equal(audio.list, 'queue');
    assert.equal(audio.player_params, 'original');
    assert.equal(audio.pause_at_start, true);
    f.ready();
    f.images[0].onload();
    assert.equal(f.controls.state().artworkVisible, true);
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    f.ready();
    const video = f.loads()[1];
    assert.equal(video.list, 'queue');
    assert.equal(video.pause_at_start, true);
    assert.equal(video.audio_only, '0');
    assert.equal(f.nativeState.player.audioOnly, false);
    assert.equal(f.controls.state().quality, 'hd1080');
    assert.equal(f.media.paused, true);
    assert.equal(f.controls.state().artworkVisible, false);
});

test('a lookup reply for the previous video or after disposal never replaces the current source', async () => {
    const f = hlsFixture();
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    f.response.videoDetails.videoId = 'next';
    await settle();
    assert.equal(f.loads().length, 0);
    f.controls.dispose();
    const g = hlsFixture();
    let signal, reply;
    g.context.fetch = (url, options) => { signal = options.signal; return new Promise(resolve => { reply = resolve; }); };
    g.controls.configure({ audioOnly: false, quality: 'hd1080' });
    g.controls.dispose();
    assert.equal(signal.aborted, true);
    reply({ ok: true, text: async () => JSON.stringify({ playabilityStatus: { status: 'OK' },
        videoDetails: { videoId: 'clip' }, streamingData: { hlsManifestUrl: hlsMaster } }) });
    await settle();
    assert.equal(g.loads().length, 0);
    assert.equal(g.timeouts.size, 0);
});

test('a source-less buffering player keeps its playback intent through the HLS switch', async () => {
    for (const playerState of [2, 3, -1]) {
        const f = hlsFixture({ playerState, paused: true });
        Object.assign(f.media, { readyState: 0, currentSrc: '', currentTime: 0 });
        f.controls.configure({ audioOnly: false, quality: 'hd720' });
        await settle();
        assert.equal(f.lookups.length, 1);
        assert.equal(f.loads().length, 1);
        assert.equal(f.loads()[0].pause_at_start, playerState === 2);
        assert.equal(f.loads()[0].start, 0);
        f.tick();
        assert.equal(f.lookups.length, 1);
        assert.equal(f.loads().length, 1);
        f.controls.dispose();
    }
});

test('a failed HLS source is reported once, without rollback or a restart loop', async () => {
    const f = hlsFixture();
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: value => publications.push(value) } } };
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    await settle();
    f.media.error = { code: 3 };
    for (let n = 0; n < 12; n++) f.tick();
    assert.equal(publications.at(-1).status, 'failed');
    assert.equal(f.loads().length, 1);
    assert.equal(f.media.currentSrc.startsWith('data:'), true);
});

test('stream selection never writes media source, volume, mute or transport directly', async () => {
    const f = hlsFixture();
    const commands = {};
    for (const name of ['playVideo', 'pauseVideo', 'stopVideo', 'mute', 'unMute', 'setVolume']) {
        commands[name] = f.api[name] = () => assert.fail('Adapter called ' + name);
    }
    for (const name of ['src', 'volume', 'muted', 'preload']) {
        Object.defineProperty(f.media, name, { get: () => name === 'muted' ? true : 0.37,
            set: () => assert.fail('Adapter wrote ' + name) });
    }
    for (const name of ['play', 'pause', 'load']) f.media[name] = () => assert.fail('Adapter called media.' + name);
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    await settle();
    f.ready();
    f.controls.configure({ audioOnly: true, quality: 'hd1080' });
    f.ready();
    f.controls.configure({ audioOnly: false, quality: 'tiny' });
    f.ready();
    f.media.error = { code: 3 };
    f.tick();
    for (const [name, command] of Object.entries(commands)) assert.equal(f.api[name], command);
    assert.equal(f.loads().length, 3);
    f.controls.dispose();
});

test('the audio rendition stays confirmed when YouTube rewrites its manifest path into query parameters', async () => {
    const f = hlsFixture({ host: 'music.youtube.com' });
    f.controls.configure({ audioOnly: true, quality: 'hd1080' });
    await settle();
    f.media.currentSrc = 'https://manifest.googlevideo.com/api/manifest/hls_playlist?id=clip&itag=234&cpn=fixture';
    f.ready();
    f.images[0].onload();
    assert.equal(f.controls.state().artworkVisible, true);
    f.media.currentSrc = 'https://manifest.googlevideo.com/api/manifest/hls_playlist?id=different&itag=234';
    f.tick();
    assert.equal(f.controls.state().artworkVisible, false);
});

test('with MediaSource, YouTube audio-only uses the player\'s own audio_only mode for every new video', () => {
    const f = fixture({ host: 'm.youtube.com', mse: true });
    f.context.fetch = () => assert.fail('No HLS lookup when MediaSource exists');
    f.api.loadVideoByPlayerVars = variables => {
        f.calls.push(variables);
        f.stats.fmt = variables.audio_only === '1' ? '0' : '244';
    };
    const original = JSON.parse(JSON.stringify(f.response));
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    assert.equal(f.calls.filter(call => call.audio_only === '1').length, 1);
    const reload = f.calls.find(call => call.audio_only === '1');
    assert.deepEqual(JSON.parse(reload.player_response), { ...original, playerConfig: { audioConfig: { playAudioOnly: true } } });
    assert.equal(reload.video_id, 'clip');
    assert.equal(reload.start, 92.5);
    assert.equal(reload.pause_at_start, false);
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(f.controls.state().requestedAudioOnly, true);
    f.images.at(-1).onload();
    assert.equal(f.controls.state().artworkVisible, true);
    f.response.videoDetails.videoId = 'next';
    f.stats.fmt = '244';
    for (const entry of f.documentListeners.filter(entry => entry.type === 'loadeddata')) entry.listener();
    for (const callback of [...f.timeouts.values()]) callback();
    const reloads = f.calls.filter(call => call.audio_only === '1');
    assert.equal(reloads.length, 2);
    assert.equal(reloads[1].video_id, 'next');
    f.controls.configure({ audioOnly: false, quality: 'auto' });
    assert.equal(f.calls.filter(call => call.audio_only === '0').length, 1);
    assert.equal(f.controls.state().artworkVisible, false);
    f.controls.dispose();
    assert.equal(f.documentListeners.length, 0);
});

test('only the background switch overrides WebKit\'s own pause; other pauses and ended videos stay paused', () => {
    const cases = [
        { name: 'background pause', background: true, userHitPause: false, age: 500, state: 2, expected: false },
        { name: 'background pause on Music', host: 'music.youtube.com', background: true, userHitPause: false, age: 500, state: 2, expected: false },
        { name: 'system pause without background', background: false, userHitPause: false, age: 500, state: 2, expected: true },
        { name: 'page pause', background: true, userHitPause: true, age: 500, state: 2, expected: true },
        { name: 'old system pause', background: true, userHitPause: false, age: 4000, state: 2, expected: true },
        { name: 'pause of another element', background: true, userHitPause: false, age: 500, state: 2, other: true, expected: true },
        { name: 'playing', background: false, userHitPause: false, age: null, state: 1, expected: false },
        { name: 'buffering Music start', host: 'music.youtube.com', background: false, userHitPause: false, age: null, state: 3, expected: false }
    ];
    for (const item of cases) {
        const f = fixture({ host: item.host || 'm.youtube.com', mse: true, paused: item.state !== 1 });
        f.api.getPlayerState = () => item.state;
        let now = 100000;
        f.context.Date = { now: () => now };
        f.api.getPlayerState = () => item.state;
        f.media.userHitPause = false;
        const listener = f.documentListeners.find(entry => entry.type === 'pause');
        // Media pause events do not bubble; only a capturing document listener sees them.
        assert.equal(listener.options, true);
        if (item.age !== null) {
            const target = item.other ? Object.assign(new f.context.HTMLMediaElement(), { userHitPause: false }) : f.media;
            listener.listener({ target });
            now += item.age;
        }
        f.media.userHitPause = item.userHitPause;
        f.controls.configure({ audioOnly: true, quality: 'auto', background: item.background });
        const reload = f.calls.find(call => call.audio_only === '1');
        assert.equal(reload.pause_at_start, item.expected, item.name);
        f.controls.dispose();
        assert.equal(f.documentListeners.some(entry => entry.type === 'pause'), false);
    }
});

test('an ended video is not reloaded for a mode change', () => {
    const f = fixture({ host: 'm.youtube.com', mse: true, paused: true });
    f.api.getPlayerState = () => 0;
    f.media.ended = true;
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    assert.equal(f.calls.some(call => call.player_response), false);
    f.media.ended = false;
    f.api.getPlayerState = () => 1;
    f.media.paused = false;
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    assert.equal(f.calls.filter(call => call.audio_only === '1').length, 1);
});

test('a slow audio switch keeps waiting for its source, and a late success clears the failure', () => {
    const f = fixture({ host: 'm.youtube.com', mse: true });
    let now = 100000;
    f.context.Date = { now: () => now };
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: value => publications.push(value) } } };
    f.api.loadVideoByPlayerVars = variables => { f.calls.push(variables); f.media.readyState = 1; };
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    assert.equal(f.calls.filter(call => call.audio_only === '1').length, 1);
    const tick = milliseconds => { now += milliseconds; for (const callback of [...f.timers.values()]) callback(); };
    tick(9000);
    assert.equal(publications.at(-1).status, 'switching');
    assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'tiny'), false);
    tick(22000);
    assert.equal(publications.at(-1).status, 'failed');
    Object.assign(f.media, { readyState: 4 });
    f.stats.fmt = '0';
    tick(1000);
    assert.equal(publications.at(-1).status, 'ready');
    assert.equal(publications.at(-1).observedAudioOnly, true);
    assert.equal(f.calls.filter(call => call.audio_only === '1').length, 1);
    f.controls.dispose();
});

test('without MediaSource a late HLS audio source is accepted after its deadline', async () => {
    const f = hlsFixture();
    let now = 100000;
    f.context.Date = { now: () => now };
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: value => publications.push(value) } } };
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    await settle();
    assert.equal(f.loads().length, 1);
    now += 11000;
    f.tick();
    assert.equal(publications.at(-1).status, 'switching');
    now += 20000;
    f.tick();
    assert.equal(publications.at(-1).status, 'failed');
    f.ready();
    assert.equal(publications.at(-1).status, 'ready');
    assert.equal(publications.at(-1).observedAudioOnly, true);
    assert.equal(f.loads().length, 1);
    f.controls.dispose();
});

test('with MediaSource, new YouTube player responses are marked audio-only before the player reads them', async () => {
    const playerText = JSON.stringify({ videoDetails: { videoId: 'next' }, streamingData: {}, playerConfig: { audioConfig: { loudnessDb: -2 } } });
    const watchText = JSON.stringify([{ playerResponse: JSON.parse(playerText) }, { response: { contents: {} } }]);
    const requests = [];
    const fetch = async input => {
        requests.push(input);
        const response = { ok: true, json: async () => JSON.parse(String(input).includes('get_watch') ? watchText : playerText),
            text: async () => playerText, clone: () => response };
        return response;
    };
    const f = fixture({ host: 'm.youtube.com', mse: true, fetch });
    // The page's JSON.parse, copied into this realm for deep comparison.
    const parse = text => JSON.parse(JSON.stringify(vm.runInContext('JSON.parse', f.context)(text)));
    assert.equal(parse(playerText).playerConfig.audioConfig.playAudioOnly, undefined);
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    assert.deepEqual(parse(playerText).playerConfig.audioConfig, { loudnessDb: -2, playAudioOnly: true });
    assert.equal(parse(watchText)[0].playerResponse.playerConfig.audioConfig.playAudioOnly, true);
    assert.deepEqual(parse('{"playerConfig":{"audioConfig":{}}}'), { playerConfig: { audioConfig: {} } });
    const fetched = await f.context.fetch('https://m.youtube.com/youtubei/v1/player?prettyPrint=false').then(response => response.json());
    assert.equal(fetched.playerConfig.audioConfig.playAudioOnly, true);
    const watch = await f.context.fetch('/youtubei/v1/get_watch').then(response => response.clone().json());
    assert.equal(watch[0].playerResponse.playerConfig.audioConfig.playAudioOnly, true);
    const other = await f.context.fetch('/youtubei/v1/next').then(response => response.json());
    assert.equal(other.playerConfig.audioConfig.playAudioOnly, undefined);
    // The current video was marked too; switching it to video sends a response without the flag.
    f.response.playerConfig = { audioConfig: { loudnessDb: -2, playAudioOnly: true } };
    f.stats.fmt = '0';
    f.controls.configure({ audioOnly: false, quality: 'auto' });
    const video = f.calls.find(call => call.audio_only === '0');
    assert.deepEqual(JSON.parse(video.player_response).playerConfig.audioConfig, { loudnessDb: -2 });
    assert.equal(parse(playerText).playerConfig.audioConfig.playAudioOnly, undefined);
    f.controls.dispose();
    assert.equal(parse(playerText).playerConfig.audioConfig.playAudioOnly, undefined);
    assert.equal(requests.length, 3);
});

test('new videos are not marked on Music, without MediaSource, or for video', async () => {
    const playerText = JSON.stringify({ videoDetails: { videoId: 'next' }, streamingData: {}, playerConfig: { audioConfig: {} } });
    const fetch = async () => {
        const response = { ok: true, json: async () => JSON.parse(playerText), clone: () => response };
        return response;
    };
    for (const [options, choice] of [
        [{ host: 'music.youtube.com', mse: true }, { audioOnly: true, quality: 'auto' }],
        [{ host: 'm.youtube.com' }, { audioOnly: true, quality: 'auto' }],
        [{ host: 'm.youtube.com', mse: true }, { audioOnly: false, quality: 'hd720' }]
    ]) {
        const f = fixture({ ...options, fetch });
        f.controls.configure(choice);
        assert.equal(vm.runInContext('JSON.parse', f.context)(playerText).playerConfig.audioConfig.playAudioOnly, undefined, options.host);
        for (const path of ['/youtubei/v1/player', '/youtubei/v1/get_watch']) {
            const value = await f.context.fetch(path).then(response => response.json());
            assert.equal(value.playerConfig.audioConfig.playAudioOnly, undefined, options.host + path);
        }
        f.controls.dispose();
    }
});

test('a Request object for the player endpoint is recognized, and a mode change applies to later responses', async () => {
    const playerText = JSON.stringify({ videoDetails: { videoId: 'next' }, streamingData: {}, playerConfig: { audioConfig: {} } });
    const fetch = async () => {
        const response = { ok: true, json: async () => JSON.parse(playerText), clone: () => response };
        return response;
    };
    const f = fixture({ host: 'm.youtube.com', mse: true, fetch });
    f.context.Request = class { constructor(url) { this.url = url; } };
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    const request = new f.context.Request('https://m.youtube.com/youtubei/v1/player?key=x');
    assert.equal((await f.context.fetch(request).then(response => response.json())).playerConfig.audioConfig.playAudioOnly, true);
    const pending = f.context.fetch('/youtubei/v1/player');
    f.controls.configure({ audioOnly: false, quality: 'auto' });
    assert.equal((await pending.then(response => response.json())).playerConfig.audioConfig.playAudioOnly, undefined);
    f.controls.dispose();
});

test('a reload that is ready on the wrong stream fails after 8 s, a media error at once', () => {
    for (const variant of ['wrong-stream', 'error']) {
        const f = fixture({ host: 'm.youtube.com', mse: true });
        let now = 100000;
        f.context.Date = { now: () => now };
        const publications = [];
        f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: value => publications.push(value) } } };
        f.api.loadVideoByPlayerVars = variables => {
            f.calls.push(variables);
            f.media.readyState = variant === 'error' ? 1 : 4;
        };
        f.controls.configure({ audioOnly: true, quality: 'auto' });
        const tick = milliseconds => { now += milliseconds; for (const callback of [...f.timers.values()]) callback(); };
        if (variant === 'error') {
            f.media.error = { code: 3 };
            tick(1000);
            assert.equal(publications.at(-1).status, 'failed');
            continue;
        }
        tick(7000);
        assert.equal(publications.at(-1).status, 'switching');
        assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'tiny'), false);
        tick(2000);
        assert.equal(publications.at(-1).status, 'failed');
        assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'tiny'), true);
        f.controls.dispose();
    }
});

test('a marked new video that cannot start audio-only is reported, a cued one is not', () => {
    for (const variant of ['stalled', 'error', 'cued']) {
        const f = fixture({ host: 'm.youtube.com', mse: true });
        let now = 100000;
        f.context.Date = { now: () => now };
        const publications = [];
        f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: value => publications.push(value) } } };
        f.stats.fmt = '0';
        f.controls.configure({ audioOnly: true, quality: 'auto' });
        // YouTube starts the next video by itself from a marked response.
        f.response.videoDetails.videoId = 'next';
        Object.assign(f.media, { readyState: 0, paused: variant === 'cued' });
        f.api.getPlayerState = () => variant === 'cued' ? 5 : 3;
        const tick = milliseconds => { now += milliseconds; for (const callback of [...f.timers.values()]) callback(); };
        tick(1000);
        if (variant === 'error') f.media.error = { code: 4 };
        tick(variant === 'error' ? 1000 : 31000);
        assert.equal(publications.at(-1).status, variant === 'cued' ? 'waiting' : 'failed', variant);
        assert.equal(f.calls.some(call => call.player_response), false);
        f.controls.dispose();
    }
});

test('every new start of a video gets one repair reload', () => {
    const f = fixture({ host: 'm.youtube.com', mse: true });
    f.api.loadVideoByPlayerVars = variables => { f.calls.push(variables); f.stats.fmt = variables.audio_only === '1' ? '0' : '244'; };
    const tick = () => { for (const callback of [...f.timers.values()]) callback(); };
    f.stats.fmt = '0';
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    f.controls.configure({ audioOnly: false, quality: 'auto' });
    assert.deepEqual(f.calls.filter(call => call.audio_only === '0').map(call => call.video_id), ['clip']);
    // Another video starts in the right mode, then clip starts again from data still marked
    // audio-only, for example a response fetched before the mode changed.
    f.response.videoDetails.videoId = 'other';
    f.stats.fmt = '244';
    tick();
    f.response.videoDetails.videoId = 'clip';
    f.stats.fmt = '0';
    tick();
    tick();
    assert.deepEqual(f.calls.filter(call => call.audio_only === '0').map(call => call.video_id), ['clip', 'clip']);
});

test('without MediaSource a failed video switch does not block a later audio switch', async () => {
    const f = hlsFixture();
    let now = 100000;
    f.context.Date = { now: () => now };
    f.controls.configure({ audioOnly: false, quality: 'hd1080' });
    await settle();
    assert.equal(f.loads().length, 1);
    // Audio-only is chosen while the video source is still loading; the video switch then fails.
    f.controls.configure({ audioOnly: true, quality: 'hd1080' });
    now += 31000;
    f.tick();
    f.tick();
    assert.equal(f.loads().length, 2);
    assert.equal(f.loads()[1].audio_only, '1');
    f.controls.dispose();
});

test('without MediaSource a ready source that never switches fails after 10 s', async () => {
    const f = hlsFixture();
    let now = 100000;
    f.context.Date = { now: () => now };
    const publications = [];
    f.context.webkit = { messageHandlers: { anyPWAMediaControls: { postMessage: value => publications.push(value) } } };
    f.controls.configure({ audioOnly: true, quality: 'auto' });
    await settle();
    // The player stays on its progressive source.
    Object.assign(f.media, { currentSrc: 'https://r.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4', readyState: 4 });
    now += 9000;
    f.tick();
    assert.equal(publications.at(-1).status, 'switching');
    now += 2000;
    f.tick();
    assert.equal(publications.at(-1).status, 'failed');
    f.controls.dispose();
});


test('background compatibility resumes a recent native pause even with spoofed visibility and locked controls', () => {
    for (const host of ['m.youtube.com', 'music.youtube.com']) {
        const f = fixture({ host, background: true });
        f.controls.disable();
        f.context.document.visibilityState = 'visible';
        f.context.document.hidden = false;
        const emit = (type, values = {}) => {
            for (const entry of [...f.documentListeners].filter(entry => entry.type === type)) {
                entry.listener({ type, target: f.media, isTrusted: true, ...values });
            }
        };
        f.media.paused = true;
        emit('pause');
        f.context.focused = false;
        emit('visibilitychange');
        assert.equal(f.media.playCalls, 1, host);
        emit('visibilitychange');
        assert.equal(f.media.playCalls, 1, 'one pause may resume only once');
        assert.equal(f.calls.length, 0, 'free background playback must not configure streams');
        assert.equal(f.timers.size, 0, 'locked controls must not start polling');
        vm.runInContext(source, f.context);
        assert.equal(f.documentListeners.filter(entry => entry.type === 'visibilitychange').length, 1);
        f.controls.dispose();
        assert.equal(f.documentListeners.length, 0);
        assert.equal(f.context.__anyPWABackgroundResume, undefined);
    }
});

test('background compatibility preserves pause intent, media identity, focus and interruption boundaries', () => {
    for (const scenario of ['explicit pause', 'later explicit pause', 'source changed', 'detached', 'ended',
        'foreground', 'expired', 'play', 'emptied', 'ended event', 'synthetic pause', 'synthetic visibility']) {
        const f = fixture({ background: true });
        f.controls.disable();
        const emit = (type, values = {}) => {
            for (const entry of [...f.documentListeners].filter(entry => entry.type === type)) {
                entry.listener({ type, target: f.media, isTrusted: true, ...values });
            }
        };
        f.media.paused = true;
        if (scenario === 'explicit pause') f.media.userHitPause = true;
        emit('pause', { isTrusted: scenario !== 'synthetic pause' });
        if (scenario === 'later explicit pause') f.media.userHitPause = true;
        if (scenario === 'source changed') f.media.currentSrc = 'blob:another';
        if (scenario === 'detached') f.media.isConnected = false;
        if (scenario === 'ended') f.media.ended = true;
        if (['play', 'emptied', 'ended event'].includes(scenario)) emit(scenario === 'ended event' ? 'ended' : scenario);
        if (scenario === 'expired') for (const callback of [...f.timeouts.values()]) callback();
        f.context.focused = scenario === 'foreground';
        emit('visibilitychange', { isTrusted: scenario !== 'synthetic visibility' });
        assert.equal(f.media.playCalls || 0, 0, scenario);
        f.controls.dispose();
    }
});
