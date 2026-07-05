interface CachedTrackSummary {
    name: string;
    title: string;
    artist: string;
    composer: string;
    genre: string;
    album: string;
    year: string;
    durationMs: string;
    trackNumber: string;
    description: string;
    size: number;
    mtime: number;
    added: number;
}

interface CatalogCacheFile {
    version: number;
    generatedAt: number;
    tracks: {
        [name: string]: CachedTrackSummary;
    };
}

interface TrackSummary {
    name: string;
    path: string;
    description: string;
    size: number;
    mtime: number;
    added: number;
    title: string;
    artist: string;
    composer: string;
    genre: string;
    album: string;
    year: string;
    durationMs: string;
    trackNumber: string;
    lyricsText?: string;
    ansiArtBase64?: string;
}

interface TrackFilters {
    search: string;
    artist: string;
    composer: string;
    genre: string;
}

interface GuidedSectionState {
    notes: string;
    text: string;
}

interface ComposeState {
    songTitle: string;
    brief: string;
    notes: string;
    genre: string;
    feel: string;
    tone: string;
    arrangement: string;
    instrumentation: string;
    groove: string;
    band: string;
    leadvocal: string;
    backingvocal: string;
    language: string;
    key: string;
    timesig: string;
    bpmMode: string;
    bpmValue: string;
    duration: string;
    lyricMode: string;
    lyricsFreeform: string;
    sections: {
        [key: string]: GuidedSectionState;
    };
    cowriter: string;
    memoryActive: boolean;
    waitForResponse: boolean;
}

interface ParseOptions {
    includeLyrics: boolean;
    includeAnsiArt: boolean;
}

interface SyncedLyricLine {
    time: number;
    text: string;
}

interface ParsedTrackTags {
    title: string;
    artist: string;
    composer: string;
    genre: string;
    year: string;
    album: string;
    durationMs: string;
    trackNumber: string;
    lyricsText: string;
    syncedLyrics: SyncedLyricLine[];
    ansiArtBase64: string;
    ansiBitmapBase64: string;
}

interface AppState {
    catalog: TrackSummary[];
    filters: TrackFilters;
    compose: ComposeState;
    cowriters: string[];
    mainMenuCtx: UifcListContext;
    trackListCtx: UifcListContext;
    filterMenuCtx: UifcListContext;
    composeMenuCtx: UifcListContext;
}

(function () {
    "use strict";

    var APP_TITLE = "Futureland Records";
    var DIR_CODE = "originalcontent_mp3s";
    var CHAT_CHANNEL = "main";
    var CACHE_VERSION = 1;
    var CACHE_FILE = "catalog-cache.json";

    var uiReady = false;

    load("sbbsdefs.js");
    load("uifcdefs.js");
    try { load("userdefs.js"); } catch (_) { }
    try { load("utf8_cp437.js"); } catch (_) { }
    try { load("utf8_utf16.js"); } catch (_) { }

    function createDefaultFilters(): TrackFilters {
        return {
            search: "",
            artist: "",
            composer: "",
            genre: ""
        };
    }

    function createComposeState(): ComposeState {
        var sections: { [key: string]: GuidedSectionState } = {};
        var i: number;

        for (i = 0; i < FLRecordsData.sectionDefs.length; i += 1) {
            sections[FLRecordsData.sectionDefs[i].key] = {
                notes: "",
                text: ""
            };
        }

        return {
            songTitle: "",
            brief: "",
            notes: "",
            genre: "",
            feel: "",
            tone: "",
            arrangement: "",
            instrumentation: "",
            groove: "",
            band: "",
            leadvocal: "",
            backingvocal: "",
            language: "",
            key: "",
            timesig: "",
            bpmMode: "",
            bpmValue: "",
            duration: "",
            lyricMode: "freeform",
            lyricsFreeform: "",
            sections: sections,
            cowriter: "",
            memoryActive: false,
            waitForResponse: false
        };
    }

    function createAppState(): AppState {
        return {
            catalog: [],
            filters: createDefaultFilters(),
            compose: createComposeState(),
            cowriters: [],
            mainMenuCtx: new uifc.list.CTX(),
            trackListCtx: new uifc.list.CTX(),
            filterMenuCtx: new uifc.list.CTX(),
            composeMenuCtx: new uifc.list.CTX()
        };
    }

    function initUi(): void {
        var mode = (argv && argv.length > 0) ? String(argv[0]) : undefined;
        if (uifc.init(APP_TITLE, mode)) {
            uiReady = true;
            return;
        }
        uiReady = false;
        console.clear();
        console.writeln(APP_TITLE);
        console.writeln("");
        console.writeln("UIFC is required for this door.");
        console.pause();
        exit();
    }

    function safeBailUi(): void {
        if (!uiReady) return;
        try {
            uifc.bail();
        } catch (_) {
        }
        uiReady = false;
    }

    function withConsoleScreen(body: () => void): void {
        var hadUi = uiReady;
        if (hadUi) safeBailUi();
        console.clear();
        try {
            body();
        } finally {
            if (hadUi) initUi();
        }
    }

    function pathJoin(base: string, leaf: string): string {
        var prefix = String(base || "");
        if (!prefix.length) return String(leaf || "");
        if (prefix.charAt(prefix.length - 1) === "/" || prefix.charAt(prefix.length - 1) === "\\") {
            return prefix + leaf;
        }
        return prefix + "/" + leaf;
    }

    function dataDirPath(): string {
        return pathJoin(fullpath(js.exec_dir), "data");
    }

    function cacheFilePath(): string {
        return pathJoin(dataDirPath(), CACHE_FILE);
    }

    function ensureDataDir(): void {
        var dir = dataDirPath();
        if (!file_exists(dir)) {
            try {
                mkpath(dir);
            } catch (_) {
            }
        }
    }

    function showLoadingStatus(title: string, detail: string): void {
        console.clear();
        console.writeln(APP_TITLE);
        console.writeln(repeatChar("=", APP_TITLE.length));
        console.writeln("");
        console.writeln(title);
        if (detail) {
            console.writeln(detail);
        }
        console.writeln("");
        console.writeln("Please wait...");
    }

    function repeatChar(ch: string, count: number): string {
        var out = "";
        var i: number;
        for (i = 0; i < count; i += 1) out += ch;
        return out;
    }

    function safeString(value: any): string {
        if (value === null || value === undefined) return "";
        return String(value);
    }

    function trimValue(value: any): string {
        return safeString(value).replace(/\r/g, "").replace(/^\s+|\s+$/g, "");
    }

    function lower(value: any): string {
        return trimValue(value).toLowerCase();
    }

    function sentence(text: string): string {
        var value = trimValue(text);
        if (!value.length) return "";
        return /[.!?]$/.test(value) ? value : (value + ".");
    }

    function byteAt(data: string, index: number): number {
        if (index < 0 || index >= data.length) return 0;
        return data.charCodeAt(index) & 0xff;
    }

    function synchsafe32(data: string, offset: number): number {
        return ((byteAt(data, offset) & 0x7f) << 21) |
            ((byteAt(data, offset + 1) & 0x7f) << 14) |
            ((byteAt(data, offset + 2) & 0x7f) << 7) |
            (byteAt(data, offset + 3) & 0x7f);
    }

    function be32(data: string, offset: number): number {
        return ((byteAt(data, offset) << 24) >>> 0) |
            (byteAt(data, offset + 1) << 16) |
            (byteAt(data, offset + 2) << 8) |
            byteAt(data, offset + 3);
    }

    function be16(data: string, offset: number): number {
        return (byteAt(data, offset) << 8) | byteAt(data, offset + 1);
    }

    function removeUnsync(data: string): string {
        return data.replace(/\xff\0/g, "\xff");
    }

    function findNullTerminator(data: string, start: number, encoding: number): number {
        var i: number;
        if (encoding === 1 || encoding === 2) {
            for (i = start; i < data.length - 1; i += 2) {
                if (byteAt(data, i) === 0 && byteAt(data, i + 1) === 0) return i;
            }
            return data.length;
        }
        i = data.indexOf("\0", start);
        return i >= 0 ? i : data.length;
    }

    function decodeLatin1(data: string): string {
        var nul = data.indexOf("\0");
        if (nul >= 0) data = data.substring(0, nul);
        return data;
    }

    function decodeUtf8(data: string): string {
        var nul = data.indexOf("\0");
        if (nul >= 0) data = data.substring(0, nul);
        if (typeof utf8_utf16 === "function") {
            try {
                return utf8_utf16(data);
            } catch (_) {
            }
        }
        return data;
    }

    function decodeUtf16(data: string, bigEndianDefault: boolean): string {
        var littleEndian = !bigEndianDefault;
        var offset = 0;
        var out = "";
        var i: number;
        var b1: number;
        var b2: number;
        var code: number;

        if (data.length >= 2) {
            b1 = byteAt(data, 0);
            b2 = byteAt(data, 1);
            if (b1 === 0xff && b2 === 0xfe) {
                littleEndian = true;
                offset = 2;
            } else if (b1 === 0xfe && b2 === 0xff) {
                littleEndian = false;
                offset = 2;
            }
        }

        for (i = offset; i + 1 < data.length; i += 2) {
            b1 = byteAt(data, i);
            b2 = byteAt(data, i + 1);
            if (b1 === 0 && b2 === 0) break;
            code = littleEndian ? ((b2 << 8) | b1) : ((b1 << 8) | b2);
            out += String.fromCharCode(code);
        }
        return out;
    }

    function decodeTextByEncoding(encoding: number, data: string): string {
        if (encoding === 1) return decodeUtf16(data, false);
        if (encoding === 2) return decodeUtf16(data, true);
        if (encoding === 3) return decodeUtf8(data);
        return decodeLatin1(data);
    }

    function parseUserTextFrame(data: string): { description: string; value: string } {
        var encoding = byteAt(data, 0);
        var descriptionEnd = findNullTerminator(data, 1, encoding);
        var description = decodeTextByEncoding(encoding, data.substring(1, descriptionEnd));
        var valueStart = descriptionEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
        var value = valueStart < data.length ? decodeTextByEncoding(encoding, data.substring(valueStart)) : "";
        return {
            description: trimValue(description),
            value: trimValue(value)
        };
    }

    function parseUnsyncedLyrics(data: string): string {
        var encoding = byteAt(data, 0);
        var descriptorStart = 4;
        var descriptorEnd = findNullTerminator(data, descriptorStart, encoding);
        var lyricStart = descriptorEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
        if (lyricStart >= data.length) return "";
        return trimValue(decodeTextByEncoding(encoding, data.substring(lyricStart)));
    }

    function parseSyncedLyrics(data: string): SyncedLyricLine[] {
        var encoding = byteAt(data, 0);
        var timestampFormat = byteAt(data, 4);
        var pos = 6;
        var lines: SyncedLyricLine[] = [];
        var textEnd: number;
        var text: string;
        var timestamp: number;
        var seconds: number;

        pos = findNullTerminator(data, pos, encoding) + ((encoding === 1 || encoding === 2) ? 2 : 1);
        while (pos + 4 <= data.length) {
            textEnd = findNullTerminator(data, pos, encoding);
            text = decodeTextByEncoding(encoding, data.substring(pos, textEnd));
            pos = textEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
            if (pos + 4 > data.length) break;
            timestamp = be32(data, pos);
            pos += 4;
            seconds = timestampFormat === 2 ? (timestamp / 1000) : (timestamp / 38.46);
            text = trimValue(text);
            if (text.length) {
                lines.push({ time: seconds, text: text });
            }
        }
        return lines;
    }

    function flattenSyncedLyrics(lines: SyncedLyricLine[]): string {
        var out: string[] = [];
        var i: number;
        for (i = 0; i < lines.length; i += 1) {
            if (!lines[i].text.length) continue;
            if (!out.length || out[out.length - 1] !== lines[i].text) {
                out.push(lines[i].text);
            }
        }
        return out.join("\n");
    }

    function cleanGenre(value: string): string {
        var genre = trimValue(value);
        var match = genre.match(/^\((\d+)\)/);
        var genres: string[] = [
            "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
            "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae",
            "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks",
            "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion",
            "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip",
            "Gospel", "Noise", "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative",
            "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave",
            "Techno-Industrial", "Electronic"
        ];

        if (match) {
            var idx = parseInt(match[1], 10);
            if (!isNaN(idx) && idx >= 0 && idx < genres.length) {
                return genres[idx];
            }
        }
        return genre;
    }

    function emptyParsedTags(): ParsedTrackTags {
        return {
            title: "",
            artist: "",
            composer: "",
            genre: "",
            year: "",
            album: "",
            durationMs: "",
            trackNumber: "",
            lyricsText: "",
            syncedLyrics: [],
            ansiArtBase64: "",
            ansiBitmapBase64: ""
        };
    }

    function parseTrackTags(path: string, options: ParseOptions): ParsedTrackTags {
        var result = emptyParsedTags();
        var file = new File(path);
        var header: string;
        var version: number;
        var flags: number;
        var tagSize: number;
        var tagEnd: number;
        var hasUnsync: boolean;
        var extHeader: string;
        var extSize: number;
        var frameHeader: string;
        var frameId: string;
        var frameSize: number;
        var frameFlags: number;
        var frameData: string;
        var frameNeedsBody: boolean;
        var textFrames: { [id: string]: string } = {
            "TIT2": "title",
            "TPE1": "artist",
            "TCOM": "composer",
            "TCON": "genre",
            "TDRC": "year",
            "TYER": "year",
            "TALB": "album",
            "TLEN": "durationMs",
            "TRCK": "trackNumber"
        };
        var textKey: string;
        var parsedUserText: { description: string; value: string };

        if (!file.open("rb")) return result;

        try {
            header = file.read(10);
            if (!header || header.length < 10 || header.substring(0, 3) !== "ID3") {
                return result;
            }

            version = byteAt(header, 3);
            flags = byteAt(header, 5);
            tagSize = synchsafe32(header, 6);
            tagEnd = 10 + tagSize;
            hasUnsync = (flags & 0x80) !== 0;

            if ((flags & 0x40) !== 0) {
                extHeader = file.read(4);
                if (extHeader && extHeader.length === 4) {
                    extSize = version >= 4 ? synchsafe32(extHeader, 0) : be32(extHeader, 0);
                    if (extSize > 4) {
                        file.position += extSize - 4;
                    }
                }
            }

            while (file.position + 10 <= tagEnd) {
                frameHeader = file.read(10);
                if (!frameHeader || frameHeader.length < 10) break;
                frameId = frameHeader.substring(0, 4);
                if (!frameId.replace(/\0/g, "").length) break;
                frameSize = version >= 4 ? synchsafe32(frameHeader, 4) : be32(frameHeader, 4);
                frameFlags = be16(frameHeader, 8);
                if (frameSize <= 0) break;
                if (file.position + frameSize > tagEnd) break;

                frameNeedsBody = false;
                if (textFrames[frameId]) frameNeedsBody = true;
                if (frameId === "TXXX" && options.includeAnsiArt) frameNeedsBody = true;
                if ((frameId === "USLT" || frameId === "SYLT") && options.includeLyrics) frameNeedsBody = true;

                if (!frameNeedsBody) {
                    file.position += frameSize;
                    continue;
                }

                frameData = file.read(frameSize);
                if (hasUnsync || ((version >= 4) && ((frameFlags & 0x02) !== 0))) {
                    frameData = removeUnsync(frameData);
                }

                textKey = textFrames[frameId];
                if (textKey) {
                    (result as any)[textKey] = trimValue(decodeTextByEncoding(byteAt(frameData, 0), frameData.substring(1)));
                    continue;
                }

                if (frameId === "TXXX") {
                    parsedUserText = parseUserTextFrame(frameData);
                    if (parsedUserText.description === "ANSI_ART") {
                        result.ansiArtBase64 = parsedUserText.value;
                    } else if (parsedUserText.description === "ANSI_BITMAP") {
                        result.ansiBitmapBase64 = parsedUserText.value;
                    }
                    continue;
                }

                if (frameId === "USLT") {
                    result.lyricsText = parseUnsyncedLyrics(frameData);
                    continue;
                }

                if (frameId === "SYLT") {
                    result.syncedLyrics = parseSyncedLyrics(frameData);
                }
            }
        } finally {
            file.close();
        }

        result.genre = cleanGenre(result.genre);
        if (!result.lyricsText.length && result.syncedLyrics.length) {
            result.lyricsText = flattenSyncedLyrics(result.syncedLyrics);
        }
        return result;
    }

    function fileStem(name: string): string {
        return safeString(name).replace(/\.[^.]+$/, "");
    }

    function displayTrackTitle(track: TrackSummary): string {
        return trimValue(track.title) || fileStem(track.name);
    }

    function displayTrackArtist(track: TrackSummary): string {
        return trimValue(track.artist) || trimValue(track.composer) || "Unknown Artist";
    }

    function trackSearchHaystack(track: TrackSummary): string {
        return lower(track.name + " " + displayTrackTitle(track) + " " + track.artist + " " + track.composer + " " + track.genre + " " + track.album);
    }

    function truncateText(text: string, width: number): string {
        if (text.length <= width) return text;
        if (width <= 3) return text.substring(0, width);
        return text.substring(0, width - 3) + "...";
    }

    function padRight(text: string, width: number): string {
        var value = text;
        while (value.length < width) value += " ";
        return value;
    }

    function trackRow(track: TrackSummary): string {
        var title = truncateText(toScreenText(displayTrackTitle(track)), 38);
        var artist = truncateText(toScreenText(displayTrackArtist(track)), 22);
        var genre = truncateText(toScreenText(trimValue(track.genre) || "-"), 14);
        return padRight(title, 40) + padRight(artist, 24) + genre;
    }

    function readJsonFile(path: string): any {
        var file = new File(path);
        var raw: string;
        if (!file.open("r")) return null;
        try {
            raw = file.read();
        } finally {
            file.close();
        }
        if (!raw || !trimValue(raw).length) return null;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function writeJsonFile(path: string, value: any): void {
        var file = new File(path);
        if (!file.open("w+")) return;
        try {
            file.write(JSON.stringify(value, null, 2));
        } finally {
            file.close();
        }
    }

    function readCatalogCache(): CatalogCacheFile {
        var cached = readJsonFile(cacheFilePath());
        if (!cached || cached.version !== CACHE_VERSION || !cached.tracks) {
            return {
                version: CACHE_VERSION,
                generatedAt: 0,
                tracks: {}
            };
        }
        return cached as CatalogCacheFile;
    }

    function summaryFromCache(cached: CachedTrackSummary, path: string): TrackSummary {
        return {
            name: cached.name,
            path: path,
            description: cached.description || "",
            size: cached.size || 0,
            mtime: cached.mtime || 0,
            added: cached.added || 0,
            title: cached.title || "",
            artist: cached.artist || "",
            composer: cached.composer || "",
            genre: cached.genre || "",
            album: cached.album || "",
            year: cached.year || "",
            durationMs: cached.durationMs || "",
            trackNumber: cached.trackNumber || ""
        };
    }

    function cacheFromSummary(track: TrackSummary): CachedTrackSummary {
        return {
            name: track.name,
            title: track.title,
            artist: track.artist,
            composer: track.composer,
            genre: track.genre,
            album: track.album,
            year: track.year,
            durationMs: track.durationMs,
            trackNumber: track.trackNumber,
            description: track.description,
            size: track.size,
            mtime: track.mtime,
            added: track.added
        };
    }

    function buildSummary(meta: any, path: string, size: number, mtime: number, parsed: ParsedTrackTags): TrackSummary {
        return {
            name: safeString(meta.name),
            path: path,
            description: trimValue(meta.desc || meta.description || ""),
            size: size,
            mtime: mtime,
            added: typeof meta.added === "number" ? meta.added : 0,
            title: trimValue(parsed.title),
            artist: trimValue(parsed.artist),
            composer: trimValue(parsed.composer),
            genre: trimValue(parsed.genre),
            album: trimValue(parsed.album),
            year: trimValue(parsed.year),
            durationMs: trimValue(parsed.durationMs),
            trackNumber: trimValue(parsed.trackNumber)
        };
    }

    function sortTracks(tracks: TrackSummary[]): void {
        tracks.sort(function (a: TrackSummary, b: TrackSummary): number {
            var aTitle = lower(displayTrackTitle(a));
            var bTitle = lower(displayTrackTitle(b));
            if (aTitle < bTitle) return -1;
            if (aTitle > bTitle) return 1;
            if (lower(a.artist) < lower(b.artist)) return -1;
            if (lower(a.artist) > lower(b.artist)) return 1;
            return lower(a.name) < lower(b.name) ? -1 : 1;
        });
    }

    function loadCatalog(forceRefresh: boolean): TrackSummary[] {
        var base = new FileBase(DIR_CODE);
        var list: any[];
        var cache = forceRefresh ? {
            version: CACHE_VERSION,
            generatedAt: 0,
            tracks: {}
        } as CatalogCacheFile : readCatalogCache();
        var nextCache: CatalogCacheFile = {
            version: CACHE_VERSION,
            generatedAt: time(),
            tracks: {}
        };
        var tracks: TrackSummary[] = [];
        var changed = forceRefresh;
        var i: number;
        var meta: any;
        var path: string;
        var size: number;
        var mtime: number;
        var cached: CachedTrackSummary;
        var parsed: ParsedTrackTags;
        var detail: string;

        ensureDataDir();

        if (!file_area.dir[DIR_CODE]) {
            throw new Error("File area '" + DIR_CODE + "' is not configured.");
        }

        if (!base.open()) {
            throw new Error("Could not open file base '" + DIR_CODE + "': " + safeString(base.error));
        }

        try {
            list = base.get_list("*.mp3", FileBase.DETAIL.NORM, 0, true, FileBase.SORT.NAME_AI) || [];

            for (i = 0; i < list.length; i += 1) {
                meta = list[i];
                path = base.get_path(meta);
                size = typeof meta.size === "number" ? meta.size : base.get_size(meta);
                mtime = base.get_time(meta);
                cached = cache.tracks[safeString(meta.name)];
                detail = format("%d / %d", i + 1, list.length) + "  " + safeString(meta.name);
                showLoadingStatus(forceRefresh ? "Refreshing track catalog..." : "Loading track catalog...", detail);

                if (cached && cached.size === size && cached.mtime === mtime) {
                    tracks.push(summaryFromCache(cached, path));
                    nextCache.tracks[cached.name] = cached;
                    continue;
                }

                parsed = parseTrackTags(path, {
                    includeLyrics: false,
                    includeAnsiArt: false
                });
                tracks.push(buildSummary(meta, path, size, mtime, parsed));
                nextCache.tracks[safeString(meta.name)] = cacheFromSummary(tracks[tracks.length - 1]);
                changed = true;
            }
        } finally {
            base.close();
        }

        if (Object.keys(cache.tracks).length !== Object.keys(nextCache.tracks).length) {
            changed = true;
        }
        if (changed) writeJsonFile(cacheFilePath(), nextCache);
        sortTracks(tracks);
        return tracks;
    }

    function toScreenText(value: any): string {
        var text = safeString(value);
        if (!text.length) return "";
        if (typeof str_is_utf8 === "function" && typeof utf8_cp437 === "function" && console.term_supports && !console.term_supports(USER_UTF8)) {
            try {
                if (str_is_utf8(text)) return utf8_cp437(text);
            } catch (_) {
            }
        }
        return text;
    }

    function getFilteredTracks(app: AppState): TrackSummary[] {
        var filtered: TrackSummary[] = [];
        var i: number;
        var track: TrackSummary;
        var search = lower(app.filters.search);
        for (i = 0; i < app.catalog.length; i += 1) {
            track = app.catalog[i];
            if (app.filters.artist.length && lower(track.artist) !== lower(app.filters.artist)) continue;
            if (app.filters.composer.length && lower(track.composer) !== lower(app.filters.composer)) continue;
            if (app.filters.genre.length && lower(track.genre) !== lower(app.filters.genre)) continue;
            if (search.length && trackSearchHaystack(track).indexOf(search) < 0) continue;
            filtered.push(track);
        }
        return filtered;
    }

    function uniqueValues(tracks: TrackSummary[], key: string): string[] {
        var map: { [name: string]: boolean } = {};
        var values: string[] = [];
        var i: number;
        var value: string;

        for (i = 0; i < tracks.length; i += 1) {
            value = trimValue((tracks[i] as any)[key]);
            if (!value.length || map[lower(value)]) continue;
            map[lower(value)] = true;
            values.push(value);
        }
        values.sort(function (a: string, b: string): number {
            return lower(a) < lower(b) ? -1 : 1;
        });
        return values;
    }

    function promptInput(title: string, current: string, maxLen: number, mode: number): string | null {
        var value = uifc.input(WIN_MID | WIN_SAV, title, current, maxLen, mode);
        if (value === null || value === undefined) return null;
        return safeString(value);
    }

    function chooseValueMenu(title: string, current: string, values: string[], allLabel: string): string {
        var items = [allLabel].concat(values.map(function (entry: string): string {
            return toScreenText(entry);
        }));
        var ctx = new uifc.list.CTX();
        var selection: number;
        var currentIndex = 0;
        var i: number;

        for (i = 0; i < values.length; i += 1) {
            if (lower(values[i]) === lower(current)) {
                currentIndex = i + 1;
                ctx.cur = currentIndex;
                ctx.bar = currentIndex;
                break;
            }
        }

        selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, title, items, ctx);
        if (selection < 0) return current;
        if (selection === 0) return "";
        return values[selection - 1];
    }

    function filterSummary(filters: TrackFilters): string {
        var parts: string[] = [];
        if (filters.search.length) parts.push("Search=" + filters.search);
        if (filters.artist.length) parts.push("Artist=" + filters.artist);
        if (filters.composer.length) parts.push("Composer=" + filters.composer);
        if (filters.genre.length) parts.push("Genre=" + filters.genre);
        return parts.length ? parts.join(" | ") : "No filters";
    }

    function editTrackFilters(app: AppState): void {
        var options: string[];
        var choice: number;
        var values: string[];
        while (bbs.online && !js.terminated) {
            options = [
                "Search text         " + summarizeValue(app.filters.search, 34),
                "Artist              " + summarizeValue(app.filters.artist || "All artists", 34),
                "Composer            " + summarizeValue(app.filters.composer || "All composers", 34),
                "Genre               " + summarizeValue(app.filters.genre || "All genres", 34),
                "Clear all filters",
                "Back"
            ];
            uifc.help_text = "Filter the read/listen catalog by search text, artist, composer, or genre.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Track Filters", options, app.filterMenuCtx);
            if (choice < 0 || choice === 5) return;

            if (choice === 0) {
                var search = promptInput("Search text", app.filters.search, 120, K_EDIT);
                if (search !== null) app.filters.search = trimValue(search);
            } else if (choice === 1) {
                values = uniqueValues(app.catalog, "artist");
                app.filters.artist = chooseValueMenu("Artist Filter", app.filters.artist, values, "All artists");
            } else if (choice === 2) {
                values = uniqueValues(app.catalog, "composer");
                app.filters.composer = chooseValueMenu("Composer Filter", app.filters.composer, values, "All composers");
            } else if (choice === 3) {
                values = uniqueValues(app.catalog, "genre");
                app.filters.genre = chooseValueMenu("Genre Filter", app.filters.genre, values, "All genres");
            } else if (choice === 4) {
                app.filters = createDefaultFilters();
            }
        }
    }

    function summarizeValue(value: string, maxLen: number): string {
        return truncateText(toScreenText(trimValue(value)), maxLen);
    }

    function wrapText(text: string, width: number): string[] {
        var lines = safeString(text).replace(/\r/g, "").split("\n");
        var wrapped: string[] = [];
        var i: number;
        var raw: string;
        var words: string[];
        var current: string;
        var w: number;

        if (width < 10) width = 10;
        for (i = 0; i < lines.length; i += 1) {
            raw = lines[i];
            if (!raw.length) {
                wrapped.push("");
                continue;
            }
            words = raw.split(/\s+/);
            current = "";
            for (w = 0; w < words.length; w += 1) {
                if (!current.length) {
                    current = words[w];
                    continue;
                }
                if ((current + " " + words[w]).length <= width) {
                    current += " " + words[w];
                } else {
                    wrapped.push(current);
                    current = words[w];
                }
            }
            if (current.length) wrapped.push(current);
        }
        return wrapped;
    }

    function printConsoleHeader(title: string): void {
        var cleanTitle = toScreenText(title);
        console.writeln(cleanTitle);
        console.writeln(repeatChar("=", cleanTitle.length));
        console.writeln("");
    }

    function waitForAnyKey(): void {
        console.writeln("");
        console.write("Press any key to continue...");
        console.getkey(K_NONE);
    }

    function showPagedText(title: string, text: string): void {
        var lines = wrapText(toScreenText(text), Math.max(30, console.screen_columns - 2));
        var pageSize = Math.max(10, console.screen_rows - 5);
        var index = 0;
        var key: string;
        while (bbs.online && !js.terminated) {
            console.clear();
            printConsoleHeader(title);
            var shown = lines.slice(index, index + pageSize);
            var i: number;
            for (i = 0; i < shown.length; i += 1) {
                console.writeln(shown[i]);
            }
            console.writeln("");
            if (index + pageSize >= lines.length) {
                console.write("[Q] Back");
            } else {
                console.write("[Space/Enter] Next  [Q] Back");
            }
            key = safeString(console.getkey(K_NONE)).toUpperCase();
            if (key === "Q" || key === "\u001b") return;
            if (index + pageSize >= lines.length) return;
            index += pageSize;
        }
    }

    function formatFullMetadata(track: TrackSummary, parsed: ParsedTrackTags): string {
        var lines: string[] = [];
        lines.push("Title: " + toScreenText(displayTrackTitle(track)));
        lines.push("Artist: " + toScreenText(trimValue(parsed.artist) || track.artist || "Unknown"));
        lines.push("Composer: " + toScreenText(trimValue(parsed.composer) || track.composer || "-"));
        lines.push("Genre: " + toScreenText(trimValue(parsed.genre) || track.genre || "-"));
        lines.push("Album: " + toScreenText(trimValue(parsed.album) || track.album || "-"));
        lines.push("Year: " + toScreenText(trimValue(parsed.year) || track.year || "-"));
        lines.push("Track #: " + toScreenText(trimValue(parsed.trackNumber) || track.trackNumber || "-"));
        lines.push("Duration (ms): " + toScreenText(trimValue(parsed.durationMs) || track.durationMs || "-"));
        lines.push("Filename: " + track.name);
        lines.push("Path: " + track.path);
        lines.push("Size: " + track.size + " bytes");
        lines.push("Modified: " + (track.mtime ? system.datestr(track.mtime) : "-"));
        lines.push("Added: " + (track.added ? system.datestr(track.added) : "-"));
        lines.push("Description: " + toScreenText(track.description || "-"));
        lines.push("Embedded ANSI art: " + (parsed.ansiArtBase64.length ? "Yes" : "No"));
        lines.push("Embedded lyrics: " + ((parsed.lyricsText.length || parsed.syncedLyrics.length) ? "Yes" : "No"));
        return lines.join("\n");
    }

    function loadSidecarLyrics(track: TrackSummary): string {
        var lrcPath = track.path.replace(/\.mp3$/i, ".lrc");
        var file = new File(lrcPath);
        var raw: string;
        var lines: string[] = [];
        var i: number;
        var match: RegExpExecArray | null;
        var content: string;

        if (!file_exists(lrcPath)) return "";
        if (!file.open("r")) return "";
        try {
            raw = file.read();
        } finally {
            file.close();
        }

        raw = raw.replace(/\r/g, "");
        var parts = raw.split("\n");
        for (i = 0; i < parts.length; i += 1) {
            match = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/.exec(parts[i]);
            if (!match) continue;
            content = trimValue(parts[i].replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, ""));
            if (content.length) lines.push(content);
        }
        return lines.join("\n");
    }

    function showTrackArt(track: TrackSummary): void {
        var parsed = parseTrackTags(track.path, {
            includeLyrics: false,
            includeAnsiArt: true
        });
        var art = parsed.ansiArtBase64.length ? base64_decode(parsed.ansiArtBase64) : "";

        console.clear();
        printConsoleHeader(displayTrackTitle(track) + " Artwork");
        if (!art.length) {
            console.writeln("No embedded ANSI artwork was found for this track.");
            waitForAnyKey();
            return;
        }
        console.write(art);
        console.writeln("");
        waitForAnyKey();
    }

    function showTrackLyrics(track: TrackSummary): void {
        var parsed = parseTrackTags(track.path, {
            includeLyrics: true,
            includeAnsiArt: false
        });
        var lyrics = trimValue(parsed.lyricsText || loadSidecarLyrics(track));

        if (!lyrics.length) {
            console.clear();
            printConsoleHeader(displayTrackTitle(track) + " Lyrics");
            console.writeln("No embedded or sidecar lyrics were found.");
            waitForAnyKey();
            return;
        }

        showPagedText(displayTrackTitle(track) + " Lyrics", lyrics);
    }

    function emitBrowserPlay(track: TrackSummary): string {
        var flweb: any = {};
        var relativeUrl = "/api/files.ssjs?call=stream-file&dir=" + encodeURIComponent(DIR_CODE) + "&file=" + encodeURIComponent(track.name);
        try {
            load(flweb, pathJoin(system.mods_dir, "load/flweb.js"));
            if (flweb && typeof flweb.openUrl === "function") {
                flweb.openUrl(relativeUrl, {
                    title: "Futureland Records",
                    text: "Opening " + displayTrackTitle(track),
                    target: "_blank"
                });
                return "Browser playback requested for:\n" + relativeUrl;
            }
            if (flweb && typeof flweb.toast === "function") {
                flweb.toast("Futureland Records", "Open " + relativeUrl + " in your browser.", {
                    duration: 9000,
                    hiddenOnly: false
                });
                return "FLWEB bridge is present but does not support direct URL launch yet.\n\nOpen this URL in the browser:\n" + relativeUrl;
            }
        } catch (err) {
            return "Browser bridge unavailable.\n\nOpen this URL in the browser:\n" + relativeUrl + "\n\n" + safeString(err);
        }
        return "Browser bridge unavailable.\n\nOpen this URL in the browser:\n" + relativeUrl;
    }

    function loadSidecarSyncedLyrics(track: TrackSummary): FLPlayer.LyricLine[] {
        var out: FLPlayer.LyricLine[] = [];
        var lrcPath = track.path.replace(/\.mp3$/i, ".lrc");
        if (!file_exists(lrcPath)) return out;
        var file = new File(lrcPath);
        if (!file.open("r")) return out;
        var raw: string;
        try {
            raw = file.read();
        } finally {
            file.close();
        }
        raw = raw.replace(/\r/g, "");
        var parts = raw.split("\n");
        for (var i = 0; i < parts.length; i += 1) {
            // A line may carry several [mm:ss.xx] tags (repeated chorus).
            var text = trimValue(parts[i].replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, ""));
            if (!text.length) continue;
            var rx = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
            var m: RegExpExecArray | null;
            while ((m = rx.exec(parts[i])) !== null) {
                var frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
                out.push({ time: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: text });
            }
        }
        out.sort(function (a: FLPlayer.LyricLine, b: FLPlayer.LyricLine): number {
            return a.time - b.time;
        });
        return out;
    }

    // AI co-writer avatars from the local-aidefinitions sub (same source the
    // web records page uses): base64 10x6 BIN between avatar_data markers in
    // each persona's thread-origin message body. Cached per session.
    var cowriterAvatarCache: { [name: string]: string } | null = null;

    function cowriterAvatars(): { [name: string]: string } {
        if (cowriterAvatarCache !== null) return cowriterAvatarCache;
        var map: { [name: string]: string } = {};
        var subCode = "local-aidefinitions";
        if (!msg_area.sub[subCode]) {
            cowriterAvatarCache = map;
            return map;
        }
        try {
            var msgBase = new MsgBase(subCode);
            if (msgBase.open()) {
                var headers: any = msgBase.get_all_msg_headers(true);
                var origins: { [threadId: string]: any } = {};
                for (var key in headers) {
                    if (!headers.hasOwnProperty(key)) continue;
                    var header = headers[key];
                    if (!header || (header.attr & MSG_DELETE)) continue;
                    if (!origins[safeString(header.thread_id)])
                        origins[safeString(header.thread_id)] = header;
                }
                for (var tid in origins) {
                    if (!origins.hasOwnProperty(tid)) continue;
                    var hdr = origins[tid];
                    var name = trimValue(safeString(hdr.subject).replace(/^re:\s*/i, ""));
                    if (!name.length) continue;
                    try {
                        var body = safeString(msgBase.get_msg_body(hdr.number));
                        var m1 = body.indexOf("avatar_data_begin");
                        var m2 = body.indexOf("avatar_data_end");
                        if (m1 >= 0 && m2 > m1) {
                            var b64 = body.substring(m1 + 17, m2).replace(/[\r\n\s]/g, "");
                            if (b64.length) map[lower(name)] = b64;
                        }
                    } catch (ignored) { }
                }
                msgBase.close();
            }
        } catch (err) {
            log(LOG_WARNING, "fl_records cowriter avatar load failed: " + safeString(err));
        }
        cowriterAvatarCache = map;
        return map;
    }

    // Resolve up to two 10x6 avatar BIN blobs for a track: split the artist
    // on feat./separators, then try AI co-writers, then local BBS users.
    function trackAvatars(track: TrackSummary): string[] {
        var out: string[] = [];
        var names: string[] = [];
        var raw = trimValue(displayTrackArtist(track));
        var parts = raw.split(/\s+feat\.?\s+|\s+featuring\s+|\s*[,&+]\s*|\s+x\s+/i);
        for (var i = 0; i < parts.length; i++) {
            var n = trimValue(parts[i]);
            if (n.length) names.push(n);
        }
        var comp = trimValue(track.composer);
        if (comp.length) names.push(comp);
        var seen: { [k: string]: boolean } = {};
        var aiMap = cowriterAvatars();
        var avatarLib: any = null;
        for (var j = 0; j < names.length && out.length < 2; j++) {
            var keyName = lower(names[j]);
            if (seen[keyName]) continue;
            seen[keyName] = true;
            var data = "";
            if (aiMap[keyName]) {
                data = aiMap[keyName];
            } else {
                try {
                    var un = system.matchuser(names[j]);
                    if (un > 0) {
                        if (avatarLib === null)
                            avatarLib = load({}, "avatar_lib.js");
                        var obj = avatarLib.read_localuser(un);
                        if (obj && obj.data && !obj.disabled)
                            data = safeString(obj.data);
                    }
                } catch (ignored2) { }
            }
            if (data.length) {
                var bin = base64_decode(data.replace(/[\r\n\s]/g, ""));
                if (bin.length >= 120)
                    out.push(bin);
            }
        }
        return out;
    }

    function playInTerminal(track: TrackSummary, list?: TrackSummary[], index?: number): void {
        withConsoleScreen(function (): void {
            console.clear();
            printConsoleHeader("Play In Terminal");
            console.writeln("Probing terminal audio support...");
            var sink = FLPlayer.detectSink();
            if (sink === "none") {
                console.writeln("");
                console.writeln("No terminal audio sink detected.");
                console.writeln("");
                console.writeln("Terminal playback works in SyncTERM (a current build with");
                console.writeln("APC audio) or through the BBSproxy shim. You can still use");
                console.writeln("[P] Play In Browser from the song menu.");
                waitForAnyKey();
                return;
            }
            console.writeln("Audio sink: " + (sink === "syncterm" ? "SyncTERM (libsndfile)" : "APC bridge"));

            var idx = typeof index === "number" ? index : 0;
            while (bbs.online && !js.terminated) {
                var cur = (list && list.length) ? list[idx] : track;
                var parsed = parseTrackTags(cur.path, {
                    includeLyrics: true,
                    includeAnsiArt: true
                });
                // Timed lyrics: embedded SYLT first, then a timestamped .lrc
                // sidecar; untimed text distributes evenly over the duration.
                var timed: FLPlayer.LyricLine[] = [];
                if (parsed.syncedLyrics && parsed.syncedLyrics.length) {
                    for (var si = 0; si < parsed.syncedLyrics.length; si++) {
                        timed.push({
                            time: parsed.syncedLyrics[si].time,
                            text: toScreenText(parsed.syncedLyrics[si].text)
                        });
                    }
                } else {
                    timed = loadSidecarSyncedLyrics(cur);
                }
                var flat = timed.length ? "" :
                    toScreenText(trimValue(parsed.lyricsText || loadSidecarLyrics(cur)));
                var playable: FLPlayer.PlayableTrack = {
                    path: cur.path,
                    name: cur.name,
                    size: cur.size,
                    mtime: cur.mtime,
                    title: toScreenText(displayTrackTitle(cur)),
                    artist: toScreenText(displayTrackArtist(cur)),
                    ansiArt: parsed.ansiArtBase64.length ? base64_decode(parsed.ansiArtBase64) : "",
                    lyrics: timed,
                    flatLyrics: flat,
                    avatars: trackAvatars(cur)
                };
                var outcome = FLPlayer.playTrack(playable);
                // Jukebox flow: a song ending naturally advances to the next
                // track in the filtered list; N/P move manually; Q/Esc exits.
                if (outcome === "next" || outcome === "ended") {
                    if (!list || !list.length || idx + 1 >= list.length)
                        return;
                    idx++;
                    continue;
                }
                if (outcome === "prev") {
                    if (!list || !list.length)
                        return;
                    idx = idx > 0 ? idx - 1 : 0;
                    continue;
                }
                return;
            }
        });
    }

    function showTrackDetail(track: TrackSummary, list?: TrackSummary[], index?: number): void {
        withConsoleScreen(function (): void {
            var key: string;
            var parsed: ParsedTrackTags;
            while (bbs.online && !js.terminated) {
                console.clear();
                printConsoleHeader(displayTrackTitle(track));
                console.writeln("Artist:      " + toScreenText(displayTrackArtist(track)));
                console.writeln("Composer:    " + toScreenText(trimValue(track.composer) || "-"));
                console.writeln("Genre:       " + toScreenText(trimValue(track.genre) || "-"));
                console.writeln("Album / Year:" + " " + toScreenText(trimValue(track.album) || "-") + " / " + toScreenText(trimValue(track.year) || "-"));
                console.writeln("Filename:    " + track.name);
                console.writeln("");
                console.writeln("[T] Play In Terminal");
                console.writeln("[A] Show Song Artwork");
                console.writeln("[L] Show Song Lyrics");
                console.writeln("[M] Show Full Metadata");
                console.writeln("[P] Play In Browser");
                console.writeln("[B] Back To Track List");
                console.writeln("");
                console.write("Selection: ");
                key = safeString(console.getkey(K_NONE)).toUpperCase();
                if (key === "T") {
                    playInTerminal(track, list, typeof index === "number" ? index : 0);
                } else if (key === "A") {
                    showTrackArt(track);
                } else if (key === "L") {
                    showTrackLyrics(track);
                } else if (key === "M") {
                    parsed = parseTrackTags(track.path, {
                        includeLyrics: true,
                        includeAnsiArt: true
                    });
                    showPagedText(displayTrackTitle(track) + " Metadata", formatFullMetadata(track, parsed));
                } else if (key === "P") {
                    showPagedText("Play In Browser", emitBrowserPlay(track));
                } else if (key === "B" || key === "Q" || key === "\u001b" || key === "\r") {
                    return;
                }
            }
        });
    }

    function browseTracks(app: AppState): void {
        var options: string[];
        var filtered: TrackSummary[];
        var selection: number;
        while (bbs.online && !js.terminated) {
            filtered = getFilteredTracks(app);
            options = [
                "[Filters] " + truncateText(filterSummary(app.filters), 72),
                "[Refresh Catalog Cache]"
            ];
            if (!filtered.length) {
                options.push("No tracks match the current filters.");
            } else {
                options = options.concat(filtered.map(trackRow));
            }
            uifc.help_text = "The first row edits filters. Select any song row to open its detail view.";
            selection = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                "Read / Listen  (" + filtered.length + " of " + app.catalog.length + " tracks)",
                options,
                app.trackListCtx
            );
            if (selection < 0) return;
            if (selection === 0) {
                editTrackFilters(app);
                continue;
            }
            if (selection === 1) {
                app.catalog = loadCatalog(true);
                continue;
            }
            if (!filtered.length) continue;
            showTrackDetail(filtered[selection - 2], filtered, selection - 2);
        }
    }

    function choosePresetValue(title: string, current: string, options: string[], blankLabel: string): string {
        var items = [blankLabel, "Custom..."].concat(options.map(function (entry: string): string {
            return toScreenText(entry);
        }));
        var ctx = new uifc.list.CTX();
        var selection: number;
        selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, title, items, ctx);
        if (selection < 0) return current;
        if (selection === 0) return "";
        if (selection === 1) {
            var custom = promptInput(title + " (Custom)", current, 120, K_EDIT);
            return custom === null ? current : trimValue(custom);
        }
        return options[selection - 2];
    }

    function chooseLabelValue(title: string, current: string, options: FLRecordsData.LabelValueOption[], blankLabel: string): string {
        var items = [blankLabel].concat(options.map(function (entry: FLRecordsData.LabelValueOption): string {
            return toScreenText(entry.label);
        }));
        var selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, title, items, new uifc.list.CTX());
        if (selection < 0) return current;
        if (selection === 0) return "";
        return options[selection - 1].value;
    }

    function pickRandom(items: string[]): string {
        if (!items.length) return "";
        return items[Math.floor(Math.random() * items.length)];
    }

    function randomizeStyle(state: ComposeState): void {
        state.genre = pickRandom(FLRecordsData.presetOptions.genre);
        state.feel = pickRandom(FLRecordsData.presetOptions.feel);
        state.tone = pickRandom(FLRecordsData.presetOptions.tone);
        state.arrangement = pickRandom(FLRecordsData.presetOptions.arrangement);
        state.instrumentation = pickRandom(FLRecordsData.presetOptions.instrumentation);
        state.groove = pickRandom(FLRecordsData.presetOptions.groove);
        state.band = pickRandom(FLRecordsData.presetOptions.band);
        state.leadvocal = pickRandom(FLRecordsData.presetOptions.leadvocal);
        state.backingvocal = pickRandom(FLRecordsData.presetOptions.backingvocal);
    }

    function editBlockText(title: string, current: string): string {
        var saved = current;
        var lines: string[] = [];
        var input: string;
        withConsoleScreen(function (): void {
            console.clear();
            printConsoleHeader(title);
            if (trimValue(saved).length) {
                console.writeln("Current text:");
                console.writeln(repeatChar("-", 12));
                console.writeln(toScreenText(saved));
                console.writeln("");
            } else {
                console.writeln("Current text is empty.");
                console.writeln("");
            }
            console.writeln("Enter replacement lines one at a time.");
            console.writeln("Use /done to save, /cancel to keep the current text.");
            console.writeln("");
            while (bbs.online && !js.terminated) {
                console.write(format("%02d> ", lines.length + 1));
                input = safeString(console.getstr(240, K_EDIT));
                if (trimValue(input).toUpperCase() === "/CANCEL") {
                    lines = [];
                    break;
                }
                if (trimValue(input).toUpperCase() === "/DONE") {
                    break;
                }
                lines.push(input);
                if (lines.length >= 64) break;
            }
            if (lines.length) saved = lines.join("\n");
        });
        return saved;
    }

    function buildStylePrompt(state: ComposeState): string {
        var phrases: string[] = [];
        var prefix = state.genre.length ? (state.genre + ": ") : "";
        if (trimValue(state.brief).length) phrases.push(sentence(state.brief));
        if (trimValue(state.feel).length || trimValue(state.tone).length) {
            phrases.push(sentence("Mood and feel: " + [state.feel, state.tone].filter(Boolean).join(", ")));
        }
        if (trimValue(state.instrumentation).length) phrases.push(sentence("Built around " + state.instrumentation));
        if (trimValue(state.groove).length) phrases.push(sentence("Groove: " + state.groove));
        if (trimValue(state.band).length) phrases.push(sentence("Players: " + state.band));
        if (trimValue(state.leadvocal).length) phrases.push(sentence("Lead singer type: " + state.leadvocal));
        if (trimValue(state.backingvocal).length) phrases.push(sentence("Background singer type: " + state.backingvocal));
        if (trimValue(state.arrangement).length) phrases.push(sentence("Arrangement: " + state.arrangement));
        if (trimValue(state.notes).length) phrases.push(sentence("Extra direction: " + state.notes));

        if (!phrases.length) return state.genre;
        return prefix + phrases.join(" ");
    }

    function buildGuidedLyrics(state: ComposeState): string {
        var blocks: string[] = [];
        var i: number;
        var section: FLRecordsData.SectionDef;
        var sectionState: GuidedSectionState;
        var heading: string;

        for (i = 0; i < FLRecordsData.sectionDefs.length; i += 1) {
            section = FLRecordsData.sectionDefs[i];
            sectionState = state.sections[section.key];
            if (!sectionState) continue;
            if (!trimValue(sectionState.notes).length && !trimValue(sectionState.text).length) continue;
            heading = "[" + section.label;
            if (trimValue(sectionState.notes).length) heading += " - " + trimValue(sectionState.notes);
            heading += "]";
            blocks.push(heading);
            if (trimValue(sectionState.text).length) blocks.push(trimValue(sectionState.text));
            blocks.push("");
        }

        while (blocks.length && !trimValue(blocks[blocks.length - 1]).length) blocks.pop();
        return blocks.join("\n");
    }

    function buildLyricsPrompt(state: ComposeState): string {
        if (state.lyricMode === "guided") return buildGuidedLyrics(state);
        return trimValue(state.lyricsFreeform);
    }

    function getTempoLabel(state: ComposeState): string {
        if (state.bpmMode === "custom_numeric") return trimValue(state.bpmValue).length ? (trimValue(state.bpmValue) + " BPM") : "";
        if (state.bpmMode === "slow_genre") return "Slow for the chosen genre";
        if (state.bpmMode === "mid_genre") return "Midtempo for the chosen genre";
        if (state.bpmMode === "fast_genre") return "Fast for the chosen genre";
        if (state.bpmMode === "half_time") return "Half-time feel";
        if (state.bpmMode === "double_time") return "Double-time feel";
        if (state.bpmMode === "rubato") return "Rubato / free tempo";
        if (state.bpmMode === "accelerando") return "Gradual accelerando";
        if (state.bpmMode === "genre_default") return "Match the genre default";
        return "";
    }

    function buildPreview(state: ComposeState): string {
        var lines: string[] = [];
        var stylePrompt = buildStylePrompt(state);
        var lyricsPrompt = buildLyricsPrompt(state);
        var explicitLines: string[] = [];
        var prefix = state.memoryActive ? "+++" : "++++";
        if (trimValue(state.cowriter).length) prefix += "^" + trimValue(state.cowriter);

        lines.push(prefix);
        lines.push("");

        if (trimValue(state.songTitle).length) {
            lines.push("Title: " + trimValue(state.songTitle));
            lines.push("");
        }

        if (stylePrompt.length) {
            lines.push("[Style Prompt]");
            lines.push(stylePrompt);
            lines.push("");
        }

        if (lyricsPrompt.length) {
            lines.push("[Lyrics Director]");
            lines.push(lyricsPrompt);
            lines.push("");
        }

        if (trimValue(state.language).length) explicitLines.push("Language: " + trimValue(state.language));
        if (getTempoLabel(state).length) explicitLines.push("BPM: " + getTempoLabel(state));
        if (trimValue(state.timesig).length) explicitLines.push("Time Signature: " + trimValue(state.timesig));
        if (trimValue(state.key).length) explicitLines.push("Key Signature: " + trimValue(state.key));
        if (trimValue(state.duration).length) explicitLines.push("Duration: " + trimValue(state.duration) + " seconds");

        if (explicitLines.length) {
            lines.push("[Musical Composition Director]");
            lines = lines.concat(explicitLines);
        }

        while (lines.length && !trimValue(lines[lines.length - 1]).length) lines.pop();
        if (!lines.length) {
            lines.push("Add a story seed, lyrics, notes, or randomize the style to build a minimal Vektrax prompt.");
        }
        return lines.join("\n");
    }

    function isPromptEmpty(state: ComposeState): boolean {
        return !trimValue(state.songTitle).length &&
            !buildStylePrompt(state).length &&
            !buildLyricsPrompt(state).length &&
            !trimValue(state.language).length &&
            !getTempoLabel(state).length &&
            !trimValue(state.key).length &&
            !trimValue(state.timesig).length &&
            !trimValue(state.duration).length;
    }

    function loadCowriters(): string[] {
        var names: string[] = [];
        var seen: { [name: string]: boolean } = {};
        var subCode = "local-aidefinitions";
        var msgBase: MsgBase;
        var headers: any;
        var threadOrigins: { [threadId: string]: any } = {};
        var order: string[] = [];
        var key: string;
        var header: any;
        var subject: string;

        if (!msg_area.sub[subCode]) return names;
        try {
            msgBase = new MsgBase(subCode);
            if (!msgBase.open()) return names;
            headers = msgBase.get_all_msg_headers(true);
            for (key in headers) {
                if (!headers.hasOwnProperty(key)) continue;
                header = headers[key];
                if (!header) continue;
                if (header.attr & MSG_DELETE) continue;
                if (!threadOrigins[safeString(header.thread_id)]) {
                    threadOrigins[safeString(header.thread_id)] = header;
                    order.push(safeString(header.thread_id));
                }
            }
            for (var i = 0; i < order.length; i += 1) {
                header = threadOrigins[order[i]];
                subject = trimValue(safeString(header.subject).replace(/^re:\s*/i, ""));
                if (!subject.length || seen[lower(subject)]) continue;
                seen[lower(subject)] = true;
                names.push(subject);
            }
            msgBase.close();
        } catch (err) {
            log(LOG_WARNING, "fl_records cowriter load failed: " + safeString(err));
        }
        names.sort(function (a: string, b: string): number {
            return lower(a) < lower(b) ? -1 : 1;
        });
        return names;
    }

    function editSongDna(state: ComposeState): void {
        var options: string[];
        var choice: number;
        var input: string | null;
        while (bbs.online && !js.terminated) {
            options = [
                "Song title          " + summarizeValue(state.songTitle, 34),
                "Brief               " + summarizeValue(state.brief, 34),
                "Genre               " + summarizeValue(state.genre, 34),
                "Feel                " + summarizeValue(state.feel, 34),
                "Tone                " + summarizeValue(state.tone, 34),
                "Arrangement         " + summarizeValue(state.arrangement, 34),
                "Extra notes         " + summarizeValue(state.notes, 34),
                "Back"
            ];
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Song DNA", options, new uifc.list.CTX());
            if (choice < 0 || choice === 7) return;
            if (choice === 0) {
                input = promptInput("Song title", state.songTitle, 120, K_EDIT);
                if (input !== null) state.songTitle = trimValue(input);
            } else if (choice === 1) {
                input = promptInput("Brief", state.brief, 240, K_EDIT);
                if (input !== null) state.brief = trimValue(input);
            } else if (choice === 2) {
                state.genre = choosePresetValue("Genre", state.genre, FLRecordsData.presetOptions.genre, "Unspecified");
            } else if (choice === 3) {
                state.feel = choosePresetValue("Feel", state.feel, FLRecordsData.presetOptions.feel, "Unspecified");
            } else if (choice === 4) {
                state.tone = choosePresetValue("Tone", state.tone, FLRecordsData.presetOptions.tone, "Unspecified");
            } else if (choice === 5) {
                state.arrangement = choosePresetValue("Arrangement", state.arrangement, FLRecordsData.presetOptions.arrangement, "Unspecified");
            } else if (choice === 6) {
                input = promptInput("Extra notes", state.notes, 240, K_EDIT);
                if (input !== null) state.notes = trimValue(input);
            }
        }
    }

    function editGuidedSection(section: FLRecordsData.SectionDef, state: ComposeState): void {
        var sectionState = state.sections[section.key];
        var choice: number;
        var input: string | null;
        while (bbs.online && !js.terminated) {
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                section.label,
                [
                    "Guidance notes      " + summarizeValue(sectionState.notes, 34),
                    "Section text        " + summarizeValue(sectionState.text, 34),
                    "Clear section",
                    "Back"
                ],
                new uifc.list.CTX()
            );
            if (choice < 0 || choice === 3) return;
            if (choice === 0) {
                input = promptInput(section.label + " notes", sectionState.notes, 120, K_EDIT);
                if (input !== null) sectionState.notes = trimValue(input);
            } else if (choice === 1) {
                sectionState.text = editBlockText(section.label + " text", sectionState.text);
            } else if (choice === 2) {
                sectionState.notes = "";
                sectionState.text = "";
            }
        }
    }

    function editLyrics(state: ComposeState): void {
        var options: string[];
        var choice: number;
        var modeLabel: string;
        var section: FLRecordsData.SectionDef;
        var modeChoice: number;
        while (bbs.online && !js.terminated) {
            modeLabel = state.lyricMode === "guided" ? "Guided sections" : "Freeform";
            options = [
                "Mode                " + modeLabel
            ];
            if (state.lyricMode === "guided") {
                for (var i = 0; i < FLRecordsData.sectionDefs.length; i += 1) {
                    section = FLRecordsData.sectionDefs[i];
                    var summary = state.sections[section.key];
                    options.push(section.label + "          " + summarizeValue(summary.notes || summary.text, 34));
                }
                options.push("Clear all guided sections");
            } else {
                options.push("Edit freeform lyrics  " + summarizeValue(state.lyricsFreeform, 30));
                options.push("Clear freeform lyrics");
            }
            options.push("Back");
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Lyrics Director", options, new uifc.list.CTX());
            if (choice < 0 || choice === options.length - 1) return;
            if (choice === 0) {
                modeChoice = uifc.list(
                    WIN_ESC | WIN_SAV | WIN_ACT,
                    "Lyric Mode",
                    ["Freeform", "Guided sections"],
                    new uifc.list.CTX()
                );
                if (modeChoice === 1) {
                    state.lyricMode = "guided";
                } else if (modeChoice === 0) {
                    state.lyricMode = "freeform";
                }
            } else if (state.lyricMode === "guided") {
                if (choice <= FLRecordsData.sectionDefs.length) {
                    editGuidedSection(FLRecordsData.sectionDefs[choice - 1], state);
                } else {
                    for (var j = 0; j < FLRecordsData.sectionDefs.length; j += 1) {
                        state.sections[FLRecordsData.sectionDefs[j].key].notes = "";
                        state.sections[FLRecordsData.sectionDefs[j].key].text = "";
                    }
                }
            } else if (choice === 1) {
                state.lyricsFreeform = editBlockText("Freeform lyrics", state.lyricsFreeform);
            } else if (choice === 2) {
                state.lyricsFreeform = "";
            }
        }
    }

    function editMusicDirection(state: ComposeState): void {
        var choice: number;
        var input: string | null;
        while (bbs.online && !js.terminated) {
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                "Music Direction",
                [
                    "Instrumentation     " + summarizeValue(state.instrumentation, 34),
                    "Groove              " + summarizeValue(state.groove, 34),
                    "Band                " + summarizeValue(state.band, 34),
                    "Lead vocal          " + summarizeValue(state.leadvocal, 34),
                    "Backing vocals      " + summarizeValue(state.backingvocal, 34),
                    "Language            " + summarizeValue(state.language, 34),
                    "Tempo               " + summarizeValue(getTempoLabel(state), 34),
                    "Key                 " + summarizeValue(state.key, 34),
                    "Time signature      " + summarizeValue(state.timesig, 34),
                    "Duration (seconds)  " + summarizeValue(state.duration, 34),
                    "Back"
                ],
                new uifc.list.CTX()
            );
            if (choice < 0 || choice === 10) return;
            if (choice === 0) {
                state.instrumentation = choosePresetValue("Instrumentation", state.instrumentation, FLRecordsData.presetOptions.instrumentation, "Unspecified");
            } else if (choice === 1) {
                state.groove = choosePresetValue("Groove", state.groove, FLRecordsData.presetOptions.groove, "Unspecified");
            } else if (choice === 2) {
                state.band = choosePresetValue("Band", state.band, FLRecordsData.presetOptions.band, "Unspecified");
            } else if (choice === 3) {
                state.leadvocal = choosePresetValue("Lead vocal", state.leadvocal, FLRecordsData.presetOptions.leadvocal, "Unspecified");
            } else if (choice === 4) {
                state.backingvocal = choosePresetValue("Backing vocals", state.backingvocal, FLRecordsData.presetOptions.backingvocal, "Unspecified");
            } else if (choice === 5) {
                state.language = choosePresetValue("Language", state.language, FLRecordsData.presetOptions.language, "Unspecified");
            } else if (choice === 6) {
                state.bpmMode = chooseLabelValue("Tempo mode", state.bpmMode, FLRecordsData.presetOptions.bpmMode, "Unspecified");
                if (state.bpmMode === "custom_numeric") {
                    input = promptInput("Custom BPM", state.bpmValue, 6, K_EDIT | K_NUMBER);
                    if (input !== null) state.bpmValue = trimValue(input);
                }
            } else if (choice === 7) {
                state.key = choosePresetValue("Key", state.key, FLRecordsData.presetOptions.key, "Unspecified");
            } else if (choice === 8) {
                state.timesig = choosePresetValue("Time signature", state.timesig, FLRecordsData.presetOptions.timesig, "Unspecified");
            } else if (choice === 9) {
                input = promptInput("Duration (seconds)", state.duration, 6, K_EDIT | K_NUMBER);
                if (input !== null) state.duration = trimValue(input);
            }
        }
    }

    function editSession(state: ComposeState, cowriters: string[]): void {
        var choice: number;
        while (bbs.online && !js.terminated) {
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                "Session Options",
                [
                    "Memory mode         " + (state.memoryActive ? "Memory" : "Blank Slate"),
                    "AI co-writer        " + summarizeValue(state.cowriter || "None", 34),
                    "Wait for response   " + (state.waitForResponse ? "Yes" : "No"),
                    "Back"
                ],
                new uifc.list.CTX()
            );
            if (choice < 0 || choice === 3) return;
            if (choice === 0) {
                state.memoryActive = !state.memoryActive;
            } else if (choice === 1) {
                state.cowriter = chooseValueMenu("AI Co-writer", state.cowriter, cowriters, "No co-writer");
            } else if (choice === 2) {
                state.waitForResponse = !state.waitForResponse;
            }
        }
    }

    function sendPromptToChat(prompt: string): string {
        var chatOptions = load("modopts.js", "jsonchat") || {};
        var client: JSONClient;
        var chat: JSONChat;
        if (!chatOptions.host || isNaN(chatOptions.port)) {
            return "jsonchat modopts are missing host/port.";
        }
        try {
            load("json-client.js");
            load(pathJoin(system.mods_dir, "load/json-chat.js"));
            client = new JSONClient(chatOptions.host, chatOptions.port);
            chat = new JSONChat(user.number, client);
            if (!chat.connect()) return "Could not connect to JSON chat service.";
            chat.join(CHAT_CHANNEL);
            chat.submit(CHAT_CHANNEL, prompt);
            chat.disconnect();
            try { client.disconnect(); } catch (_) { }
            return "";
        } catch (err) {
            return safeString(err);
        }
    }

    function waitForVektrax(): void {
        withConsoleScreen(function (): void {
            var chatOptions = load("modopts.js", "jsonchat") || {};
            var client: JSONClient;
            var chat: JSONChat;
            var since = Date.now();
            var chan: any;
            var messages: any[];
            var message: any;
            var key: string;

            if (!chatOptions.host || isNaN(chatOptions.port)) {
                console.writeln("JSON chat is not configured.");
                waitForAnyKey();
                return;
            }

            try {
                load("json-client.js");
                load(pathJoin(system.mods_dir, "load/json-chat.js"));
                client = new JSONClient(chatOptions.host, chatOptions.port);
                chat = new JSONChat(user.number, client);
                if (!chat.connect()) {
                    console.writeln("Could not connect to JSON chat.");
                    waitForAnyKey();
                    return;
                }
                chat.join(CHAT_CHANNEL);
            } catch (err) {
                console.writeln("Chat monitor failed to start: " + safeString(err));
                waitForAnyKey();
                return;
            }

            console.clear();
            printConsoleHeader("Waiting For Vektrax");
            console.writeln("Watching main chat for new Vektrax messages.");
            console.writeln("Press Q or ESC to stop waiting.");
            console.writeln("");

            while (bbs.online && !js.terminated) {
                chat.cycle();
                chan = chat.channels[CHAT_CHANNEL.toUpperCase()];
                if (chan && chan.messages && chan.messages.length) {
                    messages = chan.messages.slice(0);
                    chan.messages = [];
                    for (var i = 0; i < messages.length; i += 1) {
                        message = messages[i];
                        if (!message || !message.nick || !message.nick.name) continue;
                        if (safeString(message.nick.name) !== "Vektrax") continue;
                        if (typeof message.time === "number" && message.time < since) continue;
                        console.writeln("[" + safeString(message.nick.name) + "] " + toScreenText(message.str || ""));
                        console.writeln("");
                    }
                }
                key = safeString(console.inkey(K_NONE, 1)).toUpperCase();
                if (key === "Q" || key === "\u001b") break;
            }

            try { chat.disconnect(); } catch (_) { }
            try { client.disconnect(); } catch (_) { }
        });
    }

    function resetComposeState(state: ComposeState): ComposeState {
        return createComposeState();
    }

    function composeMenu(app: AppState): void {
        var state = app.compose;
        var choice: number;
        var sendResult: string;
        while (bbs.online && !js.terminated) {
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                "Create / Compose",
                [
                    "Song DNA           " + summarizeValue(state.songTitle || state.genre || "Start here", 34),
                    "Lyrics Director    " + summarizeValue(state.lyricMode === "guided" ? "Guided sections" : state.lyricsFreeform || "Freeform", 34),
                    "Music Direction    " + summarizeValue(state.instrumentation || state.language || "Set arrangement", 34),
                    "Session Options    " + summarizeValue(state.cowriter || (state.memoryActive ? "Memory" : "Blank Slate"), 34),
                    "Randomize style",
                    "Preview prompt",
                    "Send to Vektrax",
                    "Reset builder",
                    "Back"
                ],
                app.composeMenuCtx
            );
            if (choice < 0 || choice === 8) return;
            if (choice === 0) {
                editSongDna(state);
            } else if (choice === 1) {
                editLyrics(state);
            } else if (choice === 2) {
                editMusicDirection(state);
            } else if (choice === 3) {
                editSession(state, app.cowriters);
            } else if (choice === 4) {
                randomizeStyle(state);
            } else if (choice === 5) {
                showPagedText("Prompt Preview", buildPreview(state));
            } else if (choice === 6) {
                if (isPromptEmpty(state)) {
                    uifc.msg("The prompt is empty. Fill in at least one field before sending.");
                    continue;
                }
                showPagedText("Prompt Preview", buildPreview(state));
                if (uifc.list(WIN_MID | WIN_SAV, "Send prompt to Vektrax?", ["No", "Yes"]) !== 1) {
                    continue;
                }
                sendResult = sendPromptToChat(buildPreview(state));
                if (sendResult.length) {
                    uifc.msg("Send failed: " + sendResult);
                } else {
                    uifc.msg("Prompt sent to Vektrax.");
                    if (state.waitForResponse) waitForVektrax();
                }
            } else if (choice === 7) {
                app.compose = resetComposeState(state);
                state = app.compose;
            }
        }
    }

    function mainMenu(app: AppState): void {
        var choice: number;
        while (bbs.online && !js.terminated) {
            uifc.help_text = "Read / Listen opens the filterable song list. Create / Compose builds a Vektrax prompt in a grouped terminal workflow.";
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                APP_TITLE,
                [
                    "Read / Listen      " + app.catalog.length + " tracks",
                    "Create / Compose",
                    "Refresh Catalog Cache",
                    "Quit"
                ],
                app.mainMenuCtx
            );
            if (choice < 0 || choice === 3) return;
            if (choice === 0) {
                browseTracks(app);
            } else if (choice === 1) {
                composeMenu(app);
            } else if (choice === 2) {
                app.catalog = loadCatalog(true);
            }
        }
    }

    function main(): void {
        if (typeof argv !== "undefined" && argv && argv.indexOf("--selftest") >= 0) {
            FLPlayer.selfTest();
            return;
        }
        var app = createAppState();
        try {
            app.catalog = loadCatalog(false);
            app.cowriters = loadCowriters();
            initUi();
            mainMenu(app);
        } catch (err) {
            safeBailUi();
            console.clear();
            console.writeln(APP_TITLE);
            console.writeln("");
            console.writeln("Startup failed:");
            console.writeln(safeString(err));
            console.pause();
        } finally {
            safeBailUi();
        }
    }

    main();
})();
