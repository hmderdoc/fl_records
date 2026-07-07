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
    var CACHE_VERSION = 2;
    // Sentinel returned by uifc.list when a caller-defined hotkey is pressed
    // (distinct from a row index >= 0 and from Esc's -1).
    var UI_ACTION_DETAIL = -2;
    // The single app state, so the in-player Browse/Create actions can reach the
    // catalog and compose flow without threading it through every call.
    var activeApp: AppState;
    var CACHE_FILE = "catalog-cache.json";

    var uiReady = false;

    load("sbbsdefs.js");
    load("uifcdefs.js");
    try { load("userdefs.js"); } catch (_) { }
    try { load("utf8_cp437.js"); } catch (_) { }
    try { load("utf8_utf16.js"); } catch (_) { }
    try { load("json-db.js"); } catch (_) { }   // per-user playlist storage

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
            title: screenSafe(cached.title || ""),
            artist: screenSafe(cached.artist || ""),
            composer: screenSafe(cached.composer || ""),
            genre: screenSafe(cached.genre || ""),
            album: screenSafe(cached.album || ""),
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
            title: screenSafe(parsed.title),
            artist: screenSafe(parsed.artist),
            composer: screenSafe(parsed.composer),
            genre: screenSafe(parsed.genre),
            album: screenSafe(parsed.album),
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

    // Per-track tag overrides shared with the web records page: the web tag
    // manager writes data/futureland-records/track-overrides.ini (section =
    // lowercase filename), layering artist/title/etc over the file's ID3.
    // Without this the door shows the raw engine tag ("Vektrax") while the
    // web shows the assigned persona ("CINDER") — and resolves wrong avatars.
    function loadTrackOverrides(): { [fname: string]: any } {
        var map: { [fname: string]: any } = {};
        var path = backslash(system.data_dir) + "futureland-records/track-overrides.ini";
        if (!file_exists(path)) return map;
        var f = new File(path);
        if (!f.open("r")) return map;
        try {
            var sections = f.iniGetSections() || [];
            for (var i = 0; i < sections.length; i++) {
                var obj = f.iniGetObject(sections[i]);
                if (obj) map[lower(sections[i])] = obj;
            }
        } catch (err) {
            log(LOG_WARNING, "fl_records track overrides load failed: " + safeString(err));
        } finally {
            f.close();
        }
        return map;
    }

    function applyTrackOverrides(tracks: TrackSummary[]): void {
        var overrides = loadTrackOverrides();
        var fields = ["title", "artist", "composer", "genre", "year", "album"];
        for (var i = 0; i < tracks.length; i++) {
            var ov = overrides[lower(tracks[i].name)];
            if (!ov) continue;
            for (var fIdx = 0; fIdx < fields.length; fIdx++) {
                var v = trimValue(ov[fields[fIdx]]);
                if (v.length)
                    (tracks[i] as any)[fields[fIdx]] = v;
            }
        }
    }

    function loadCatalog(forceRefresh: boolean): TrackSummary[] {
        var tracks = loadCatalogInner(forceRefresh);
        applyTrackOverrides(tracks);
        return tracks;
    }

    function loadCatalogInner(forceRefresh: boolean): TrackSummary[] {
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

    // --- decorative-Unicode transliteration ---------------------------------
    // AI-generated artist handles use small-caps, fullwidth, accented, and
    // emoji glyphs (e.g. "🗲ᴍʀᴏ1337" — a decorated
    // "mro1337"). Their codepoints are >0xFF; rendered on a CP437 terminal each
    // is truncated to 8 bits and some land on C0 controls (U+1D0D -> 0x0D CR)
    // that jump the cursor, smear the list, and corrupt the JSON cache. Fold
    // everything to plain ASCII so metadata is safe on every terminal.
    var SMALL_CAPS: { [cp: number]: string } = {
        0x1D00: "a", 0x0299: "b", 0x1D04: "c", 0x1D05: "d", 0x1D07: "e", 0xA730: "f",
        0x0262: "g", 0x029C: "h", 0x026A: "i", 0x1D0A: "j", 0x1D0B: "k", 0x029F: "l",
        0x1D0D: "m", 0x0274: "n", 0x1D0F: "o", 0x1D18: "p", 0xA7AF: "q", 0x0280: "r",
        0xA731: "s", 0x1D1B: "t", 0x1D1C: "u", 0x1D20: "v", 0x1D21: "w", 0x028F: "y",
        0x1D22: "z", 0x1D01: "ae"
    };
    var GLYPH_ASCII: { [cp: number]: string } = {
        0x2018: "'", 0x2019: "'", 0x201A: "'", 0x2032: "'",
        0x201C: "\"", 0x201D: "\"", 0x201E: "\"", 0x2033: "\"",
        0x2013: "-", 0x2014: "-", 0x2015: "-", 0x2212: "-",
        0x2026: "...", 0x2022: "*", 0x00B7: "*", 0x00D7: "x", 0x00F7: "/",
        0x2260: "!=", 0x2264: "<=", 0x2265: ">=", 0x00B1: "+/-",
        0x00A9: "(c)", 0x00AE: "(r)", 0x2122: "tm", 0x00B0: "deg",
        0x00C6: "AE", 0x00E6: "ae", 0x0152: "OE", 0x0153: "oe", 0x00DF: "ss",
        0x20AC: "EUR", 0x00A3: "GBP", 0x00A5: "JPY", 0x00A2: "c"
    };
    // Latin-1 accented letters 0xC0..0xFF -> base ASCII. A space means "handled
    // above / drop" (index by codepoint - 0xC0).
    var LATIN1_FOLD = "AAAAAAACEEEEIIIIDNOOOOO OUUUUYT aaaaaaaceeeeiiiidnooooo ouuuuyty";

    // Collapse decorative text to terminal-safe ASCII. Idempotent on clean text.
    function screenSafe(value: any): string {
        var s = safeString(value);
        if (!s.length) return "";
        // Raw UTF-8 bytes (e.g. straight from an .ini) -> codepoints first, so
        // multibyte glyphs fold as a unit instead of being mangled byte-by-byte.
        if (typeof str_is_utf8 === "function" && typeof utf8_utf16 === "function") {
            try {
                if (str_is_utf8(s) && /[\x80-\xff]/.test(s)) s = utf8_utf16(s);
            } catch (_) {
            }
        }
        var out = "";
        for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            if (c === 0x09) { out += " "; continue; }          // tab -> space
            if (c < 0x20 || c === 0x7f) continue;              // strip C0 controls + DEL
            if (c <= 0x7e) { out += s.charAt(i); continue; }   // printable ASCII
            if (SMALL_CAPS[c] !== undefined) { out += SMALL_CAPS[c]; continue; }
            if (GLYPH_ASCII[c] !== undefined) { out += GLYPH_ASCII[c]; continue; }
            if (c >= 0xc0 && c <= 0xff) {
                var f = LATIN1_FOLD.charAt(c - 0xc0);
                if (f !== " ") out += f;
                continue;
            }
            if (c >= 0xff01 && c <= 0xff5e) { out += String.fromCharCode(c - 0xfee0); continue; }
            // Unknown decorative / emoji / symbol: drop it.
        }
        return out.replace(/[ \t]{2,}/g, " ").replace(/^\s+|\s+$/g, "");
    }

    function toScreenText(value: any): string {
        return screenSafe(value);
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
                "Search text         " + summarizeValue(app.filters.search, composeValueWidth()),
                "Artist              " + summarizeValue(app.filters.artist || "All artists", composeValueWidth()),
                "Composer            " + summarizeValue(app.filters.composer || "All composers", composeValueWidth()),
                "Genre               " + summarizeValue(app.filters.genre || "All genres", composeValueWidth()),
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

    // How much room a field's value gets in the compose menus, given the ~20-col
    // label. Grows with the terminal (80-col floor) so long briefs use the screen
    // instead of being clipped to a fixed width in the middle of a big display.
    function composeValueWidth(): number {
        var cols = console.screen_columns || 80;
        if (cols < 80) cols = 80;
        return Math.max(34, cols - 28);
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
    var trackAvatarCache: { [key: string]: string[] } = {};

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
        var cacheKey = track.name + ":" + track.size + ":" + track.mtime;
        if (trackAvatarCache[cacheKey]) return trackAvatarCache[cacheKey].slice(0);
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
        for (var j = 0; j < names.length && out.length < 4; j++) {
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
        trackAvatarCache[cacheKey] = out.slice(0);
        return out;
    }

    // Build a varied crowd from the other songs in the current radio/playlist
    // queue. The active track's performers remain residents; these avatars are
    // dormant until the mosh-pit motion mode begins.
    function queueMoshAvatars(list: TrackSummary[], current: TrackSummary, residents: string[]): string[] {
        var out: string[] = [];
        var seen: { [data: string]: boolean } = {};
        for (var r = 0; r < residents.length; r++) seen[residents[r]] = true;
        if (!list.length) return out;
        var start = Math.floor(Math.random() * list.length);
        for (var n = 0; n < list.length && out.length < 10; n++) {
            var candidate = list[(start + n) % list.length];
            if (candidate.name === current.name) continue;
            var found = trackAvatars(candidate);
            for (var a = 0; a < found.length && out.length < 10; a++) {
                if (!seen[found[a]]) { seen[found[a]] = true; out.push(found[a]); }
            }
        }
        return out;
    }

    function playInTerminal(track: TrackSummary, list?: TrackSummary[], index?: number, playlistName?: string): void {
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

            var curList = (list && list.length) ? list : [track];
            var idx = typeof index === "number" ? Math.max(0, Math.min(index, curList.length - 1)) : 0;
            var currentPlaylist = playlistName || "";   // set when the queue is a playlist (enables [R]emove)
            var history: number[] = [];   // played indices, oldest-first: P returns to the REAL previous track
            var bag: number[] = [];       // shuffle deck: every queue track plays once before any repeats
            seedBag(bag, curList.length, idx);   // first cycle excludes the track already playing
            // How far into the CURRENT shuffle deck (1..len) -- the "3/42" count
            // while shuffling. Not derived from idx (shuffle scrambles idx). A fresh
            // shuffle (queue load, or switching shuffle on) restarts it at 1.
            var passPos = 1;
            FLPlayer.shuffleReset = false;   // initial deck is already fresh; don't re-deck on first advance
            while (bbs.online && !js.terminated) {
                var cur = curList[idx];
                // Immediate feedback for the inter-track gap (tag parse +
                // possible transcode): a visible loading banner, so nobody
                // double-presses N thinking the first one was ignored.
                console.clear();
                console.writeln("");
                console.writeln("  Loading: " + toScreenText(displayTrackTitle(cur)));
                console.writeln("");
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
                var residentAvatars = trackAvatars(cur);
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
                    avatars: residentAvatars,
                    moshAvatars: queueMoshAvatars(curList, cur, residentAvatars),
                    queueName: currentPlaylist,     // "" for radio/browse -> no count shown
                    // Shuffle: how far into the current shuffle (1..len). Sequential:
                    // the track's position in the arranged list.
                    queuePos: FLPlayer.shuffle ? passPos : (idx + 1),
                    queueLen: curList.length
                };
                var outcome = FLPlayer.playTrack(playable);
                // Honor whatever was pressed while the player was tearing
                // down / the next track was loading: Q still quits, and
                // buffered N/P adjust how far we move — no more sailing past
                // the track you wanted.
                var buffered = FLPlayer.pumpShared(80);
                FLPlayer.dbg("transition: outcome=" + outcome + " idx=" + idx +
                    (buffered.keys.length ? " buffered=" + buffered.keys.join("") : "") +
                    (buffered.esc ? " bufferedESC" : ""));
                var extra = 0;
                var quitBuffered = buffered.esc;
                for (var bi = 0; bi < buffered.keys.length; bi++) {
                    if (buffered.keys[bi] === "Q")
                        quitBuffered = true;
                    else if (buffered.keys[bi] === "N")
                        extra++;
                    else if (buffered.keys[bi] === "P")
                        extra--;
                }
                if (quitBuffered)
                    return;
                if (outcome === "browse") {
                    // Typeahead browser: picking sets a new play queue (the
                    // filtered results, or a whole playlist via the Manager);
                    // cancelling replays the current track.
                    var pick = browseSongs(activeApp);
                    if (pick && pick.list.length) {
                        curList = pick.list;
                        idx = Math.max(0, Math.min(pick.index, curList.length - 1));
                        currentPlaylist = pick.playlist || "";
                        if (pick.playlist) FLPlayer.shuffle = false;  // play a playlist in its arranged order
                        history = []; seedBag(bag, curList.length, idx); passPos = 1; FLPlayer.shuffleReset = false;   // fresh queue
                    }
                    console.clear();
                    continue;
                }
                if (outcome === "addplaylist") {
                    addToPlaylistFlow(curList[idx].name, displayTrackTitle(curList[idx]));
                    console.clear();
                    continue;
                }
                if (outcome === "removeplaylist") {
                    if (currentPlaylist && curList.length) {
                        plRemoveTrack(currentPlaylist, curList[idx].name);
                        curList.splice(idx, 1);          // drop from the live queue too
                        if (!curList.length) return;     // playlist emptied -> leave
                        if (idx >= curList.length) idx = 0;
                        history = []; seedBag(bag, curList.length, idx); passPos = 1; FLPlayer.shuffleReset = false;   // indices shifted
                    } else {
                        console.clear();
                        console.writeln("");
                        console.writeln("  Not playing from a playlist -- nothing to remove.");
                        mswait(1200);
                    }
                    console.clear();
                    continue;
                }
                if (outcome === "create") {
                    // Compose is a uifc flow, and the shim reads via
                    // console.getkey which (unlike the pump) does NOT swallow
                    // APC replies. The player's exit Flush can emit a drain
                    // notify whose ESC would dismiss the menu the instant it
                    // opens, so drain it here before uifc.
                    console.clear();
                    console.writeln("");
                    console.writeln("  Opening composer...");
                    FLPlayer.pumpShared(450);
                    initUi();
                    composeMenu(activeApp);
                    safeBailUi();
                    console.clear();
                    continue;
                }
                // Radio flow: the station never stops. Shuffle uses a no-repeat
                // "bag" -- every track in the queue plays once before any repeats
                // (reshuffle at cycle end). `history` records the REAL play order
                // so P returns to the actual previous track, not idx-1. N/P
                // (and buffered presses via `extra`) step through this.
                if (outcome === "next" || outcome === "ended" || outcome === "prev") {
                    var moves = (outcome === "prev" ? -1 : 1) + extra;
                    if (moves === 0) moves = (outcome === "prev" ? -1 : 1);
                    var goBack = moves < 0;
                    var steps = Math.abs(moves);
                    for (var mv = 0; mv < steps; mv += 1) {
                        if (goBack) {
                            if (history.length) {
                                idx = history.pop() as number;
                                if (FLPlayer.shuffle && passPos > 1) passPos -= 1;   // step back in the shuffle
                            } else if (!FLPlayer.shuffle) {
                                idx = (idx - 1 + curList.length) % curList.length;
                            }
                            // shuffle with no history yet: stay on the current track
                        } else {
                            history.push(idx);
                            if (history.length > 500) history.shift();
                            if (FLPlayer.shuffle && curList.length > 1) {
                                if (FLPlayer.shuffleReset) {
                                    // Shuffle was just switched on -> brand-new deck;
                                    // this pick is track 1 of the fresh shuffle.
                                    seedBag(bag, curList.length, idx);
                                    idx = shuffleNext(curList.length, idx, bag);
                                    passPos = 1;
                                    FLPlayer.shuffleReset = false;
                                } else {
                                    // Empty bag -> the deck just recycled (new cycle).
                                    var newCycle = bag.length === 0;
                                    idx = shuffleNext(curList.length, idx, bag);
                                    passPos = newCycle ? 1 : passPos + 1;
                                }
                            } else {
                                idx = (idx + 1) % curList.length;   // sequential: display uses idx+1
                            }
                        }
                    }
                    FLPlayer.dbg("nav -> idx=" + idx + (FLPlayer.shuffle ? " (shuffle bag=" + bag.length + ")" : ""));
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

    // --- playlist storage (per-user, JSONdb) -------------------------------
    // Playlists live BBS-side (this box is authoritative; the web can consume
    // data/playlists.json later). Per-user map: { [userKey]: { [name]:
    // {name, tracks:[filename], created} } }. Follows future_shell's shell_prefs
    // JSONdb pattern (new JSONdb -> load() -> masterData.data[key] -> save()).
    var PLAYLIST_SCOPE = "FLRECORDS_PLAYLISTS";

    interface Playlist { name: string; tracks: string[]; created: number; }

    function playlistDbPath(): string {
        return pathJoin(dataDirPath(), "playlists.json");
    }

    function playlistUserKey(): string {
        var raw = safeString(user && user.alias ? user.alias : ("user" + (user ? user.number : 0)));
        var k = raw.replace(/[^A-Za-z0-9_\-\.]/g, "_");
        return k.length ? k : "default";
    }

    function openPlaylistDb(): any {
        if (typeof JSONdb !== "function") return null;
        ensureDataDir();
        var db: any;
        try {
            db = new JSONdb(playlistDbPath(), PLAYLIST_SCOPE);
        } catch (_) {
            return null;
        }
        if (db && db.settings) db.settings.KEEP_READABLE = true;
        try { db.load(); } catch (_e) { }
        if (!db.masterData || typeof db.masterData !== "object") db.masterData = { data: {} };
        if (!db.masterData.data || typeof db.masterData.data !== "object") db.masterData.data = {};
        return db;
    }

    // Read the current user's playlists (fresh from disk), sorted by name.
    function loadPlaylists(): Playlist[] {
        var db = openPlaylistDb();
        if (!db) return [];
        var raw = db.masterData.data[playlistUserKey()];
        var out: Playlist[] = [];
        if (raw && typeof raw === "object") {
            for (var name in raw) {
                if (!raw.hasOwnProperty(name)) continue;
                var p = raw[name];
                if (p && p.tracks && typeof p.tracks.length === "number")
                    out.push({ name: safeString(p.name || name), tracks: p.tracks.slice(), created: p.created || 0 });
            }
        }
        out.sort(function (a: Playlist, b: Playlist): number {
            return lower(a.name) < lower(b.name) ? -1 : (lower(a.name) > lower(b.name) ? 1 : 0);
        });
        return out;
    }

    // Load -> mutate -> save the user's playlists atomically on one db handle.
    function mutatePlaylists(fn: (list: Playlist[]) => void): boolean {
        var db = openPlaylistDb();
        if (!db) return false;
        var key = playlistUserKey();
        var raw = db.masterData.data[key];
        var list: Playlist[] = [];
        if (raw && typeof raw === "object") {
            for (var name in raw) {
                if (!raw.hasOwnProperty(name)) continue;
                var p = raw[name];
                if (p) list.push({ name: safeString(p.name || name), tracks: (p.tracks || []).slice(), created: p.created || 0 });
            }
        }
        fn(list);
        var map: { [n: string]: Playlist } = {};
        for (var i = 0; i < list.length; i += 1)
            map[list[i].name] = { name: list[i].name, tracks: list[i].tracks, created: list[i].created };
        db.masterData.data[key] = map;
        try { db.save(); return true; } catch (_) { return false; }
    }

    function findPlaylist(list: Playlist[], name: string): Playlist | null {
        for (var i = 0; i < list.length; i += 1)
            if (lower(list[i].name) === lower(name)) return list[i];
        return null;
    }

    function plNow(): number {
        return typeof time === "function" ? time() : 0;
    }

    // Create a playlist (optionally seeded with a track). Returns false if the
    // name is taken or blank.
    function plCreate(name: string, seedTrack?: string): boolean {
        var clean = trimValue(name);
        if (!clean.length) return false;
        return mutatePlaylists(function (list: Playlist[]): void {
            if (findPlaylist(list, clean)) return;
            list.push({ name: clean, tracks: seedTrack ? [seedTrack] : [], created: plNow() });
        });
    }

    function plAddTrack(name: string, trackName: string): boolean {
        return mutatePlaylists(function (list: Playlist[]): void {
            var pl = findPlaylist(list, name);
            if (!pl) { pl = { name: trimValue(name), tracks: [], created: plNow() }; list.push(pl); }
            for (var i = 0; i < pl.tracks.length; i += 1)
                if (pl.tracks[i] === trackName) return;   // dedupe
            pl.tracks.push(trackName);
        });
    }

    function plRemoveTrack(name: string, trackName: string): boolean {
        return mutatePlaylists(function (list: Playlist[]): void {
            var pl = findPlaylist(list, name);
            if (!pl) return;
            var kept: string[] = [];
            for (var i = 0; i < pl.tracks.length; i += 1)
                if (pl.tracks[i] !== trackName) kept.push(pl.tracks[i]);
            pl.tracks = kept;
        });
    }

    function plDelete(name: string): boolean {
        return mutatePlaylists(function (list: Playlist[]): void {
            for (var i = list.length - 1; i >= 0; i -= 1)
                if (lower(list[i].name) === lower(name)) list.splice(i, 1);
        });
    }

    function plRename(oldName: string, newName: string): boolean {
        var clean = trimValue(newName);
        if (!clean.length) return false;
        return mutatePlaylists(function (list: Playlist[]): void {
            if (findPlaylist(list, clean) && lower(clean) !== lower(oldName)) return; // name taken
            var pl = findPlaylist(list, oldName);
            if (pl) pl.name = clean;
        });
    }

    function plSetOrder(name: string, tracks: string[]): boolean {
        return mutatePlaylists(function (list: Playlist[]): void {
            var pl = findPlaylist(list, name);
            if (pl) pl.tracks = tracks.slice();
        });
    }

    // --- console drawing helpers for the typeahead browser -----------------
    function csiAt(y: number, x: number): string { return "\x1b[" + y + ";" + x + "H"; }
    function csiSgr(codes: string): string { return "\x1b[" + codes + "m"; }
    var CSI_RESET = "\x1b[0m";

    function padClip(text: string, width: number): string {
        if (width <= 0) return "";
        if (text.length >= width) return text.substring(0, width);
        return padRight(text, width);
    }

    // --- playlist UI flows -------------------------------------------------
    // Bring uifc up for a menu flow from a console-mode context (browse/player),
    // draining any APC reply tail first (the shim's getkey doesn't swallow it,
    // so a stray drain-notify would dismiss the menu). Restores prior UI state.
    function runUifcFlow(fn: () => void): void {
        // Swallow the player's exit-Flush drain notify, whose ESC would
        // otherwise dismiss the shim menu; unlike the pump, the uifc shim's
        // getkey does not filter APC replies.
        FLPlayer.pumpShared(450);
        var hadUi = uiReady;
        if (!hadUi) initUi();
        try {
            fn();
        } finally {
            if (!hadUi) safeBailUi();
        }
    }

    function trackTitleForName(fname: string): string {
        var cat = activeApp ? activeApp.catalog : [];
        for (var i = 0; i < cat.length; i += 1)
            if (cat[i].name === fname) return toScreenText(displayTrackTitle(cat[i]));
        return fname;
    }

    // Resolve a playlist's filenames to catalog tracks (skipping any missing).
    function playlistToTracks(pl: Playlist): TrackSummary[] {
        var out: TrackSummary[] = [];
        var cat = activeApp ? activeApp.catalog : [];
        for (var i = 0; i < pl.tracks.length; i += 1) {
            for (var j = 0; j < cat.length; j += 1) {
                if (cat[j].name === pl.tracks[i]) { out.push(cat[j]); break; }
            }
        }
        return out;
    }

    function playlistContains(pl: Playlist, trackName: string): boolean {
        for (var i = 0; i < pl.tracks.length; i += 1)
            if (pl.tracks[i] === trackName) return true;
        return false;
    }

    // Add one track to a playlist: pick an existing one or create a new one.
    // Intelligent: playlists that already hold the song are marked, and adding
    // again is a no-op with an "Already in" message (never a duplicate).
    function addToPlaylistFlow(trackName: string, trackTitle: string): void {
        runUifcFlow(function (): void {
            var pls = loadPlaylists();
            var options: string[] = ["Back", "[+ Create New Playlist]"];
            for (var i = 0; i < pls.length; i += 1)
                options.push(pls[i].name + "   (" + pls[i].tracks.length + ")" +
                    (playlistContains(pls[i], trackName) ? "  - added" : ""));
            uifc.help_text = "Add \"" + toScreenText(trackTitle) + "\" to a playlist. '- added' marks playlists it's already in. Choose one, create a new playlist, or Back/Backspace/Esc to close.";
            var choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Add to Playlist", options, new uifc.list.CTX());
            if (choice <= 0) return;                       // Back (0) or Esc (<0)
            if (choice === 1) {
                var name = promptInput("New playlist name", "", 60, K_EDIT);
                if (name === null || !trimValue(name).length) return;
                var existing = findPlaylist(loadPlaylists(), trimValue(name));
                if (existing && playlistContains(existing, trackName)) {
                    uifc.msg("Already in \"" + existing.name + "\".");
                    return;
                }
                plAddTrack(trimValue(name), trackName);    // creates if new, dedupes
                uifc.msg("Added to \"" + trimValue(name) + "\".");
                return;
            }
            var target = pls[choice - 2];
            if (playlistContains(target, trackName)) {
                uifc.msg("Already in \"" + target.name + "\".");
                return;
            }
            plAddTrack(target.name, trackName);
            uifc.msg("Added to \"" + target.name + "\".");
        });
    }

    // Drag-to-reorder a playlist's songs (console-drawn). Enter grabs the
    // highlighted song, Up/Down move it, Enter drops; Esc saves and exits.
    function reorderPlaylistUi(name: string): void {
        var hadUi = uiReady;
        if (hadUi) safeBailUi();
        try {
            var pl = findPlaylist(loadPlaylists(), name);
            if (!pl) return;
            var tracks = pl.tracks.slice();
            var sel = 0, grabbed = -1, top = 0;
            var full = true, dirty = true;
            while (bbs.online && !js.terminated) {
                var cols = Math.max(40, console.screen_columns || 80);
                var rows = Math.max(10, console.screen_rows || 24);
                var listTop = 4;
                var listH = Math.max(1, rows - listTop - 1);
                if (sel < top) top = sel;
                if (sel >= top + listH) top = sel - listH + 1;
                if (top < 0) top = 0;
                if (full) { console.write("\x1b[?25l\x1b[2J"); full = false; dirty = true; }
                if (dirty) {
                    console.write(csiAt(1, 1) + csiSgr("0;1;36") + padClip(" REORDER: " + name, cols) + CSI_RESET);
                    console.write(csiAt(2, 1) + csiSgr("0;30;46") +
                        padClip("  ENTER grab/drop    UP/DN move    ESC save & back  ", cols) + CSI_RESET);
                    for (var r = 0; r < listH; r += 1) {
                        var idx = top + r, y = listTop + r;
                        var w = (y >= rows) ? cols - 1 : cols;
                        var txt = idx < tracks.length ? (idx === grabbed ? " <> " : "    ") +
                            trackTitleForName(tracks[idx]) : "";
                        var on = idx === sel;
                        var sgrc = idx === grabbed ? "0;1;33;44" : (on ? "0;37;44" : "0;37");
                        console.write(csiAt(y, 1) + csiSgr(sgrc) + padClip(txt, w) + CSI_RESET);
                    }
                    dirty = false;
                }
                var k = FLPlayer.readKey(120);
                if (!k.length) continue;
                dirty = true;
                if (k === "\x1b") break;                          // Esc: save & exit
                if (k === "\r") { grabbed = (grabbed === sel) ? -1 : sel; continue; }  // grab/drop
                var dir = (k === "\x1e") ? -1 : (k === "\x0a") ? 1 : 0;  // up / down
                if (!dir) continue;
                if (grabbed >= 0) {
                    var ni = grabbed + dir;
                    if (ni >= 0 && ni < tracks.length) {
                        var tmp = tracks[grabbed]; tracks[grabbed] = tracks[ni]; tracks[ni] = tmp;
                        grabbed = ni; sel = ni;
                    }
                } else {
                    sel = Math.max(0, Math.min(tracks.length - 1, sel + dir));
                }
            }
            console.write("\x1b[?25h" + CSI_RESET);
            plSetOrder(name, tracks);
        } finally {
            if (hadUi) initUi();
        }
    }

    // Playlist Manager: list playlists, then Play / Rename / Reorder / Delete.
    // Returns a queue to play (from "Play"), or null.
    function playlistManager(): { list: TrackSummary[]; index: number; playlist: string } | null {
        var toPlay: { list: TrackSummary[]; index: number; playlist: string } | null = null;
        runUifcFlow(function (): void {
            var mgrCtx = new uifc.list.CTX();
            while (bbs.online && !js.terminated) {
                var pls = loadPlaylists();
                var options: string[] = ["Back"];
                for (var i = 0; i < pls.length; i += 1)
                    options.push(pls[i].name + "   (" + pls[i].tracks.length + " tracks)");
                if (!pls.length) options.push("(no playlists yet - add songs from Browse or the player)");
                uifc.help_text = "Your playlists. Select one to Play / Rename / Reorder / Delete. Add songs with ENTER in Browse or [A] in the player. Backspace/Esc go back.";
                var choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Playlist Manager", options, mgrCtx);
                if (choice <= 0) return;                   // Back (0) or Esc (<0)
                if (!pls.length) continue;                 // the "(no playlists)" row
                var pl = pls[choice - 1];
                var action = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, pl.name + " (" + pl.tracks.length + ")",
                    ["Back", "Play", "Rename", "Reorder songs", "Delete"], new uifc.list.CTX());
                if (action <= 0) {
                    continue;                              // Back (0) or Esc -> playlist list
                } else if (action === 1) {
                    var built = playlistToTracks(pl);
                    if (!built.length) { uifc.msg("That playlist has no playable songs."); continue; }
                    toPlay = { list: built, index: 0, playlist: pl.name };
                    return;
                } else if (action === 2) {
                    var nn = promptInput("Rename playlist", pl.name, 60, K_EDIT);
                    if (nn !== null && trimValue(nn).length) plRename(pl.name, trimValue(nn));
                } else if (action === 3) {
                    reorderPlaylistUi(pl.name);
                } else if (action === 4) {
                    if (uifc.list(WIN_MID | WIN_SAV, "Delete \"" + pl.name + "\"?", ["No", "Yes"]) === 1)
                        plDelete(pl.name);
                }
            }
        });
        return toPlay;
    }

    // Typeahead song browser. Live-filters the catalog as you type; ALL printable
    // keys feed the search (so commands must be non-letters: Enter plays, Tab
    // shows details, Backspace deletes, Esc clears then backs out). Returns the
    // filtered list + chosen index (which becomes the new play queue) or null.
    // Console-drawn; input flows through the shared pump — never a raw inkey
    // read, which would bisect in-flight sequences (see the input lesson).
    function browseSongs(app: AppState): { list: TrackSummary[]; index: number; playlist?: string } | null {
        var result: { list: TrackSummary[]; index: number; playlist?: string } | null = null;
        withConsoleScreen(function (): void {
            var search = "";
            var sel = 0;
            var top = 0;
            var lastCols = 0;
            var lastRows = 0;
            var filtered: TrackSummary[] = [];
            var full = true;
            var dirty = true;
            var done = false;

            function recompute(): void {
                filtered = [];
                for (var i = 0; i < app.catalog.length; i += 1) {
                    if (!search.length || trackSearchHaystack(app.catalog[i]).indexOf(search) >= 0)
                        filtered.push(app.catalog[i]);
                }
                if (sel >= filtered.length) sel = filtered.length - 1;
                if (sel < 0) sel = 0;
                top = 0;
            }
            recompute();

            while (!done && bbs.online && !js.terminated) {
                var cols = Math.max(40, console.screen_columns || 80);
                var rows = Math.max(10, console.screen_rows || 24);
                if (cols !== lastCols || rows !== lastRows) { full = true; lastCols = cols; lastRows = rows; }
                var listTop = 4;
                var listH = Math.max(1, rows - listTop);
                if (sel < top) top = sel;
                if (sel >= top + listH) top = sel - listH + 1;
                if (top < 0) top = 0;

                if (full) { console.write("\x1b[?25l\x1b[2J"); full = false; dirty = true; }
                if (dirty) {
                    console.write(csiAt(1, 1) + csiSgr("0;1;36") +
                        padClip(" FUTURELAND RECORDS  --  Browse", cols) + CSI_RESET);
                    var count = " " + filtered.length + "/" + app.catalog.length + " ";
                    console.write(csiAt(2, 1) + csiSgr("0;1;37") +
                        padClip(" Search: " + search + "_", Math.max(0, cols - count.length)) +
                        csiSgr("0;1;36") + count + CSI_RESET);
                    console.write(csiAt(3, 1) + csiSgr("0;30;46") +
                        padClip("  SPACE play   ENTER +playlist   TAB manager   BKSP clear   ESC back  ", cols) + CSI_RESET);
                    for (var r = 0; r < listH; r += 1) {
                        var idx = top + r;
                        var y = listTop + r;
                        var w = (y >= rows) ? cols - 1 : cols;   // never write the bottom-right cell
                        var txt = idx < filtered.length ? trackRow(filtered[idx]) :
                            (idx === 0 && !filtered.length ? "  (no matches - Backspace to widen)" : "");
                        var on = idx === sel && filtered.length > 0;
                        console.write(csiAt(y, 1) + csiSgr(on ? "0;37;44" : "0;37") + padClip(txt, w) + CSI_RESET);
                    }
                    dirty = false;
                }

                // One normalized key per read (arrows come back as cursor codes).
                var k = FLPlayer.readKey(120);
                if (k.length) {
                    dirty = true;
                    if (k === "\x1b") {                          // Esc: clear the search, else back out
                        if (search.length) { search = ""; sel = 0; recompute(); }
                        else done = true;
                    } else if (k === " ") {                      // SPACE plays the highlighted song
                        if (filtered.length) { result = { list: filtered, index: sel }; done = true; }
                    } else if (k === "\r") {                     // ENTER adds it to a playlist
                        if (filtered.length) {
                            addToPlaylistFlow(filtered[sel].name, displayTrackTitle(filtered[sel]));
                            full = true;
                        }
                    } else if (k === "\t") {                     // TAB opens the Playlist Manager
                        var pm = playlistManager();
                        if (pm) { result = { list: pm.list, index: pm.index, playlist: pm.playlist }; done = true; }
                        else full = true;
                    } else if (k === "\x08" || k === "\x7f") {   // Backspace deletes a search char
                        if (search.length) { search = search.substring(0, search.length - 1); sel = 0; recompute(); }
                    } else if (k === "\x1e") {                   // up
                        sel = sel > 0 ? sel - 1 : Math.max(0, filtered.length - 1);
                    } else if (k === "\x0a") {                   // down
                        sel = filtered.length ? (sel + 1) % filtered.length : 0;
                    } else if (k === "\x10" || k === "\x1d") {   // page up / left
                        sel = Math.max(0, sel - listH);
                    } else if (k === "\x0e" || k === "\x06") {   // page down / right
                        sel = Math.min(Math.max(0, filtered.length - 1), sel + listH);
                    } else if (k === "\x02") {                   // home
                        sel = 0;
                    } else if (k === "\x05") {                   // end
                        sel = Math.max(0, filtered.length - 1);
                    } else if (k.length === 1 && k > " " && k <= "~") {   // printable -> search (space is play)
                        search += k.toLowerCase(); sel = 0; recompute();
                    }
                }
            }
            console.write("\x1b[?25h" + CSI_RESET);
        });
        return result;
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
            uifc.help_text = "Enter plays the song in the terminal.  T opens its details.  First row edits filters.";
            (app.trackListCtx as any).actionKeys = { "T": UI_ACTION_DETAIL };
            selection = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                "All Songs  (" + filtered.length + " of " + app.catalog.length + " tracks)",
                options,
                app.trackListCtx
            );
            if (selection === UI_ACTION_DETAIL) {
                var drow = (app.trackListCtx as any).cur;
                if (filtered.length && drow >= 2 && drow - 2 < filtered.length)
                    showTrackDetail(filtered[drow - 2], filtered, drow - 2);
                continue;
            }
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
            // Enter drops straight into the in-terminal player/visualizer; the
            // detail view is one T away for full metadata/art/lyrics.
            playInTerminal(filtered[selection - 2], filtered, selection - 2);
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
        var vw = composeValueWidth();
        while (bbs.online && !js.terminated) {
            options = [
                "Song title          " + summarizeValue(state.songTitle, vw),
                "Brief               " + summarizeValue(state.brief, vw),
                "Genre               " + summarizeValue(state.genre, vw),
                "Feel                " + summarizeValue(state.feel, vw),
                "Tone                " + summarizeValue(state.tone, vw),
                "Arrangement         " + summarizeValue(state.arrangement, vw),
                "Extra notes         " + summarizeValue(state.notes, vw),
                "Back"
            ];
            uifc.help_text = "The song's core. Brief is a plain-language description (what it's about, language, mood); Genre/Feel/Tone/Arrangement pick from lists. Enter edits a field, Esc goes back.";
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
            uifc.help_text = "Guide one lyric section. Notes steer it (a line or two of intent); Section text is exact words to keep. Leave both blank to let the AI write it.";
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                section.label,
                [
                    "Guidance notes      " + summarizeValue(sectionState.notes, composeValueWidth()),
                    "Section text        " + summarizeValue(sectionState.text, composeValueWidth()),
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
                    options.push(section.label + "          " + summarizeValue(summary.notes || summary.text, composeValueWidth()));
                }
                options.push("Clear all guided sections");
            } else {
                options.push("Edit freeform lyrics  " + summarizeValue(state.lyricsFreeform, composeValueWidth()));
                options.push("Clear freeform lyrics");
            }
            options.push("Back");
            uifc.help_text = "How the lyrics get written. Freeform = write/paste the whole lyric; Guided = fill sections (verse, chorus...) with intent or exact lines. Blank sections are AI-written.";
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
            uifc.help_text = "The arrangement: instruments, groove, vocals, language, tempo, key, time signature and target length. All optional -- anything you leave blank the AI decides.";
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                "Music Direction",
                [
                    "Instrumentation     " + summarizeValue(state.instrumentation, composeValueWidth()),
                    "Groove              " + summarizeValue(state.groove, composeValueWidth()),
                    "Band                " + summarizeValue(state.band, composeValueWidth()),
                    "Lead vocal          " + summarizeValue(state.leadvocal, composeValueWidth()),
                    "Backing vocals      " + summarizeValue(state.backingvocal, composeValueWidth()),
                    "Language            " + summarizeValue(state.language, composeValueWidth()),
                    "Tempo               " + summarizeValue(getTempoLabel(state), composeValueWidth()),
                    "Key                 " + summarizeValue(state.key, composeValueWidth()),
                    "Time signature      " + summarizeValue(state.timesig, composeValueWidth()),
                    "Duration (seconds)  " + summarizeValue(state.duration, composeValueWidth()),
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
                    "AI co-writer        " + summarizeValue(state.cowriter || "None", composeValueWidth()),
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
            // JSONClient auto-connects in its constructor (and THROWS if the host
            // is unreachable). JSONChat.connect() would then re-connect that live
            // socket and return false -- so we must NOT call it. Instead set the
            // author nick ourselves (the only thing connect() does that submit()
            // needs) and go straight to join+submit. This mirrors future_shell's
            // working pattern; calling connect() was the "Could not connect" bug.
            client = new JSONClient(chatOptions.host, chatOptions.port);
            chat = new JSONChat(user.number, client, chatOptions.host, chatOptions.port);
            chat.nick = { name: user.alias, host: system.name, ip: user.ip_address };
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
                chat = new JSONChat(user.number, client, chatOptions.host, chatOptions.port);
                // No chat.connect(): the JSONClient constructor already connected
                // (and throws -> caught below if the host is unreachable). Set the
                // nick and join to start receiving. Calling connect() re-connects
                // the live socket and returns false -- the old bug.
                chat.nick = { name: user.alias, host: system.name, ip: user.ip_address };
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
            uifc.help_text = "Build a song request for Vektrax (the AI). Fill in as much or as little as you like across DNA / Lyrics / Music, Preview to see the prompt, then Send. Everything is optional.";
            choice = uifc.list(
                WIN_ESC | WIN_SAV | WIN_ACT,
                "Create / Compose",
                [
                    "Song DNA           " + summarizeValue(state.songTitle || state.genre || "Start here", composeValueWidth()),
                    "Lyrics Director    " + summarizeValue(state.lyricMode === "guided" ? "Guided sections" : state.lyricsFreeform || "Freeform", composeValueWidth()),
                    "Music Direction    " + summarizeValue(state.instrumentation || state.language || "Set arrangement", composeValueWidth()),
                    "Session Options    " + summarizeValue(state.cowriter || (state.memoryActive ? "Memory" : "Blank Slate"), composeValueWidth()),
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

    function shuffledCatalog(app: AppState): TrackSummary[] {
        var a = app.catalog.slice();
        for (var i = a.length - 1; i > 0; i -= 1) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    // No-repeat shuffle. `bag` = the tracks not yet played this cycle. Refill it
    // with `seedBag`; on a fresh cycle it holds ALL tracks (each plays exactly
    // once before any repeat). At session start we seed it EXCEPT the track
    // already playing, so that first cycle is clean too.
    function seedBag(bag: number[], len: number, except: number): void {
        bag.length = 0;
        for (var i = 0; i < len; i += 1) if (i !== except) bag.push(i);
        for (var j = bag.length - 1; j > 0; j -= 1) {
            var k = Math.floor(Math.random() * (j + 1));
            var t = bag[j]; bag[j] = bag[k]; bag[k] = t;
        }
    }

    function shuffleNext(len: number, cur: number, bag: number[]): number {
        if (!bag.length) seedBag(bag, len, -1);      // new cycle: every track
        var next = bag.pop() as number;
        if (next === cur && bag.length) {            // avoid a back-to-back repeat at a cycle edge
            var alt = bag.pop() as number; bag.push(next); next = alt;
        }
        return next;
    }

    // No terminal audio sink: the radio can't play, so let the caller browse the
    // catalog and open details / play-in-browser. Esc from the browser leaves.
    function noAudioFallback(app: AppState): void {
        withConsoleScreen(function (): void {
            console.clear();
            printConsoleHeader(APP_TITLE);
            console.writeln("");
            console.writeln("  No terminal audio sink was detected.");
            console.writeln("");
            console.writeln("  In-terminal playback needs a current SyncTERM (APC audio)");
            console.writeln("  or the BBSproxy shim. You can still browse the catalog and");
            console.writeln("  use [P] Play In Browser from a song's details.");
            console.writeln("");
            console.writeln("  Press any key to browse...");
            waitForAnyKey();
        });
        for (; ;) {
            if (!bbs.online || js.terminated) return;
            var pick = browseSongs(app);
            if (!pick) return;
            showTrackDetail(pick.list[pick.index], pick.list, pick.index);
        }
    }

    // "Tune In": the door opens straight into the visualizer with music playing
    // (a shuffle of the whole catalog). Browse (B) and Create (C) are reachable
    // from inside the player; with no audio sink we drop to browse-only.
    function tuneIn(app: AppState): void {
        var sink: string = "none";
        withConsoleScreen(function (): void {
            console.clear();
            console.writeln("");
            console.writeln("  Tuning in to Futureland Records...");
            sink = FLPlayer.detectSink();
        });
        if (sink === "none" || !app.catalog.length) {
            noAudioFallback(app);
            return;
        }
        // The all-songs radio shuffles by default; S toggles to sequential.
        FLPlayer.shuffle = true;
        var list = shuffledCatalog(app);
        playInTerminal(list[0], list, 0);
    }

    // Regression guard for the CP437 artist-name corruption: the real tag
    // "Vektrax feat. 🗲ᴍʀᴏ1337" decoded to small-caps + astral codepoints, and
    // naive rendering turned U+1D0D into 0x0D (CR) that smeared the track list.
    function sanitizerSelfTest(): void {
        function must(got: string, want: string, label: string): void {
            if (got !== want)
                throw new Error("sanitizer " + label + ": got " + JSON.stringify(got) +
                    " want " + JSON.stringify(want));
            for (var i = 0; i < got.length; i += 1) {
                var c = got.charCodeAt(i);
                if (c < 0x20 || c > 0x7e)
                    throw new Error("sanitizer " + label + ": unsafe byte 0x" + c.toString(16));
            }
        }
        // small-caps "mro" + astral lightning + embedded controls
        var smallcaps = String.fromCharCode(0x1D0D, 0x0280, 0x1D0F);
        must(screenSafe("Vektrax feat. " + String.fromCharCode(0xD83D, 0xDDF2) +
            smallcaps + "1337" + String.fromCharCode(0xD83D, 0xDDF2)),
            "Vektrax feat. mro1337", "decorated-handle-surrogate");
        // the form the door actually sees: utf8_utf16() truncates the astral
        // U+1F5F2 to a single BMP code 0xF5F2 before screenSafe runs.
        must(screenSafe("Vektrax feat. " + String.fromCharCode(0xF5F2) +
            smallcaps + "1337" + String.fromCharCode(0xF5F2)),
            "Vektrax feat. mro1337", "decorated-handle-decoded");
        must(screenSafe("A" + String.fromCharCode(0x0D, 0x0F, 0x1B) + "B"), "AB", "controls");
        must(screenSafe("darksix"), "darksix", "clean-passthrough");
        must(screenSafe(String.fromCharCode(0x201C) + "hi" + String.fromCharCode(0x201D)),
            "\"hi\"", "smart-quotes");
        writeln("sanitizer self-test: OK");
    }

    function playlistSelfTest(): void {
        if (typeof JSONdb !== "function") { writeln("playlist self-test: SKIP (no JSONdb)"); return; }
        var TP = "__fltest__";
        plDelete(TP); plDelete(TP + "2");
        if (!plCreate(TP, "a.mp3")) throw new Error("plCreate failed");
        plAddTrack(TP, "b.mp3");
        plAddTrack(TP, "b.mp3");   // dedupe
        var pl = findPlaylist(loadPlaylists(), TP);
        if (!pl) throw new Error("playlist not persisted");
        if (pl.tracks.join(",") !== "a.mp3,b.mp3") throw new Error("tracks: " + pl.tracks.join(","));
        plSetOrder(TP, ["b.mp3", "a.mp3"]);
        if (findPlaylist(loadPlaylists(), TP)!.tracks.join(",") !== "b.mp3,a.mp3") throw new Error("reorder");
        plRemoveTrack(TP, "b.mp3");
        if (findPlaylist(loadPlaylists(), TP)!.tracks.join(",") !== "a.mp3") throw new Error("remove");
        plRename(TP, TP + "2");
        if (findPlaylist(loadPlaylists(), TP)) throw new Error("rename left old");
        if (!findPlaylist(loadPlaylists(), TP + "2")) throw new Error("rename lost new");
        plDelete(TP + "2");
        if (findPlaylist(loadPlaylists(), TP + "2")) throw new Error("delete failed");
        writeln("playlist self-test: OK");
    }

    // No-repeat shuffle: every queue track must play before any repeats, and a
    // track never lands twice in a row.
    function shuffleSelfTest(): void {
        var len = 7;
        var bag: number[] = [];
        var cur = 0;
        seedBag(bag, len, cur);            // first cycle excludes the starting track
        var seen: { [k: number]: boolean } = {};
        seen[cur] = true;
        var seenCount = 1;
        for (var s = 0; s < len * 5; s += 1) {
            var nxt = shuffleNext(len, cur, bag);
            if (nxt === cur) throw new Error("shuffle immediate repeat");
            if (seen[nxt]) {
                if (seenCount !== len)
                    throw new Error("shuffle repeated after " + seenCount + "/" + len + " (not exhausted)");
                seen = {}; seenCount = 0;
            }
            if (!seen[nxt]) { seen[nxt] = true; seenCount += 1; }
            cur = nxt;
        }
        // Cycle counter (the "3/42" indicator): NEXT must read 1,2,..,len,1,2,..
        // -- position within the cycle, resetting when the bag reshuffles.
        var cbag: number[] = []; var cidx = 0; var cCount = 1;
        seedBag(cbag, len, cidx);
        var want = 1;
        for (var c = 0; c < len * 3; c += 1) {
            if (cCount !== want) throw new Error("cycle count " + cCount + " != " + want);
            var wasEmpty = cbag.length === 0;
            cidx = shuffleNext(len, cidx, cbag);
            cCount = wasEmpty ? 1 : cCount + 1;
            want = want >= len ? 1 : want + 1;
        }
        writeln("shuffle self-test: OK");
    }

    function main(): void {
        if (typeof argv !== "undefined" && argv && argv.indexOf("--selftest") >= 0) {
            sanitizerSelfTest();
            playlistSelfTest();
            shuffleSelfTest();
            FLPlayer.selfTest();
            return;
        }
        var app = createAppState();
        activeApp = app;
        try {
            app.catalog = loadCatalog(false);
            app.cowriters = loadCowriters();
            // Tune In: straight into the radio (console-mode player). uifc is
            // only brought up on demand for Create / no-audio browse.
            tuneIn(app);
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
