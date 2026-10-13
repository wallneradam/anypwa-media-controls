/*!
 * anyPWA Media Controls
 * https://github.com/wallneradam/anypwa-media-controls
 * @version 1.0.0
 *
 * Copyright (C) 2026 Adam Wallner
 * SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-anyPWA-Commercial
 */
(() => {
    'use strict';
    const hosts = new Set(['music.youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube.com']);
    if (!hosts.has(location.hostname) || window.__anyPWAMediaControls) return;

    // YouTube's iPhone player starts a video unmuted only when its pool of <video> elements,
    // filled from a window touchstart listener, is not empty. Mouse and trackpad presses
    // (Mac, iPad pointer) never produce touchstart, so forward the real press as that signal.
    const forwardPointerPress = event => {
        if (!event.isTrusted || event.pointerType === 'touch') return;
        let signal;
        try { signal = new TouchEvent('touchstart'); }
        catch { signal = new Event('touchstart'); }
        window.dispatchEvent(signal);
    };
    window.addEventListener('pointerdown', forwardPointerPress, { capture: true, passive: true });

    const music = location.hostname === 'music.youtube.com';
    const player = () => document.getElementById('movie_player');
    let artwork = null;
    let artworkKey = null;
    let loadedArtworkKey = null;
    let artworkTimer = null;
    const originalResponses = new Map();
    const parseJSON = JSON.parse;
    const legacyMedia = typeof MediaSource === 'undefined' && typeof ManagedMediaSource === 'undefined';
    const qualityHeights = { tiny: 144, small: 240, medium: 360, large: 480, hd720: 720, hd1080: 1080, hd1440: 1440, hd2160: 2160, highres: 4320 };
    const qualityForSize = (width, height) => {
        const size = Math.min(width || height, height || width);
        return size > 0 ? Object.keys(qualityHeights).find(quality => size <= qualityHeights[quality]) || 'highres' : null;
    };
    const hlsURL = value => {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password
                && (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))
                && url.pathname.includes('/manifest/hls') ? url.href : null;
        } catch { return null; }
    };
    const hlsField = (value, key) => {
        const url = new URL(value);
        return url.searchParams.get(key) || url.pathname.match(new RegExp('/' + key + '/([^/]+)'))?.[1] || null;
    };
    const sameHLS = (left, right) => {
        if (!hlsURL(left) || !hlsURL(right)) return false;
        const a = hlsField(left, 'id'), b = hlsField(right, 'id');
        const x = hlsField(left, 'itag'), y = hlsField(right, 'itag');
        return left === right || Boolean(a && x && a === b && x === y);
    };
    let desired = null;
    let hlsSession = null;
    let lookup = null;

    // With MediaSource, YouTube reads playerConfig.audioConfig.playAudioOnly exactly like its
    // audio_only player variable, so a new video marked this way never requests video segments.
    const marksNewVideos = () => desired?.audioOnly === true && !music && !legacyMedia;
    const markPlayerData = value => {
        const seen = new WeakSet();
        const visit = (item, depth) => {
            if (item === null || typeof item !== 'object' || seen.has(item) || depth > 4) return;
            seen.add(item);
            if (!Array.isArray(item) && item.playerConfig && typeof item.playerConfig === 'object'
                && (item.streamingData || item.videoDetails)) {
                item.playerConfig.audioConfig = { ...item.playerConfig.audioConfig, playAudioOnly: true };
                return;
            }
            for (const child of Object.values(item)) visit(child, depth + 1);
        };
        visit(value, 0);
        return value;
    };
    JSON.parse = new Proxy(parseJSON, {
        apply(target, thisArg, args) {
            const value = Reflect.apply(target, thisArg, args);
            return marksNewVideos() && typeof args[0] === 'string' && args[0].includes('"playerConfig"')
                ? markPlayerData(value) : value;
        }
    });
    const playerEndpoint = input => {
        try {
            const url = new URL(typeof Request === 'function' && input instanceof Request ? input.url : String(input), location.href);
            return url.pathname === '/youtubei/v1/player' || url.pathname === '/youtubei/v1/get_watch';
        } catch { return false; }
    };
    const markedResponse = response => new Proxy(response, {
        get(target, property) {
            if (property === 'json') return () => target.json().then(value => marksNewVideos() ? markPlayerData(value) : value);
            if (property === 'clone') return () => markedResponse(target.clone());
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    if (typeof window.fetch === 'function') {
        window.fetch = new Proxy(window.fetch, {
            apply(target, thisArg, args) {
                const result = Reflect.apply(target, thisArg, args);
                return marksNewVideos() && playerEndpoint(args[0]) ? Promise.resolve(result).then(markedResponse) : result;
            }
        });
    }

    // WebKit pauses video by itself when the app enters the background. The backgrounding module
    // flags every pause the page requests (userHitPause), so a pause without that flag shortly
    // before a source switch is the system's, and the switch keeps the playback the person chose.
    let interruption = null;
    let backgroundSwitchAt = null;
    const recordPause = event => {
        if (event.target instanceof HTMLMediaElement && event.target.userHitPause === false) {
            interruption = { media: event.target, at: Date.now() };
        }
    };
    document.addEventListener('pause', recordPause, true);
    // Only the switch that entering the background caused may override such a pause; other system
    // pauses (headphones removed, a call) stay paused.
    const pausedForSwitch = (media, playerState) => {
        if (media.ended || playerState === 0) return true;
        const paused = typeof playerState === 'number' ? playerState === 2 || playerState === 5 : media.paused;
        const now = Date.now();
        return paused && !(interruption?.media === media && media.userHitPause === false
            && now - interruption.at < 3000 && backgroundSwitchAt !== null && now - backgroundSwitchAt < 3000);
    };
    const stopHLS = () => {
        hlsSession?.abort.abort();
        hlsSession = null;
    };
    const musicController = () => {
        if (!music) return null;
        const element = document.querySelector('ytmusic-player');
        if (!element) return null;
        for (const key of Object.getOwnPropertyNames(element)) {
            if (!key.endsWith('_playerController')) continue;
            const controller = element[key];
            if (typeof controller?.store?.dispatch === 'function'
                && typeof controller.store.getState === 'function'
                && typeof controller.queue?.getItems === 'function'
                && typeof controller.queue.getCurrentItemIndex === 'function'
                && controller.store.getState()?.player) return controller;
        }
        return null;
    };
    const requestedAudioOnly = () => music ? musicController()?.store.getState().player.audioOnly ?? null
        : desired?.audioOnly ?? null;

    const thumbnailURL = response => {
        const thumbnails = response?.videoDetails?.thumbnail?.thumbnails;
        if (!Array.isArray(thumbnails)) return null;
        const candidates = thumbnails.flatMap(thumbnail => {
            try {
                const url = new URL(thumbnail.url);
                if (url.protocol !== 'https:' || url.username || url.password) return [];
                return [{ url: url.href, width: Number(thumbnail.width) || 0 }];
            } catch { return []; }
        }).sort((a, b) => a.width - b.width);
        return (candidates.find(candidate => candidate.width >= 640) || candidates.at(-1))?.url || null;
    };

    const isAudioStream = api => {
        const stats = api?.getVideoStats?.() || {};
        const media = api?.querySelector('video');
        if (!media || media.readyState < 2) return false;
        const source = media.currentSrc || '';
        // Per-quality HLS sources are data: master playlists that always carry video.
        if (source.startsWith('data:')) return false;
        try {
            if (hlsURL(source)) return Boolean(hlsSession?.audioSource && sameHLS(hlsSession.audioSource, source)
                && hlsSession.videoID === api.getPlayerResponse?.()?.videoDetails?.videoId);
            const mime = new URL(source).searchParams.get('mime');
            if (mime?.startsWith('video/')) return false;
            if (mime?.startsWith('audio/')) return true;
        } catch {}
        const response = api.getPlayerResponse?.();
        const formats = [...(response?.streamingData?.formats || []), ...(response?.streamingData?.adaptiveFormats || [])];
        const selected = formats.find(format => String(format.itag) === String(stats.fmt));
        return String(stats.fmt) === '0' || Boolean(selected?.mimeType?.startsWith('audio/'));
    };

    const withAudioOnly = (response, audioOnly) => {
        if (!audioOnly && !response.playerConfig?.audioConfig?.playAudioOnly) return response;
        const { playAudioOnly, ...audioConfig } = response.playerConfig?.audioConfig || {};
        return { ...response, playerConfig: { ...response.playerConfig,
            audioConfig: audioOnly ? { ...audioConfig, playAudioOnly: true } : audioConfig } };
    };

    const playbackResponse = (response, audioOnly) => {
        const id = response.videoDetails.videoId;
        const formats = [...(response.streamingData?.formats || []), ...(response.streamingData?.adaptiveFormats || [])];
        if (!originalResponses.has(id) || formats.some(format => format.mimeType?.startsWith('video/'))) {
            originalResponses.set(id, response);
            if (originalResponses.size > 2) originalResponses.delete(originalResponses.keys().next().value);
        }
        const original = originalResponses.get(id);
        if (!audioOnly || !legacyMedia) return withAudioOnly(original, audioOnly);
        const audio = [...(original.streamingData?.adaptiveFormats || []), ...(original.streamingData?.formats || [])]
            .filter(format => format.mimeType?.startsWith('audio/mp4') && (format.url || format.signatureCipher || format.cipher));
        if (!audio.length) return withAudioOnly(original, true);
        return withAudioOnly({ ...original, streamingData: { ...original.streamingData, formats: audio, adaptiveFormats: [],
            hlsManifestUrl: undefined, hlsFormats: undefined } }, true);
    };

    const removeArtwork = () => {
        artwork?.remove();
        artwork = null;
        artworkKey = null;
        loadedArtworkKey = null;
    };

    const updateArtwork = () => {
        const api = player();
        const controller = musicController();
        const native = controller?.store.getState().player;
        const media = api?.querySelector('video');
        const response = api?.getPlayerResponse?.();
        const videoID = response?.videoDetails?.videoId;
        const url = thumbnailURL(response);
        let current = desired?.audioOnly === true;
        if (music) {
            const items = controller?.queue.getItems();
            const item = items?.[controller.queue.getCurrentItemIndex()];
            const renderer = item?.playlistPanelVideoRenderer
                || item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
            current = native?.audioOnly === true && !native.adPlaying
                && renderer?.navigationEndpoint?.watchEndpoint?.videoId === videoID;
        }
        const confirmed = current && !api.classList.contains('ad-showing') && isAudioStream(api)
            && media?.readyState >= 2 && videoID;
        if (!confirmed || !url) {
            removeArtwork();
            return false;
        }
        if (!artwork?.isConnected || artwork.parentElement !== api) {
            removeArtwork();
            artwork = document.createElement('img');
            artwork.setAttribute('data-anypwa-audio-artwork', '');
            artwork.draggable = false;
            artwork.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:1;';
            artwork.hidden = true;
            api.appendChild(artwork);
        }
        const key = videoID + '\n' + url;
        if (artworkKey !== key) {
            artworkKey = key;
            loadedArtworkKey = null;
            artwork.hidden = true;
            const image = artwork;
            image.onload = () => {
                if (image !== artwork || artworkKey !== key) return;
                loadedArtworkKey = key;
                refreshArtwork();
            };
            image.onerror = () => {
                if (image !== artwork || artworkKey !== key) return;
                loadedArtworkKey = null;
                image.hidden = true;
            };
            image.alt = response.videoDetails.title || 'Video thumbnail';
            image.src = url;
        }
        artwork.hidden = loadedArtworkKey !== key;
        return !artwork.hidden;
    };

    const refreshArtwork = () => {
        try { return updateArtwork(); }
        catch { removeArtwork(); return false; }
    };

    const monitorArtwork = enabled => {
        if (artworkTimer !== null) clearInterval(artworkTimer);
        artworkTimer = null;
        if (!enabled) { removeArtwork(); return; }
        refreshArtwork();
        artworkTimer = setInterval(refreshArtwork, 1000);
    };

    const state = () => {
        const api = player();
        const stats = api?.getVideoStats?.() || {};
        const response = api?.getPlayerResponse?.();
        const media = document.querySelector('#movie_player video');
        return {
            host: location.hostname,
            videoID: response?.videoDetails?.videoId || null,
            requestedAudioOnly: requestedAudioOnly(),
            videoFormat: stats.fmt ?? null,
            audioFormat: stats.afmt ?? null,
            quality: media?.videoWidth > 0 && media?.videoHeight > 0 && media?.readyState >= 2
                ? qualityForSize(media.videoWidth, media.videoHeight) || api?.getPlaybackQuality?.() || null
                : api?.getPlaybackQuality?.() || null,
            availableQualities: api?.getAvailableQualityLevels?.() || [],
            position: api?.getCurrentTime?.() ?? null,
            paused: media?.paused ?? null,
            videoWidth: media?.videoWidth ?? null,
            thumbnailURL: thumbnailURL(response),
            artworkVisible: Boolean(artwork?.isConnected && !artwork.hidden)
        };
    };

    const currentVariables = (controller, api, audioOnly) => {
        const items = controller.queue.getItems();
        const item = items[controller.queue.getCurrentItemIndex()];
        const renderer = item?.playlistPanelVideoRenderer
            || item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
        const endpoint = renderer?.navigationEndpoint?.watchEndpoint;
        const currentResponse = api.getPlayerResponse?.();
        const storedResponse = controller.store.getState().player.playerResponse;
        const response = currentResponse?.streamingData ? currentResponse
            : storedResponse?.videoDetails?.videoId === currentResponse?.videoDetails?.videoId ? storedResponse : currentResponse;
        if (!endpoint?.videoId || endpoint.videoId !== response?.videoDetails?.videoId) return null;
        const media = document.querySelector('#movie_player video');
        if (!media || controller.store.getState().player.adPlaying || api.classList.contains('ad-showing')
            || !Number.isFinite(api.getCurrentTime())) return null;
        return {
            video_id: endpoint.videoId,
            list: endpoint.playlistId,
            player_params: endpoint.playerParams,
            start: api.getCurrentTime(),
            external_list: true,
            pause_at_start: pausedForSwitch(media, api.getPlayerState?.()),
            player_response: JSON.stringify(playbackResponse(response, audioOnly))
        };
    };

    const videoVariables = (api, audioOnly) => {
        const response = api.getPlayerResponse?.();
        const media = api.querySelector('video');
        if (!media || !response?.videoDetails?.videoId || api.classList.contains('ad-showing')
            || !Number.isFinite(api.getCurrentTime?.())) return null;
        // A new video reaches this while still unstarted or buffering, before its autoplay begins;
        // only a pause (2), a cued (5) or an ended (0) video stays paused.
        const playerState = api.getPlayerState?.();
        return {
            video_id: response.videoDetails.videoId,
            start: api.getCurrentTime(),
            pause_at_start: pausedForSwitch(media, playerState),
            player_response: JSON.stringify(playbackResponse(response, audioOnly))
        };
    };

    const setAudioOnly = (enabled, { reloadCurrent = false } = {}) => {
        if (typeof enabled !== 'boolean') throw new TypeError('Audio-only must be a boolean.');
        const controller = musicController();
        const api = player();
        if (!api || (music && !controller)) return { status: 'unsupported' };
        const previous = controller?.store.getState().player.audioOnly;
        if (reloadCurrent && (typeof api.getCurrentTime !== 'function'
            || typeof api.getPlayerResponse !== 'function')) return { status: 'current-track-unavailable' };
        let variables = null;
        try {
            if (reloadCurrent) variables = controller ? currentVariables(controller, api, enabled) : videoVariables(api, enabled);
        } catch { return { status: 'current-track-unavailable' }; }
        if (reloadCurrent && (!variables || typeof api.loadVideoByPlayerVars !== 'function')) {
            return { status: 'current-track-unavailable' };
        }
        try {
            controller?.store.dispatch({ type: 'SET_AUDIO_ONLY', payload: enabled });
            if (variables) api.loadVideoByPlayerVars({ ...variables, audio_only: enabled ? '1' : '0' });
        } catch (error) {
            controller?.store.dispatch({ type: 'SET_AUDIO_ONLY', payload: previous });
            return { status: 'failed', message: String(error) };
        }
        monitorArtwork(enabled);
        return { status: variables ? 'reload-requested' : 'next-track-requested', ...state() };
    };

    const setQuality = quality => {
        const api = player();
        const available = api?.getAvailableQualityLevels?.() || [];
        if (!available.includes(quality) || typeof api?.setPlaybackQualityRange !== 'function') {
            return { status: 'unsupported', availableQualities: available };
        }
        api.setPlaybackQualityRange(quality, quality);
        return { status: 'quality-requested', ...state() };
    };

    let controlTimer = null;
    let scheduled = false;
    let pending = null;
    let attemptedKey = null;
    let failedKey = null;
    let qualityKey = null;
    let qualityPlayer = null;
    let lastPublication = null;
    let lastPlayer = null;
    let currentStart = null;
    const qualityOrder = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160', 'highres'];

    // WebKit without MediaSource only plays progressive 360p from the website's own response.
    // The VISIONOS client receives an HLS manifest for the same video.
    const lookupHLS = async (videoID, signal) => {
        const context = window.ytcfg?.get('INNERTUBE_CONTEXT')?.client;
        const visitorData = context?.visitorData;
        if (!visitorData) return null;
        const response = await fetch('/youtubei/v1/player', {
            method: 'POST', credentials: 'omit', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId: videoID, context: { client: {
                clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
                osName: 'visionOS', osVersion: '26.5.23O471', hl: context.hl || 'en', visitorData
            } } })
        });
        if (!response.ok) return null;
        const value = parseJSON(await response.text());
        return value.playabilityStatus?.status === 'OK' && value.videoDetails?.videoId === videoID
            ? hlsURL(value.streamingData?.hlsManifestUrl) : null;
    };

    const stopLookup = () => {
        clearTimeout(lookup?.timeout);
        lookup?.abort?.abort();
        lookup = null;
    };

    const masterFor = (videoID, response) => (lookup?.videoID === videoID ? lookup.url : null)
        || (hlsSession?.videoID === videoID ? hlsSession.master : null)
        || hlsURL(response?.streamingData?.hlsManifestUrl);

    const requestHLS = requested => {
        if (!legacyMedia || requested === 'auto'
            || !window.ytcfg?.get('INNERTUBE_CONTEXT')?.client?.visitorData) return false;
        const api = player(), response = api?.getPlayerResponse?.(), videoID = response?.videoDetails?.videoId;
        if (!videoID || masterFor(videoID, response)
            || (requested !== 'audio' && api.getAvailableQualityLevels?.().includes(requested))) return false;
        if (lookup?.api !== api || lookup?.videoID !== videoID) {
            stopLookup();
            const request = { api, videoID, pending: true, url: null, failed: false, abort: new AbortController() };
            lookup = request;
            request.timeout = setTimeout(() => request.abort.abort(), 10000);
            lookupHLS(videoID, request.abort.signal).catch(() => null).then(value => {
                clearTimeout(request.timeout);
                if (lookup !== request || api.getPlayerResponse?.()?.videoDetails?.videoId !== videoID) return;
                request.pending = false;
                request.url = hlsURL(value);
                request.failed = !request.url;
                reconcile();
            });
        }
        return lookup.pending;
    };

    // Builds the website player's own per-quality HLS description: every playable AVC rendition
    // becomes one hlsFormats entry paired with its declared AAC audio rendition, so the player
    // offers real quality levels and selects one exactly with setPlaybackQualityRange.
    const parseHLS = (text, base, media) => {
        if (!text.startsWith('#EXTM3U') || text.length > 1024 * 1024) throw new Error('Invalid HLS manifest');
        const lines = text.split(/\r?\n/).map(line => line.trim());
        const attribute = (line, name) => {
            const match = line.match(new RegExp('(?:[:,])' + name + '=(?:"([^"]*)"|([^,]*))'));
            return match ? match[1] ?? match[2] : null;
        };
        const absolute = value => { try { return hlsURL(new URL(value, base).href); } catch { return null; } };
        const groups = new Map();
        for (const line of lines) {
            if (!line.startsWith('#EXT-X-MEDIA:') || attribute(line, 'TYPE') !== 'AUDIO') continue;
            const url = absolute(attribute(line, 'URI'));
            const itag = url && Number(hlsField(url, 'itag'));
            if (url && itag) groups.set(attribute(line, 'GROUP-ID'), { url, itag });
        }
        const videos = new Map(), audios = new Map(), pairs = [];
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
            const codecs = (attribute(line, 'CODECS') || '').split(',').map(codec => codec.trim());
            const videoCodec = codecs.find(codec => codec.startsWith('avc1.'));
            const audioCodec = codecs.find(codec => codec.startsWith('mp4a.'));
            const size = attribute(line, 'RESOLUTION')?.match(/^(\d+)x(\d+)$/);
            const track = groups.get(attribute(line, 'AUDIO'));
            if (!videoCodec || !audioCodec || !size || !track
                || !media.canPlayType('video/mp4; codecs="' + videoCodec + ',' + audioCodec + '"')) continue;
            let next = index + 1;
            while (next < lines.length && (!lines[next] || lines[next].startsWith('#'))) next++;
            const url = absolute(lines[next]);
            const itag = url && Number(hlsField(url, 'itag'));
            if (!itag) continue;
            const audioBitrate = audioCodec === 'mp4a.40.5' ? 48000 : 128000;
            if (!audios.has(track.itag)) {
                audios.set(track.itag, { itag: track.itag, mimeType: 'audio/mp4; codecs="' + audioCodec + '"',
                    url: track.url, bitrate: audioBitrate, audioChannels: 2, lc: audioCodec === 'mp4a.40.2' });
            }
            if (!videos.has(itag)) {
                videos.set(itag, { itag, mimeType: 'video/mp4; codecs="' + videoCodec + '"', url,
                    bitrate: Math.max(Number(attribute(line, 'BANDWIDTH')) - audioBitrate, 1),
                    width: Number(size[1]), height: Number(size[2]), fps: Number(attribute(line, 'FRAME-RATE')) || 30 });
            }
            if (!pairs.some(pair => pair.videoItag === itag && pair.audioItag === track.itag)) {
                pairs.push({ videoItag: itag, audioItag: track.itag });
            }
        }
        if (!videos.size) throw new Error('No playable HLS variants');
        const preferred = itag => audios.get(itag)?.lc ? 0 : 1;
        pairs.sort((a, b) => preferred(a.audioItag) - preferred(b.audioItag));
        const audioList = [...audios.values()].sort((a, b) => preferred(a.itag) - preferred(b.itag));
        return {
            formats: [...videos.values(), ...audioList.map(({ lc, ...format }) => format)],
            pairs,
            audioSource: audioList[0]?.url || null
        };
    };

    const switchHLS = (session, mode, requested) => {
        const api = session.api;
        const response = api.getPlayerResponse?.();
        if (response?.videoDetails?.videoId !== session.videoID || typeof api.loadVideoByPlayerVars !== 'function') {
            session.failed = mode;
            return;
        }
        const controller = musicController();
        const variables = controller ? currentVariables(controller, api, mode === 'audio') : videoVariables(api, false);
        if (!variables) { session.failed = mode; return; }
        const original = playbackResponse(response, false);
        const expiresInSeconds = original.streamingData?.expiresInSeconds;
        const replacement = mode === 'audio'
            ? { ...original, streamingData: { expiresInSeconds, hlsManifestUrl: session.audioSource } }
            : { ...original, streamingData: { expiresInSeconds, hlsFormats: session.formats },
                playerConfig: { ...original.playerConfig, audioPairingConfig: { pairs: session.pairs } } };
        session.mode = mode;
        session.transition = { mode, started: Date.now() };
        qualityKey = null;
        api.loadVideoByPlayerVars({ ...variables,
            player_response: JSON.stringify(replacement),
            audio_only: mode === 'audio' ? '1' : '0'
        });
        // YouTube ignores suggested qualities and starts a load on its automatic master; switching
        // away from it before the start position is applied restarts at 0. The level constraint is
        // stored with the new video data without needing its levels, so the first source is exact.
        if (mode === 'video') api.setPlaybackQualityRange?.(requested, requested);
    };

    // Returns true while the HLS source owns the request (loading, switching, audio or failed);
    // false hands a video quality request to the player's own quality API.
    const applyHLS = requested => {
        if (!legacyMedia) return false;
        const api = player(), media = api?.querySelector('video');
        const response = api?.getPlayerResponse?.();
        const videoID = response?.videoDetails?.videoId;
        const master = videoID && masterFor(videoID, response);
        if (!media || !master) { stopHLS(); return false; }
        if (hlsSession?.api !== api || hlsSession?.videoID !== videoID) {
            stopHLS();
            const session = { api, videoID, master, formats: null, pairs: null, audioSource: null,
                mode: null, transition: null, failed: false, abort: new AbortController() };
            hlsSession = session;
            fetch(master, { signal: session.abort.signal }).then(reply => {
                if (!reply.ok) throw new Error('HLS manifest unavailable');
                return reply.text();
            }).then(text => {
                if (hlsSession !== session) return;
                Object.assign(session, parseHLS(text, master, media));
                reconcile();
            }).catch(error => {
                if (hlsSession === session && error.name !== 'AbortError') session.failed = true;
            });
        }
        const session = hlsSession;
        if (!session.formats) return true;
        const mode = requested === 'audio' ? 'audio' : 'video';
        // getPlayerResponse() returns the website's original response again shortly after a load,
        // so the playing element tells which source is active: YouTube serves its per-quality
        // HLS formats as data: master playlists.
        const source = media.currentSrc || '';
        const current = source.startsWith('data:') ? 'video' : sameHLS(source, session.audioSource) ? 'audio' : null;
        // A failure belongs to the mode that failed; a slow network can still deliver that source
        // after its deadline.
        if (session.failed) {
            if ((session.failed === true || session.failed === mode)
                && (current !== mode || media.readyState < 2 || media.error)) return true;
            session.failed = false;
        }
        if (session.transition) {
            if (current === session.transition.mode && media.readyState >= 2) session.transition = null;
            // Ready media on another source fails quickly; a source still loading gets longer.
            else if (media.error || Date.now() - session.transition.started > (media.readyState >= 2 ? 10000 : 30000)) {
                session.failed = session.transition.mode;
                session.transition = null;
                return true;
            } else return true;
        }
        if (current === mode) return mode === 'audio';
        // A finished video gets the mode with its next start.
        if (media.ended || api.getPlayerState?.() === 0) return true;
        if (mode === 'audio' && !session.audioSource) { session.failed = 'audio'; return true; }
        switchHLS(session, mode, requested);
        return true;
    };

    const publish = status => {
        const snapshot = state();
        const api = player();
        const ad = api?.classList.contains('ad-showing') || musicController()?.store.getState().player.adPlaying;
        const observedAudioOnly = !ad && snapshot.requestedAudioOnly === true
            && isAudioStream(api);
        const value = { ...snapshot, observedAudioOnly, status };
        const key = JSON.stringify({ ...value, position: null });
        if (key === lastPublication) return;
        lastPublication = key;
        window.webkit?.messageHandlers?.anyPWAMediaControls?.postMessage(value);
    };

    const applyQuality = requested => {
        if (requestHLS(requested)) return;
        if (applyHLS(requested)) return;
        const api = player();
        if ((api?.querySelector('video')?.readyState ?? 0) < 2) return;
        const available = api?.getAvailableQualityLevels?.() || [];
        let selected = requested;
        if (!available.includes(selected) && selected !== 'auto') {
            const limit = qualityOrder.indexOf(selected);
            selected = qualityOrder.slice(0, limit + 1).filter(level => available.includes(level)).at(-1)
                || qualityOrder.find(level => available.includes(level));
        }
        if (!selected || !available.includes(selected)) return;
        const key = (api.getPlayerResponse?.()?.videoDetails?.videoId || '') + ':' + selected;
        if (key === qualityKey && api === qualityPlayer) return;
        if (setQuality(selected).status === 'quality-requested') {
            qualityKey = key;
            qualityPlayer = api;
        }
    };

    const reconcile = () => {
        if (!desired) return;
        try {
            const api = player();
            if (!api?.getPlayerResponse || !api.getVideoStats) { publish('waiting'); return; }
            if (api !== lastPlayer) {
                lastPlayer = api;
                attemptedKey = null;
                failedKey = null;
                pending = null;
            }
            const controller = musicController();
            const native = controller?.store.getState().player;
            if (api.classList.contains('ad-showing') || native?.adPlaying) { removeArtwork(); publish('ad'); return; }
            const response = api.getPlayerResponse();
            const videoID = response?.videoDetails?.videoId;
            const media = api.querySelector('video');
            if (desired.audioOnly && music && !controller) {
                applyQuality('tiny'); publish('failed'); return;
            }
            const audio = desired.audioOnly;
            const key = videoID + ':' + audio;
            // Every start of a video gets one repair and its own start deadline.
            if (videoID && currentStart?.videoID !== videoID) {
                if (currentStart) { attemptedKey = null; failedKey = null; }
                currentStart = { videoID, at: Date.now() };
            }
            const fmt = String(api.getVideoStats()?.fmt);
            const audioStream = isAudioStream(api);
            if (native && (native.audioOnly === true) !== audio) setAudioOnly(audio);
            if (legacyMedia && (audio || hlsSession?.mode === 'audio')
                && (lookup?.url || window.ytcfg?.get('INNERTUBE_CONTEXT')?.client?.visitorData)) {
                const requested = audio ? 'audio' : desired.quality;
                const looking = requestHLS(requested);
                const applying = !looking && applyHLS(requested);
                if (looking || applying) {
                    refreshArtwork();
                    publish(hlsSession?.failed || lookup?.failed ? 'failed'
                        : looking || hlsSession?.transition || !hlsSession?.formats ? 'switching'
                        : media?.readyState >= 2 ? 'ready' : 'waiting');
                    return;
                }
            }
            if (pending && videoID && pending.videoID !== videoID) pending = null;
            if (pending) {
                const ready = media?.readyState >= 2;
                if (ready && (pending.audio ? audioStream : !audioStream && fmt !== 'undefined')) {
                    pending = null;
                }
                // Ready media on the wrong stream fails quickly; a source still loading on a slow
                // network gets longer before the fallback.
                else if (media?.error || Date.now() - pending.started > (ready ? 8000 : 30000)) {
                    failedKey = pending.key;
                    pending = null;
                }
            }
            if (!pending && failedKey === key && media?.readyState >= 2 && !media.error && audio === audioStream) failedKey = null;
            // A new video marked audio-only starts without an adapter reload, so its own start needs
            // the same deadline.
            if (audio && !pending && failedKey !== key && videoID && !(media?.readyState >= 2)
                && (media?.error || (api.getPlayerState?.() === 3 && Date.now() - currentStart.at > 30000))) failedKey = key;
            const ended = media?.ended || api.getPlayerState?.() === 0;
            const needsReload = videoID && media?.readyState >= 2 && !ended && audio !== audioStream;
            if (needsReload && !pending && attemptedKey !== key && failedKey !== key) {
                const result = setAudioOnly(audio, { reloadCurrent: true });
                if (result.status === 'reload-requested') {
                    attemptedKey = key;
                    pending = { key, videoID, audio, started: Date.now() };
                } else if (result.status === 'failed') { failedKey = key; }
            }
            if (!pending && (!audio || failedKey === key)) applyQuality(failedKey === key && audio ? 'tiny' : desired.quality);
            refreshArtwork();
            publish(failedKey === key || hlsSession?.failed || (!audio && desired.quality !== 'auto'
                && lookup?.failed && !api.getAvailableQualityLevels?.().includes(desired.quality)) ? 'failed'
                : pending || hlsSession?.transition || lookup?.pending ? 'switching'
                : videoID && media?.readyState >= 2 ? 'ready' : 'waiting');
        } catch { removeArtwork(); publish('failed'); }
    };

    // React as soon as a new source has data instead of waiting for the next poll, so audio-only
    // replaces a starting video before it downloads more than its first segments.
    const scheduleReconcile = () => {
        if (scheduled || !desired) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; reconcile(); }, 0);
    };
    for (const type of ['loadeddata', 'playing']) document.addEventListener(type, scheduleReconcile, true);

    const configure = choice => {
        if (typeof choice?.audioOnly !== 'boolean' || !['auto', ...qualityOrder].includes(choice.quality)) {
            throw new TypeError('Invalid media playback choice.');
        }
        if (!desired || desired.audioOnly !== choice.audioOnly || desired.quality !== choice.quality) {
            const modeChanged = !desired || desired.audioOnly !== choice.audioOnly;
            if (hlsSession?.failed) stopHLS();
            if (lookup?.failed || (modeChanged && lookup?.pending)) stopLookup();
            desired = { audioOnly: choice.audioOnly, quality: choice.quality };
            if (modeChanged) {
                attemptedKey = null;
                failedKey = null;
                if (currentStart) currentStart.at = Date.now();
                if (!music) monitorArtwork(choice.audioOnly);
            }
            qualityKey = null;
        }
        if (choice.background === true) backgroundSwitchAt = Date.now();
        if (controlTimer === null) controlTimer = setInterval(reconcile, 1000);
        reconcile();
        return state();
    };

    const dispose = () => {
        window.removeEventListener('pointerdown', forwardPointerPress, { capture: true });
        document.removeEventListener('pause', recordPause, true);
        for (const type of ['loadeddata', 'playing']) document.removeEventListener(type, scheduleReconcile, true);
        desired = null;
        stopLookup();
        stopHLS();
        originalResponses.clear();
        monitorArtwork(false);
        if (controlTimer !== null) clearInterval(controlTimer);
        controlTimer = null;
        delete window.__anyPWAMediaControls;
    };
    window.__anyPWAMediaControls = Object.freeze({ state, setAudioOnly, setQuality, refreshArtwork, configure, dispose });
})();
