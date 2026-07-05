/*
 * FLPlayer — in-terminal MP3 playback for Futureland Records over the
 * SyncTERM APC audio protocol (APC SyncTERM:... ST), with album-art
 * backdrop, synced lyrics, floating avatar sprites, and an audio-reactive
 * visualizer driven by real per-chunk features (RMS loudness + zero
 * crossing rate) computed while slicing.
 *
 * Protocol (canonical spec: src/conio/cterm.adoc + syncterm/audio_apc.c):
 *   Store   APC SyncTERM:C;S;<name>;<base64>          -> file into client cache
 *   Load    APC SyncTERM:A;Load;S=<slot>;<name>       -> libsndfile decode to patch
 *   Queue   APC SyncTERM:A;Queue;C=<ch>;S=<slot>      -> append patch to channel
 *   Flush   APC SyncTERM:A;Flush;C=<ch>[;O=<ms>]      -> clear channel (opt fade)
 *   Volume  APC SyncTERM:A;Volume;C=<ch>;V=<pct>[;T=<ms>]
 *   Update  APC SyncTERM:A;Update;C=<ch>              -> arm one-shot idle notify
 *   notify  CSI = 7 ; <ch> ; 0 n                      -> armed channel went idle
 *   query   APC SyncTERM:Q;libsndfile -> CSI = 7 ; 100 ; <0|1> n
 *
 * The client (SyncTERM's xp_sndfile) resamples anything libsndfile can
 * read up to 44.1 kHz stereo, so the door streams low-rate WAV as the
 * bandwidth lever. BBSproxy.py implements the same Store/Load/Queue/
 * Update dialect for iTerm2, so both terminals play. Detection ladder:
 * the libsndfile feature query answers on real SyncTERM; a silent
 * Update-armed probe chunk answers on any drain-notify-capable sink
 * (BBSproxy); otherwise audio is unavailable.
 *
 * Playback is a single-threaded paced loop (the door has no threads):
 * each iteration tops up the client's audio cushion (Store+Load+Queue
 * per chunk), pumps input (keys + CSI notify replies), and repaints the
 * overlay/visualizer. An armed Update firing while chunks remain means
 * underrun -> re-anchor the clock and re-prime the cushion (the same
 * closed-loop recovery lameboy's apc_audio.rs uses); firing after the
 * last chunk means the song finished.
 *
 * Screen (bottom-anchored; art is grid-rendered, centered and trimmed):
 *   1 .. H-8   album art (FLAnsiGrid) with floating avatar sprites
 *   H-7        glow strip (audio-reactive)
 *   H-6        synced lyric line
 *   H-5        glow strip (mirror)
 *   H-4..H-1   double-line box: title / progress+time+volume
 *   H          key hints
 */

namespace FLPlayer {

    // ---- tuning -------------------------------------------------------
    var CHUNK_MS = 300;          // clip length; also the pacing quantum
    var PREBUFFER = 3;           // chunks queued ahead of realtime
    var CHANNEL = 2;             // first APC-dedicated channel (0/1 are cterm's)
    var SLOTS = 8;               // patch slots cycled for chunk clips
    var PCM_RATE = 22050;        // transcode rate (client resamples to 44.1k)
    var PCM_CHANNELS = 2;        // stereo; halve bandwidth with 1 if needed
    var UI_TICK_MS = 150;        // overlay/visualizer repaint cadence
    var SEEK_SECONDS = 10;
    var VOLUME_STEP = 10;        // percent per Up/Down press
    var ART_WIDTH = 80;          // classic ANSI art wrap column
    var AVATAR_W = 10;           // Synchronet avatar cell dimensions
    var AVATAR_H = 6;

    // ---- shared state ---------------------------------------------------
    export type SinkKind = "syncterm" | "apc" | "none";
    var detectedSink: SinkKind | null = null;   // per-session cache

    export interface LyricLine {
        time: number;   // seconds
        text: string;
    }

    export interface PlayableTrack {
        path: string;       // mp3 on disk
        name: string;       // filename (cache key component)
        title: string;
        artist: string;
        size: number;
        mtime: number;
        ansiArt: string;    // raw CP437 .ans bytes ("" when absent)
        lyrics?: LyricLine[];   // timestamped (SYLT or .lrc); preferred
        flatLyrics?: string;    // untimed fallback, distributed over duration
        avatars?: string[];     // raw 10x6 BIN blobs (decoded), up to 2
    }

    export type PlayResult = "quit" | "next" | "prev" | "ended" | "error";

    // ---- small helpers --------------------------------------------------
    function shellQuote(s: string): string {
        return "'" + s.replace(/'/g, "'\\''") + "'";
    }

    function nowMs(): number {
        return new Date().getTime();
    }

    function clamp(v: number, lo: number, hi: number): number {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    function fmtTime(totalSeconds: number): string {
        var s = Math.max(0, Math.floor(totalSeconds));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return m + ":" + (r < 10 ? "0" : "") + r;
    }

    function apc(payload: string): void {
        console.write("\x1b_SyncTERM:" + payload + "\x1b\\");
    }

    // ---- WAV plumbing ---------------------------------------------------
    // We always transcode to canonical PCM (pcm_s16le) with metadata
    // stripped, so the header is the fixed 44 bytes; the parser still walks
    // RIFF chunks and the reader grows its buffer, in case a pre-data chunk
    // ever appears anyway.

    function le16(v: number): string {
        return String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
    }

    function le32(v: number): string {
        return String.fromCharCode(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    }

    function rd16(s: string, o: number): number {
        return (s.charCodeAt(o) & 0xff) | ((s.charCodeAt(o + 1) & 0xff) << 8);
    }

    function rd32(s: string, o: number): number {
        return ((s.charCodeAt(o) & 0xff)) +
            ((s.charCodeAt(o + 1) & 0xff) * 0x100) +
            ((s.charCodeAt(o + 2) & 0xff) * 0x10000) +
            ((s.charCodeAt(o + 3) & 0xff) * 0x1000000);
    }

    export function wavHeader(dataBytes: number, rate: number, channels: number): string {
        var blockAlign = channels * 2;
        var byteRate = rate * blockAlign;
        return "RIFF" + le32(36 + dataBytes) + "WAVE" +
            "fmt " + le32(16) + le16(1) + le16(channels) +
            le32(rate) + le32(byteRate) + le16(blockAlign) + le16(16) +
            "data" + le32(dataBytes);
    }

    export interface WavInfo {
        rate: number;
        channels: number;
        dataOffset: number;
        dataBytes: number;
    }

    /** Parse the header, growing the read until the data chunk is in view
     *  (metadata LIST chunks can push it well past 512 bytes). */
    export function readWavInfo(f: File): WavInfo | null {
        var want = 512;
        for (; ;) {
            f.position = 0;
            var head = f.read(want);
            if (!head || head.length < 44)
                return null;
            var info = parseWavHeader(head, f.length);
            if (info)
                return info;
            if (head.length < want || want >= 65536)
                return null;    // whole file scanned (or cap hit): truly bad
            want *= 4;
        }
    }

    export function parseWavHeader(head: string, fileLength: number): WavInfo | null {
        if (head.length < 44 || head.substr(0, 4) !== "RIFF" || head.substr(8, 4) !== "WAVE")
            return null;
        var rate = 0;
        var channels = 0;
        var off = 12;
        while (off + 8 <= head.length) {
            var id = head.substr(off, 4);
            var len = rd32(head, off + 4);
            if (id === "fmt " && off + 8 + 16 <= head.length) {
                channels = rd16(head, off + 10);
                rate = rd32(head, off + 12);
            } else if (id === "data") {
                if (!rate || !channels)
                    return null;
                var avail = fileLength - (off + 8);
                return {
                    rate: rate,
                    channels: channels,
                    dataOffset: off + 8,
                    dataBytes: Math.min(len, avail < 0 ? 0 : avail)
                };
            }
            off += 8 + len + (len & 1);
        }
        return null;
    }

    // ---- transcode cache ------------------------------------------------
    function pcmDir(): string {
        return backslash(js.exec_dir) + "data/pcm";
    }

    export function ffmpegAvailable(): boolean {
        var out = system.popen("which ffmpeg 2>/dev/null");
        return !!(out && out.length && out[0].length);
    }

    /** Transcode (once) to the canonical low-rate WAV; returns its path or null. */
    export function ensureTranscoded(track: PlayableTrack): string | null {
        var key = md5_calc(track.name + ":" + track.size + ":" + track.mtime +
            ":v2:" + PCM_RATE + "x" + PCM_CHANNELS, true);
        var out = pcmDir() + "/" + key + ".wav";
        if (file_exists(out) && file_size(out) > 44)
            return out;
        if (!mkpath(pcmDir()))
            return null;
        // -map_metadata -1 + -bitexact: no RIFF LIST/INFO chunks, so the
        // header is the canonical 44 bytes (a fat ID3 comment once pushed the
        // data chunk past the header read and broke playback).
        var cmd = "ffmpeg -v quiet -y -i " + shellQuote(track.path) +
            " -map_metadata -1 -bitexact" +
            " -ar " + PCM_RATE + " -ac " + PCM_CHANNELS +
            " -c:a pcm_s16le -f wav " + shellQuote(out) + " </dev/null";
        system.exec(cmd);
        if (file_exists(out) && file_size(out) > 44)
            return out;
        return null;
    }

    // ---- terminal input: keys + CSI audio notifications -------------------
    export interface PumpResult {
        keys: string[];       // plain keys, uppercased ("Q", " ", "\r"...)
        arrows: string[];     // "up" | "down" | "left" | "right"
        esc: boolean;         // lone ESC key
        audio: number[][];    // [id, state] pairs from CSI =7;...n reports
        cpr: number[][];      // [rows, cols] cursor-position reports (size probe)
    }

    export class InputPump {
        private buf: string = "";

        /** Poll for up to maxMs, decoding everything that arrives. */
        pump(maxMs: number): PumpResult {
            var res: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [] };
            var deadline = nowMs() + maxMs;
            do {
                var k = console.inkey(K_NONE, 10);
                while (typeof k === "string" && k.length) {
                    this.buf += k;
                    k = console.inkey(K_NONE, 0);
                }
                this.drain(res, false);
            } while (nowMs() < deadline);
            this.drain(res, true);
            return res;
        }

        private drain(res: PumpResult, idle: boolean): void {
            for (; ;) {
                if (!this.buf.length)
                    return;
                var c = this.buf.charAt(0);
                if (c !== "\x1b") {
                    res.keys.push(c.toUpperCase());
                    this.buf = this.buf.substr(1);
                    continue;
                }
                // ESC ...: need at least ESC [ + final byte to decode a CSI.
                if (this.buf.length === 1) {
                    if (idle) {           // nothing followed: it's the Esc key
                        res.esc = true;
                        this.buf = "";
                    }
                    return;
                }
                if (this.buf.charAt(1) !== "[") {
                    res.esc = true;       // ESC + non-CSI: treat as Esc, re-scan rest
                    this.buf = this.buf.substr(1);
                    continue;
                }
                var m = /^\x1b\[([0-9;=?]*)([@-~])/.exec(this.buf);
                if (!m) {
                    if (idle && this.buf.length > 24)
                        this.buf = "";    // malformed: don't wedge
                    return;               // incomplete CSI: wait for more bytes
                }
                this.buf = this.buf.substr(m[0].length);
                var body = m[1];
                var fin = m[2];
                if (fin === "n" && body.substr(0, 2) === "=7") {
                    var parts = body.substr(2).split(";");
                    // "=7;a;b[;c;d...]n" -> leading empty from ";a" split
                    for (var i = 1; i + 1 < parts.length + 1; i += 2) {
                        var id = parseInt(parts[i], 10);
                        var st = parseInt(parts[i + 1], 10);
                        if (!isNaN(id) && !isNaN(st))
                            res.audio.push([id, st]);
                    }
                } else if (fin === "R") {
                    var rc = body.split(";");
                    var pr = parseInt(rc[0], 10);
                    var pc = parseInt(rc[1], 10);
                    if (!isNaN(pr) && !isNaN(pc))
                        res.cpr.push([pr, pc]);
                } else if (fin === "A") {
                    res.arrows.push("up");
                } else if (fin === "B") {
                    res.arrows.push("down");
                } else if (fin === "C") {
                    res.arrows.push("right");
                } else if (fin === "D") {
                    res.arrows.push("left");
                }
                // other CSI (mouse, reports): ignored
            }
        }
    }

    // ---- sink detection ---------------------------------------------------
    /**
     * Two-stage probe:
     *  1. APC SyncTERM:Q;libsndfile -> CSI =7;100;1 n  => real SyncTERM.
     *  2. Store+Load+Queue a ~60ms silent clip with Update armed; a
     *     CSI =7;<ch>;0 n drain notify => any APC sink (BBSproxy).
     * Cached for the session; pass force=true to redetect.
     */
    export function detectSink(force?: boolean): SinkKind {
        if (detectedSink !== null && !force)
            return detectedSink;
        var pumpr = new InputPump();
        var found: SinkKind = "none";

        apc("Q;libsndfile");
        var deadline = nowMs() + 700;
        while (nowMs() < deadline) {
            var r = pumpr.pump(50);
            for (var i = 0; i < r.audio.length; i++) {
                if (r.audio[i][0] === 100 && r.audio[i][1] === 1) {
                    found = "syncterm";
                    break;
                }
            }
            if (found !== "none")
                break;
        }

        if (found === "none") {
            // Silent probe clip: 60ms of zeros at the streaming format.
            var bytes = Math.floor(PCM_RATE * PCM_CHANNELS * 2 * 0.06);
            var silence = wavHeader(bytes, PCM_RATE, PCM_CHANNELS) +
                repeatByte("\x00", bytes);
            apc("C;S;flrprobe.wav;" + base64_encode(silence));
            apc("A;Load;S=0;flrprobe.wav");
            apc("A;Update;C=" + CHANNEL);
            apc("A;Queue;C=" + CHANNEL + ";S=0");
            deadline = nowMs() + 1200;
            while (nowMs() < deadline) {
                var r2 = pumpr.pump(60);
                for (var j = 0; j < r2.audio.length; j++) {
                    if (r2.audio[j][0] === CHANNEL && r2.audio[j][1] === 0) {
                        found = "apc";
                        break;
                    }
                }
                if (found !== "none")
                    break;
            }
        }

        detectedSink = found;
        return found;
    }

    function repeatByte(ch: string, count: number): string {
        var out = "";
        while (out.length < count)
            out += (out.length * 2 <= count && out.length) ? out : ch;
        return out.substr(0, count);
    }

    // ---- per-chunk audio features -----------------------------------------
    export function chunkFeatures(slice: string, channels: number): { rms: number; raw: number; zcr: number } {
        var frames = Math.floor(slice.length / (channels * 2));
        if (frames < 2)
            return { rms: 0, raw: 0, zcr: 0 };
        // RMS (loudness): strided samples across the whole chunk.
        var points = 256;
        var step = Math.max(1, Math.floor(frames / points));
        var sumSq = 0;
        var count = 0;
        for (var f = 0; f < frames; f += step) {
            var v = rd16(slice, f * channels * 2);   // left channel
            if (v >= 0x8000)
                v -= 0x10000;
            sumSq += v * v;
            count++;
        }
        if (!count)
            return { rms: 0, raw: 0, zcr: 0 };
        var raw = Math.sqrt(sumSq / count) / 32768;
        // Perceptual-ish lift for METERS only: quiet music still moves them.
        // Beat/onset detection uses `raw` — the lift compresses loud passages
        // so hard that deltas vanish and beats never fire on hot mixes.
        var rms = Math.sqrt(clamp(raw * 3.2, 0, 1));
        // ZCR (brightness): must be measured over CONTIGUOUS samples — strided
        // points ~26ms apart are decorrelated and always read ~50% flips.
        var winFrames = Math.min(frames, 512);
        var start = Math.floor((frames - winFrames) / 2);
        var crossings = 0;
        var prev = 0;
        for (var w = 0; w < winFrames; w++) {
            var s = rd16(slice, (start + w) * channels * 2);
            if (s >= 0x8000)
                s -= 0x10000;
            if (w > 0 && ((s >= 0) !== (prev >= 0)))
                crossings++;
            prev = s;
        }
        // crossings/frame *at the PCM rate*: ~0.02 = bassy, ~0.25+ = bright.
        var zcr = clamp((crossings / winFrames) * 5, 0, 1);
        return { rms: rms, raw: raw, zcr: zcr };
    }

    // ---- synced lyrics -------------------------------------------------------
    /** Index of the lyric line active at `sec`, or -1. `fromIdx` makes the
     *  common forward walk O(1); it resets automatically after a back-seek. */
    export function lyricIndexFor(lyrics: LyricLine[], sec: number, fromIdx: number): number {
        if (!lyrics || !lyrics.length || sec < lyrics[0].time)
            return -1;
        var i = fromIdx >= 0 && fromIdx < lyrics.length && lyrics[fromIdx].time <= sec
            ? fromIdx : 0;
        while (i + 1 < lyrics.length && lyrics[i + 1].time <= sec)
            i++;
        return i;
    }

    /** Distribute untimed lyric text evenly across the song duration. */
    export function distributeLyrics(flat: string, totalSec: number): LyricLine[] {
        var lines: string[] = [];
        var parts = String(flat || "").split("\n");
        for (var i = 0; i < parts.length; i++) {
            var t = parts[i].replace(/^\s+|\s+$/g, "");
            if (t.length)
                lines.push(t);
        }
        var out: LyricLine[] = [];
        if (!lines.length || totalSec <= 0)
            return out;
        var span = totalSec / (lines.length + 1);
        for (var j = 0; j < lines.length; j++)
            out.push({ time: span * (j + 1), text: lines[j] });
        return out;
    }

    // ---- playback screen ----------------------------------------------------
    var CLR = "\x1b[0m";

    function sgr(codes: string): string {
        return "\x1b[" + codes + "m";
    }

    function gotoRC(row: number, col: number): string {
        return "\x1b[" + row + ";" + col + "H";
    }

    interface Layout {
        cols: number;
        rows: number;
        boxTop: number;    // first row of the overlay box (4 rows)
        boxLeft: number;
        boxWidth: number;
        glowRow1: number;  // strip above the lyric line
        lyricRow: number;
        glowRow2: number;  // strip below the lyric line
        artTop: number;    // art window: rows artTop .. artBottom (inclusive)
        artBottom: number;
    }

    function layout(termCols?: number, termRows?: number): Layout {
        var cols = Math.max(40, termCols || console.screen_columns || 80);
        var rows = Math.max(14, termRows || console.screen_rows || 24);
        var width = Math.min(cols - 2, 76);
        return {
            cols: cols,
            rows: rows,
            boxTop: rows - 4,
            boxLeft: Math.max(1, Math.floor((cols - width) / 2) + 1),
            boxWidth: width,
            glowRow1: rows - 7,
            lyricRow: rows - 6,
            glowRow2: rows - 5,
            artTop: 1,
            artBottom: rows - 8
        };
    }

    // The art backdrop: grid-rendered, centered, trimmed. The blit descriptor
    // doubles as the backing store so sprites can restore what they fly over.
    interface ArtBlit {
        grid: FLAnsiGrid.Grid | null;
        left: number;      // screen col of blit origin (1-based)
        top: number;       // screen row of blit origin
        srcRow: number;    // first grid row shown
        srcCol: number;
        nRows: number;
        nCols: number;
        pal: number;       // FLAnsiGrid.PALETTES index currently shown
    }

    function makeArtBlit(track: PlayableTrack, l: Layout): ArtBlit {
        var blit: ArtBlit = {
            grid: null, left: 1, top: l.artTop,
            srcRow: 0, srcCol: 0, nRows: 0, nCols: 0, pal: 0
        };
        if (!track.ansiArt.length)
            return blit;
        var grid = FLAnsiGrid.render(FLAnsiGrid.stripSauce(track.ansiArt), ART_WIDTH);
        if (!grid.height)
            return blit;
        var availRows = l.artBottom - l.artTop + 1;
        var availCols = l.cols;
        blit.grid = grid;
        blit.nRows = Math.min(grid.height, availRows);
        blit.nCols = Math.min(grid.width, availCols);
        blit.srcRow = 0;                                  // trim bottom overflow
        blit.srcCol = Math.max(0, Math.floor((grid.width - blit.nCols) / 2));
        blit.top = l.artTop + Math.max(0, Math.floor((availRows - blit.nRows) / 2));
        blit.left = Math.max(1, Math.floor((availCols - blit.nCols) / 2) + 1);
        return blit;
    }

    function drawArt(blit: ArtBlit): void {
        if (!blit.grid)
            return;
        console.write(FLAnsiGrid.emit(blit.grid, blit.left, blit.top,
            blit.srcRow, blit.nRows, blit.srcCol, blit.nCols, blit.pal));
    }

    /** Restore the backdrop over a screen rect: art cells where the rect
     *  overlaps the art blit; elsewhere a "wake" — a colored shade (the
     *  sprite's trail) that the next background repaint dissolves. */
    function restoreRect(blit: ArtBlit, l: Layout, x: number, y: number, w: number, h: number,
        trailSgr?: string): void {
        var y0 = Math.max(l.artTop, y);
        var y1 = Math.min(l.artBottom, y + h - 1);
        var x0 = Math.max(1, x);
        var x1 = Math.min(l.cols, x + w - 1);
        if (y1 < y0 || x1 < x0)
            return;
        // Fill the whole rect first (trail or blank), then re-blit the
        // overlapping slice of art on top — trails only ever show where the
        // art doesn't cover.
        var out = trailSgr ? sgr(trailSgr) : CLR;
        var fill = repeatByte(trailSgr ? "\xB0" : " ", x1 - x0 + 1);
        for (var r = y0; r <= y1; r++)
            out += gotoRC(r, x0) + fill;
        console.write(out + CLR);
        if (!blit.grid)
            return;
        var ax0 = Math.max(x0, blit.left);
        var ax1 = Math.min(x1, blit.left + blit.nCols - 1);
        var ay0 = Math.max(y0, blit.top);
        var ay1 = Math.min(y1, blit.top + blit.nRows - 1);
        if (ax1 < ax0 || ay1 < ay0)
            return;
        console.write(FLAnsiGrid.emit(blit.grid,
            ax0, ay0,
            blit.srcRow + (ay0 - blit.top), ay1 - ay0 + 1,
            blit.srcCol + (ax0 - blit.left), ax1 - ax0 + 1,
            blit.pal));
    }

    function drawBackdrop(track: PlayableTrack, l: Layout, blit: ArtBlit): void {
        console.write(CLR + "\x1b[2J\x1b[H");
        if (blit.grid) {
            drawArt(blit);
        } else {
            // No embedded art: a dim generated backdrop so the box isn't lonely.
            var mid = Math.max(2, Math.floor((l.artTop + l.artBottom) / 2) - 1);
            var t = track.title.length > l.cols - 4 ? track.title.substr(0, l.cols - 4) : track.title;
            var a = track.artist.length > l.cols - 4 ? track.artist.substr(0, l.cols - 4) : track.artist;
            console.write(gotoRC(mid, Math.max(1, Math.floor((l.cols - t.length) / 2))) +
                sgr("1;36") + t + CLR);
            console.write(gotoRC(mid + 2, Math.max(1, Math.floor((l.cols - a.length) / 2))) +
                sgr("0;36") + a + CLR);
        }
    }

    /** The double-line overlay box: static parts drawn once. */
    function drawBoxFrame(l: Layout, borderSgr: string): void {
        var horiz = repeatByte("\xCD", l.boxWidth - 2);
        console.write(sgr(borderSgr));
        console.write(gotoRC(l.boxTop, l.boxLeft) + "\xC9" + horiz + "\xBB");
        for (var r = 1; r <= 2; r++) {
            console.write(gotoRC(l.boxTop + r, l.boxLeft) + "\xBA" +
                repeatByte(" ", l.boxWidth - 2) + "\xBA");
        }
        console.write(gotoRC(l.boxTop + 3, l.boxLeft) + "\xC8" + horiz + "\xBC");
        console.write(CLR);
    }

    function drawTitleLine(l: Layout, track: PlayableTrack): void {
        var inner = l.boxWidth - 4;
        var label = "\x0e " + track.title + (track.artist.length ? " - " + track.artist : "");
        if (label.length > inner)
            label = label.substr(0, inner - 3) + "...";
        console.write(gotoRC(l.boxTop + 1, l.boxLeft + 2) +
            sgr("1;36") + label + repeatByte(" ", inner - label.length) + CLR);
    }

    function drawProgress(l: Layout, playedSec: number, totalSec: number, paused: boolean, volumePct: number): void {
        var inner = l.boxWidth - 4;
        var timeTxt = fmtTime(playedSec) + "/" + fmtTime(totalSec);
        var volTxt = paused ? " PAUSED " : (" vol" + volumePct + " ");
        var barWidth = inner - timeTxt.length - volTxt.length - 2;
        if (barWidth < 8) {
            volTxt = "";
            barWidth = inner - timeTxt.length - 2;
        }
        var fill = totalSec > 0 ? clamp(Math.round(barWidth * playedSec / totalSec), 0, barWidth) : 0;
        var bar = sgr(paused ? "1;33" : "1;37") + repeatByte("\xDB", fill) +
            sgr("0;34") + repeatByte("\xB0", barWidth - fill) + CLR;
        console.write(gotoRC(l.boxTop + 2, l.boxLeft + 2) +
            bar + " " + sgr("0;37") + timeTxt + sgr(paused ? "1;33" : "0;36") + volTxt + CLR);
    }

    function drawHints(l: Layout): void {
        // ASCII only: CP437 arrow glyphs live at C0 control positions (0x1B is
        // ESC!) and cannot be sent raw without corrupting the terminal state.
        var hints = "[Space]Pause  [< >]Seek  [Up/Dn]Vol  [N/P]Track  [V]iz [B]g  [Q]uit";
        if (hints.length > l.boxWidth)
            hints = "[Spc]Pse [</>]Seek [N/P]Trk [Q]uit";
        var col = Math.max(1, l.boxLeft + Math.floor((l.boxWidth - hints.length) / 2));
        console.write(gotoRC(Math.min(l.rows, l.boxTop + 4), col) + sgr("0;30;1") + hints + CLR);
    }

    // Audio-reactive glow strips flanking the lyric line: reach follows
    // loudness, color follows brightness (ZCR): bass reads red/magenta,
    // bright reads cyan/white.
    // Art palette swaps are part of the default look; [V] steps away from it.
    var VIS_MODES = ["glow+art", "glow", "border", "off"];

    function drawGlow(l: Layout, row: number, rms: number, zcr: number, on: boolean): void {
        if (!on) {
            console.write(CLR + gotoRC(row, l.boxLeft) + repeatByte(" ", l.boxWidth));
            return;
        }
        var half = Math.floor(l.boxWidth / 2);
        var reach = Math.round(half * rms);
        var color = zcr > 0.66 ? "1;37" : zcr > 0.45 ? "1;36" : zcr > 0.28 ? "0;36" : zcr > 0.15 ? "1;35" : "0;31";
        var line = "";
        for (var i = 0; i < half; i++) {
            if (i < reach) {
                var d = i / Math.max(1, reach);   // fade toward the edges
                line += d > 0.75 ? "\xB0" : d > 0.45 ? "\xB1" : d > 0.2 ? "\xB2" : "\xDB";
            } else {
                line += " ";
            }
        }
        var left = line.split("").reverse().join("");
        var strip = left + line + (l.boxWidth % 2 ? " " : "");
        console.write(gotoRC(row, l.boxLeft) + sgr(color) + strip.substr(0, l.boxWidth) + CLR);
    }

    function drawLyric(l: Layout, text: string): void {
        var t = text.length > l.boxWidth - 2 ? text.substr(0, l.boxWidth - 5) + "..." : text;
        var pad = l.boxWidth - t.length;
        var lead = Math.floor(pad / 2);
        console.write(gotoRC(l.lyricRow, l.boxLeft) + CLR +
            repeatByte(" ", lead) + sgr("1;33") + t + CLR +
            repeatByte(" ", pad - lead));
    }

    // ---- background effects in the art margins --------------------------------
    // Whatever art-zone area the (centered) art does not cover gets a music-
    // locked effect: a checkerboard whose phase steps on beats and whose
    // shade/color follow loudness/brightness, with a bright strobe flash
    // decaying over a few frames on hard beats. The lyric line, glow strips,
    // box and hints rows are never touched. [B] cycles auto/checker/strobe/off.
    var BG_MODES = ["auto", "checker", "plasma", "ripple", "strobe", "off"];

    interface Rect { x: number; y: number; w: number; h: number; }

    function marginRects(l: Layout, blit: ArtBlit): Rect[] {
        var rects: Rect[] = [];
        var zoneTop = l.artTop;
        var zoneBottom = l.artBottom;
        if (!blit.grid || !blit.nRows) {
            // No art: the whole zone (the box already carries the title).
            rects.push({ x: 1, y: zoneTop, w: l.cols, h: zoneBottom - zoneTop + 1 });
        } else {
            var artL = blit.left;
            var artR = blit.left + blit.nCols - 1;
            var artT = blit.top;
            var artB = blit.top + blit.nRows - 1;
            if (artT > zoneTop)
                rects.push({ x: 1, y: zoneTop, w: l.cols, h: artT - zoneTop });
            if (artB < zoneBottom)
                rects.push({ x: 1, y: artB + 1, w: l.cols, h: zoneBottom - artB });
            if (artL > 1)
                rects.push({ x: 1, y: artT, w: artL - 1, h: artB - artT + 1 });
            if (artR < l.cols)
                rects.push({ x: artR + 1, y: artT, w: l.cols - artR, h: artB - artT + 1 });
        }
        // Bottom zone: effects run BEHIND the metadata rows too — the columns
        // flanking the box span, from the glow strips down to the hints row.
        // The lyric/glow/box/hints content lives inside the box span and
        // repaints itself, so the flanks never touch it.
        var flankTop = l.glowRow1;
        var flankH = Math.min(l.rows, l.boxTop + 4) - flankTop + 1;
        if (l.boxLeft > 1)
            rects.push({ x: 1, y: flankTop, w: l.boxLeft - 1, h: flankH });
        var boxR = l.boxLeft + l.boxWidth;
        if (boxR <= l.cols)
            rects.push({ x: boxR, y: flankTop, w: l.cols - boxR + 1, h: flankH });
        return rects;
    }

    function glowColor(zcr: number): string {
        return zcr > 0.66 ? "1;37" : zcr > 0.45 ? "1;36" : zcr > 0.28 ? "0;36"
            : zcr > 0.15 ? "1;35" : "0;31";
    }

    /** Checkerboard: 3-col blocks alternating shade/space; one SGR per row. */
    function drawChecker(rects: Rect[], phase: number, rms: number, zcr: number): void {
        var shade = rms > 0.7 ? "\xB2" : rms > 0.4 ? "\xB1" : "\xB0";
        var out = sgr(glowColor(zcr));
        for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            for (var row = 0; row < rc.h; row++) {
                var line = "";
                for (var col = 0; col < rc.w; col++) {
                    var block = Math.floor(col / 3) + row + phase;
                    line += (block % 2 === 0) ? shade : " ";
                }
                out += gotoRC(rc.y + row, rc.x) + line;
            }
        }
        console.write(out + CLR);
    }

    // Shared band tables for the field effects: cool family for bright
    // (high-ZCR) passages, warm for bassy ones; char density rises with the
    // field value so the pattern reads even on monochrome-ish terminals.
    var FIELD_COOL = ["0;34", "0;36", "1;36", "1;37"];
    var FIELD_WARM = ["0;35", "0;31", "1;35", "1;33"];
    var FIELD_CHARS = [" ", "\xB0", "\xB1", "\xB2"];

    /** Paint every cell of the margin rects from a value field (0..1). */
    function fieldPaint(rects: Rect[], zcr: number,
        valueAt: (x: number, y: number) => number): void {
        var colors = zcr > 0.4 ? FIELD_COOL : FIELD_WARM;
        var out = "";
        var lastBand = -1;
        for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            for (var row = 0; row < rc.h; row++) {
                out += gotoRC(rc.y + row, rc.x);
                lastBand = -1;
                for (var col = 0; col < rc.w; col++) {
                    var v = valueAt(rc.x + col, rc.y + row);
                    var band = Math.floor(clamp(v, 0, 0.999) * FIELD_CHARS.length);
                    if (band !== lastBand) {
                        out += sgr(colors[band]);
                        lastBand = band;
                    }
                    out += FIELD_CHARS[band];
                }
            }
        }
        console.write(out + CLR);
    }

    /** Plasma: layered sine field; time advances with loudness, beats jolt it. */
    function drawPlasma(rects: Rect[], t: number, zcr: number): void {
        var scale = 0.12;
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            var nx = x * scale;
            var ny = y * scale * 2;   // terminal cells are ~2x taller than wide
            var val = Math.sin(nx + t) +
                Math.sin((ny + t * 0.7) * 1.3) +
                Math.sin(Math.sqrt(nx * nx + ny * ny) + t * 0.4);
            return (val + 3) / 6;
        });
    }

    interface Ripple { cx: number; cy: number; r: number; }

    /** Ripples: beat-spawned expanding rings summed as an interference field. */
    function drawRipples(rects: Rect[], rings: Ripple[], zcr: number): void {
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            var value = 0;
            for (var i = 0; i < rings.length; i++) {
                var dx = (x - rings[i].cx) * 0.5;   // squash for cell aspect
                var dy = y - rings[i].cy;
                var dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
                value += Math.sin(dist * 0.5 - rings[i].r * 0.7) / (1 + dist * 0.12);
            }
            return (value + 1.2) / 2.4;
        });
    }

    /** Strobe frame at decay level 3..1 (3 = brightest); 0 clears. */
    function drawStrobe(rects: Rect[], level: number, zcr: number): void {
        var ch = level >= 3 ? "\xB2" : level === 2 ? "\xB1" : level === 1 ? "\xB0" : " ";
        var out = level > 0 ? sgr(glowColor(zcr)) : CLR;
        for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            var line = repeatByte(ch, rc.w);
            for (var row = 0; row < rc.h; row++)
                out += gotoRC(rc.y + row, rc.x) + line;
        }
        console.write(out + CLR);
    }

    // ---- floating avatar sprites ---------------------------------------------
    // Avatars drift over the art like a screensaver, bounce off the art-zone
    // walls and each other, speed up with loudness, and get a velocity kick
    // on every beat. Erasing = restoring the art grid cells they vacated.
    interface Sprite {
        grid: FLAnsiGrid.Grid;
        x: number;        // float position (screen cols/rows, 1-based)
        y: number;
        vx: number;
        vy: number;
        drawnX: number;   // last drawn integer position (-1 = not drawn)
        drawnY: number;
        trail: number;    // TRAIL_COLORS index; shifts on bounces and beats
    }

    var TRAIL_COLORS = ["0;35", "0;34", "0;36", "0;31", "0;32", "1;30"];

    function makeSprites(track: PlayableTrack, l: Layout): Sprite[] {
        var sprites: Sprite[] = [];
        var blobs = track.avatars || [];
        var zoneW = l.cols;
        var zoneH = l.artBottom - l.artTop + 1;
        if (zoneW < AVATAR_W + 4 || zoneH < AVATAR_H + 2)
            return sprites;
        for (var i = 0; i < blobs.length && i < 2; i++) {
            var grid = FLAnsiGrid.renderBin(blobs[i], AVATAR_W, AVATAR_H);
            if (!grid)
                continue;
            sprites.push({
                grid: grid,
                x: i === 0 ? 3 : Math.max(3, zoneW - AVATAR_W - 2),
                y: l.artTop + 1 + i * 2,
                vx: (i % 2 === 0 ? 1 : -1) * 0.9,
                vy: 0.35 * (i % 2 === 0 ? 1 : -1),
                drawnX: -1,
                drawnY: -1,
                trail: i % TRAIL_COLORS.length
            });
        }
        return sprites;
    }

    function stepSprites(sprites: Sprite[], l: Layout, rms: number, beat: boolean): void {
        var minX = 1;
        var maxX = l.cols - AVATAR_W + 1;
        var minY = l.artTop;
        var maxY = l.artBottom - AVATAR_H + 1;
        if (maxX <= minX || maxY <= minY)
            return;
        var speed = 0.6 + rms * 1.8;    // loudness drives the drift
        var i: number;

        for (i = 0; i < sprites.length; i++) {
            var s = sprites[i];
            if (beat) {
                // Beat: a jolt — random kick plus a vertical jiggle.
                s.vx += (Math.random() - 0.5) * 1.6;
                s.vy += (Math.random() - 0.5) * 1.2;
            }
            // Clamp velocity so a pile of beats can't launch them.
            s.vx = clamp(s.vx, -1.6, 1.6);
            s.vy = clamp(s.vy, -1.1, 1.1);
            s.x += s.vx * speed;
            s.y += s.vy * speed;
            var bounced = false;
            if (s.x < minX) { s.x = minX; s.vx = Math.abs(s.vx); bounced = true; }
            if (s.x > maxX) { s.x = maxX; s.vx = -Math.abs(s.vx); bounced = true; }
            if (s.y < minY) { s.y = minY; s.vy = Math.abs(s.vy); bounced = true; }
            if (s.y > maxY) { s.y = maxY; s.vy = -Math.abs(s.vy); bounced = true; }
            if (bounced || beat)
                s.trail = (s.trail + 1 + Math.floor(Math.random() * 2)) % TRAIL_COLORS.length;
        }

        // Pairwise collision: overlap -> swap velocities and separate.
        for (i = 0; i + 1 < sprites.length; i++) {
            var a = sprites[i];
            var b = sprites[i + 1];
            if (Math.abs(a.x - b.x) < AVATAR_W && Math.abs(a.y - b.y) < AVATAR_H) {
                var tvx = a.vx; a.vx = b.vx; b.vx = tvx;
                var tvy = a.vy; a.vy = b.vy; b.vy = tvy;
                var tt = a.trail; a.trail = b.trail; b.trail = tt;
                var push = a.x <= b.x ? 1 : -1;
                a.x = clamp(a.x - push, minX, maxX);
                b.x = clamp(b.x + push, minX, maxX);
            }
        }
    }

    function drawSprites(sprites: Sprite[], l: Layout, blit: ArtBlit, force: boolean): void {
        for (var i = 0; i < sprites.length; i++) {
            var s = sprites[i];
            var nx = Math.round(s.x);
            var ny = Math.round(s.y);
            if (!force && nx === s.drawnX && ny === s.drawnY)
                continue;
            if (s.drawnX >= 0 && (nx !== s.drawnX || ny !== s.drawnY))
                restoreRect(blit, l, s.drawnX, s.drawnY, AVATAR_W, AVATAR_H,
                    TRAIL_COLORS[s.trail]);
            console.write(FLAnsiGrid.emit(s.grid, nx, ny, 0, AVATAR_H, 0, AVATAR_W, 0));
            s.drawnX = nx;
            s.drawnY = ny;
        }
    }

    // ---- the player -----------------------------------------------------------
    export function playTrack(track: PlayableTrack, statusLine?: (msg: string) => void): PlayResult {
        var say = statusLine || function (msg: string): void {
            console.write(CLR + "\r\x1b[K" + msg);
        };

        if (detectSink() === "none")
            return "error";
        if (!ffmpegAvailable()) {
            say("ffmpeg is not installed on the BBS host; terminal playback unavailable.");
            mswait(1800);
            return "error";
        }
        say("Preparing audio (transcoding)...");
        var wavPath = ensureTranscoded(track);
        if (wavPath === null) {
            say("Transcode failed for " + track.name);
            mswait(1800);
            return "error";
        }

        var f = new File(wavPath);
        if (!f.open("rb"))
            return "error";
        try {
            var info = readWavInfo(f);
            if (!info || !info.dataBytes) {
                say("Bad PCM cache file.");
                mswait(1500);
                return "error";
            }
            return playLoop(track, f, info);
        } finally {
            f.close();
        }
    }

    function playLoop(track: PlayableTrack, f: File, info: WavInfo): PlayResult {
        var bytesPerSec = info.rate * info.channels * 2;
        var chunkBytes = Math.floor(bytesPerSec * CHUNK_MS / 1000);
        // Frame-align so a chunk never splits a sample frame.
        chunkBytes -= chunkBytes % (info.channels * 2);
        var totalChunks = Math.ceil(info.dataBytes / chunkBytes);
        var totalSec = info.dataBytes / bytesPerSec;

        var termCols = 0;             // 0 = trust console.screen_*
        var termRows = 0;
        var l = layout();
        var pump = new InputPump();
        var visMode = 0;
        var bgMode = 0;               // BG_MODES index
        var volumePct = 80;
        var borderPulse = 0;          // decaying beat flash
        var lastRms = 0;
        var artFlashAt = 0;
        // Beat-stepped palette sequence: every other step returns to the true
        // palette so the art keeps reading as itself between swaps.
        var PALETTE_SEQ = [0, 1, 0, 3, 0, 2, 0, 4];
        var palStep = 0;
        var margins: Rect[] = [];
        var checkerPhase = 0;
        var checkerDirty = true;
        var strobeLevel = 0;
        var plasmaT = 0;
        var rings: Ripple[] = [];
        var fieldTick = 0;            // field effects repaint on alternate ticks
        var lastProbeAt = 0;
        // Onset + energy tracking (all on RAW rms, updated once per chunk):
        // emaFast (~1s) is the local level — a chunk jumping clearly above it
        // is a beat/accent, even mid-plateau. emaSlow (~6s) is the passage
        // energy — fast diverging from slow marks quiet<->loud transitions,
        // which drive the auto background rotation.
        var emaFast = -1;
        var emaSlow = -1;
        var lastFeatChunk = -1;
        var autoIdx = 0;              // auto rotation: checker -> plasma -> ripple
        var AUTO_EFFECTS = ["checker", "plasma", "ripple"];
        var lastAutoSwitchAt = nowMs();

        var blit = makeArtBlit(track, l);
        var sprites = makeSprites(track, l);
        margins = marginRects(l, blit);
        var lyrics: LyricLine[] = track.lyrics && track.lyrics.length
            ? track.lyrics
            : distributeLyrics(track.flatLyrics || "", totalSec);
        var lyricIdx = -1;

        function redrawAll(): void {
            drawBackdrop(track, l, blit);
            drawBoxFrame(l, "0;34");
            drawTitleLine(l, track);
            drawHints(l);
            checkerDirty = true;
            strobeLevel = 0;
            for (var si = 0; si < sprites.length; si++) {
                // Clamp into the (possibly smaller) new zone; force redraw.
                sprites[si].x = clamp(sprites[si].x, 1, Math.max(1, l.cols - AVATAR_W + 1));
                sprites[si].y = clamp(sprites[si].y, l.artTop, Math.max(l.artTop, l.artBottom - AVATAR_H + 1));
                sprites[si].drawnX = -1;
                sprites[si].drawnY = -1;
            }
            drawSprites(sprites, l, blit, true);
        }

        function relayout(cols: number, rows: number): void {
            if (cols === l.cols && rows === l.rows)
                return;
            termCols = cols;
            termRows = rows;
            l = layout(termCols, termRows);
            blit = makeArtBlit(track, l);
            margins = marginRects(l, blit);
            lyricIdx = -1;      // repaint the lyric row after the redraw
            rings = [];
            redrawAll();
        }

        redrawAll();

        apc("A;Volume;C=" + CHANNEL + ";V=" + volumePct);
        apc("A;Update;C=" + CHANNEL);

        var chunk = 0;                 // next chunk to emit
        var t0 = nowMs();              // wall-clock anchor: chunk i plays at t0 + i*CHUNK_MS
        var paused = false;
        var pausedMs = 0;              // frozen playhead while paused
        // Any intentional Flush (track start counts: the PREVIOUS track's fade
        // tail may still fire its armed notify) opens a grace window during
        // which drain notifies are stale echoes of our own Flush, NOT
        // underruns. Treating them as underruns re-Flushes, which fires the
        // next notify: a restart ping-pong that scrubs the song back and forth.
        var FLUSH_GRACE_MS = 1500;
        var lastFlushAt = nowMs();
        var lastUiAt = 0;
        var result: PlayResult = "ended";
        var features: { rms: number; raw: number; zcr: number } = { rms: 0, raw: 0, zcr: 0 };
        var featForChunk: { rms: number; raw: number; zcr: number }[] = [];

        function emitChunk(idx: number): void {
            f.position = info.dataOffset + idx * chunkBytes;
            var want = Math.min(chunkBytes, info.dataBytes - idx * chunkBytes);
            var slice = f.read(want);
            if (!slice || !slice.length)
                return;
            featForChunk[idx] = chunkFeatures(slice, info.channels);
            var name = "flr" + (idx % SLOTS) + ".wav";
            var slot = idx % SLOTS;
            console.write(
                "\x1b_SyncTERM:C;S;" + name + ";" +
                base64_encode(wavHeader(slice.length, info.rate, info.channels) + slice) +
                "\x1b\\" +
                "\x1b_SyncTERM:A;Load;S=" + slot + ";" + name + "\x1b\\" +
                "\x1b_SyncTERM:A;Queue;C=" + CHANNEL + ";S=" + slot + "\x1b\\");
        }

        function rePrime(fromChunk: number): void {
            chunk = clamp(fromChunk, 0, totalChunks);
            t0 = nowMs() - chunk * CHUNK_MS + PREBUFFER * CHUNK_MS;
            lastFlushAt = nowMs();
            apc("A;Flush;C=" + CHANNEL);
            apc("A;Update;C=" + CHANNEL);
        }

        while (bbs.online && !js.terminated) {
            var now = nowMs();
            var playMs = paused ? pausedMs : (now - t0);
            var playChunk = clamp(Math.floor(playMs / CHUNK_MS), 0, totalChunks);

            if (!paused) {
                // Top up the cushion: emit every chunk whose send-time has come.
                var guard = 0;
                while (chunk < totalChunks &&
                       chunk <= playChunk + PREBUFFER &&
                       guard++ < PREBUFFER + 2) {
                    emitChunk(chunk);
                    chunk++;
                }
            }

            // ---- input + audio events ----
            var ev = pump.pump(20);
            var quitReq = ev.esc;
            if (ev.esc)
                result = "quit";      // Esc means leave, not "song ended"
            for (var i = 0; i < ev.keys.length; i++) {
                var k = ev.keys[i];
                if (k === "Q") {
                    // Without this, breaking with the default result ("ended")
                    // made Q behave exactly like N: jukebox auto-advance.
                    result = "quit";
                    quitReq = true;
                }
                else if (k === " ") {
                    if (!paused) {
                        paused = true;
                        pausedMs = playMs;      // freeze the displayed clock
                        lastFlushAt = now;      // our Flush, not an underrun
                        apc("A;Flush;C=" + CHANNEL);
                        chunk = playChunk;      // resume point
                    } else {
                        paused = false;
                        rePrime(chunk);
                    }
                } else if (k === "N") {
                    result = "next";
                    quitReq = true;
                } else if (k === "P") {
                    result = "prev";
                    quitReq = true;
                } else if (k === "V") {
                    visMode = (visMode + 1) % VIS_MODES.length;
                    drawGlow(l, l.glowRow1, 0, 0, false);
                    drawGlow(l, l.glowRow2, 0, 0, false);
                    if (blit.grid && blit.pal !== 0) {
                        blit.pal = 0;
                        palStep = 0;
                        drawArt(blit);
                        drawSprites(sprites, l, blit, true);
                    }
                } else if (k === "B") {
                    bgMode = (bgMode + 1) % BG_MODES.length;
                    strobeLevel = 0;
                    rings = [];
                    drawStrobe(margins, 0, 0);   // clear the margins
                    checkerDirty = true;
                }
            }
            for (var a = 0; a < ev.arrows.length; a++) {
                var dir = ev.arrows[a];
                if (dir === "left" || dir === "right") {
                    var delta = (dir === "left" ? -SEEK_SECONDS : SEEK_SECONDS) * 1000;
                    var target = clamp(playMs + delta, 0, Math.max(0, (totalChunks - 1) * CHUNK_MS));
                    if (!paused)
                        rePrime(Math.floor(target / CHUNK_MS));
                    else
                        chunk = clamp(Math.floor(target / CHUNK_MS), 0, totalChunks);
                    lyricIdx = -1;   // re-resolve after a seek (may be backwards)
                } else if (dir === "up" || dir === "down") {
                    volumePct = clamp(volumePct + (dir === "up" ? VOLUME_STEP : -VOLUME_STEP), 0, 100);
                    apc("A;Volume;C=" + CHANNEL + ";V=" + volumePct + ";T=120");
                }
            }
            for (var e = 0; e < ev.audio.length; e++) {
                if (ev.audio[e][0] === CHANNEL && ev.audio[e][1] === 0 && !paused) {
                    if (chunk >= totalChunks) {
                        // Armed notify after the last chunk: the song finished.
                        result = "ended";
                        quitReq = true;
                    } else if (now - lastFlushAt < FLUSH_GRACE_MS) {
                        // Stale echo of our own Flush (seek/pause/track start):
                        // the one-shot was consumed by it, so just re-arm and
                        // keep playing. Recovering here would re-Flush and
                        // trigger the next echo — the restart ping-pong.
                        apc("A;Update;C=" + CHANNEL);
                    } else {
                        // Underrun: the cushion ran dry (slow link / stall).
                        // Re-anchor and re-prime, exactly like lameboy does.
                        rePrime(playChunk);
                    }
                }
            }
            if (quitReq)
                break;

            // Responsive layout: a parked-cursor CPR probe every 2s catches
            // client-side resizes (SyncTERM answers 6n; so does iTerm2); a
            // NAWS-updated console.screen_* is folded in on the same path.
            for (var cp = 0; cp < ev.cpr.length; cp++)
                relayout(ev.cpr[cp][1], ev.cpr[cp][0]);
            if (now - lastProbeAt >= 2000) {
                lastProbeAt = now;
                console.write("\x1b7\x1b[999;999H\x1b[6n\x1b8");
                var nawsC = console.screen_columns || 0;
                var nawsR = console.screen_rows || 0;
                if (!termCols && nawsC && nawsR && (nawsC !== l.cols || nawsR !== l.rows))
                    relayout(nawsC, nawsR);
            }

            // Natural end fallback (in case the drain notify was lost).
            if (!paused && chunk >= totalChunks && playMs > totalSec * 1000 + 1500) {
                result = "ended";
                break;
            }

            // ---- UI tick ----
            if (now - lastUiAt >= UI_TICK_MS) {
                lastUiAt = now;
                var fi = featForChunk[clamp(playChunk, 0, featForChunk.length - 1)];
                if (fi)
                    features = fi;
                var mode = VIS_MODES[visMode];
                var beat = false;
                var hardBeat = false;
                if (!paused && playChunk !== lastFeatChunk && features.raw > 0) {
                    lastFeatChunk = playChunk;
                    if (emaFast < 0) {
                        emaFast = features.raw;
                        emaSlow = features.raw;
                    }
                    beat = features.raw > emaFast * 1.25 + 0.015;
                    hardBeat = features.raw > emaFast * 1.55 + 0.03;
                    emaFast = emaFast * 0.7 + features.raw * 0.3;
                    emaSlow = emaSlow * 0.95 + features.raw * 0.05;
                }
                if (beat)
                    borderPulse = 3;
                lastRms = features.rms;

                // Auto background rotation on musical transitions: the local
                // level diverging from the passage energy (quiet->loud or
                // loud->quiet) advances the effect, with a 30s variety
                // fallback so long steady passages still evolve. The switch
                // announces itself with a strobe flash.
                if (BG_MODES[bgMode] === "auto" && !paused && emaSlow > 0) {
                    var swAge = now - lastAutoSwitchAt;
                    var ratio = (emaFast - emaSlow) / Math.max(emaSlow, 0.01);
                    if ((swAge > 8000 && (ratio > 0.4 || ratio < -0.3)) || swAge > 30000) {
                        lastAutoSwitchAt = now;
                        autoIdx = (autoIdx + 1) % AUTO_EFFECTS.length;
                        rings = [];
                        checkerDirty = true;
                        strobeLevel = 3;
                    }
                }

                // Art color-pulse: on beats, step the palette sequence (a
                // set of distinct permutation maps that keeps returning to the
                // true palette; rate-capped so slow links keep breathing room).
                if (mode === "glow+art" && beat && blit.grid &&
                    now - artFlashAt > 450) {
                    artFlashAt = now;
                    palStep = (palStep + 1) % PALETTE_SEQ.length;
                    blit.pal = PALETTE_SEQ[palStep];
                    drawArt(blit);
                    drawSprites(sprites, l, blit, true);
                }

                // Background margins, all music-locked: checker phase steps
                // on beats; plasma time flows with loudness and jolts on
                // beats; ripples SPAWN on beats and expand with loudness;
                // hard beats fire a strobe that decays over following frames.
                var bg = BG_MODES[bgMode];
                if (bg === "auto")
                    bg = AUTO_EFFECTS[autoIdx];    // rotated by the music above
                if (margins.length && BG_MODES[bgMode] !== "off" && !paused) {
                    fieldTick++;
                    if ((BG_MODES[bgMode] === "auto" || BG_MODES[bgMode] === "strobe") && hardBeat)
                        strobeLevel = 3;
                    if (strobeLevel > 0) {
                        drawStrobe(margins, strobeLevel, features.zcr);
                        strobeLevel--;
                        if (strobeLevel === 0)
                            checkerDirty = true;   // repaint pattern after decay
                    } else if (bg === "checker") {
                        if (beat) {
                            checkerPhase++;
                            checkerDirty = true;
                        }
                        if (checkerDirty) {
                            drawChecker(margins, checkerPhase, features.rms, features.zcr);
                            checkerDirty = false;
                        }
                    } else if (bg === "plasma") {
                        plasmaT += 0.10 + features.rms * 0.35;
                        if (beat)
                            plasmaT += 1.2;
                        if (fieldTick % 2 === 0 || beat)
                            drawPlasma(margins, plasmaT, features.zcr);
                    } else if (bg === "ripple") {
                        if (beat && rings.length < 4) {
                            rings.push({
                                cx: 1 + Math.floor(Math.random() * l.cols),
                                cy: l.artTop + Math.floor(Math.random() * (l.artBottom - l.artTop + 1)),
                                r: 0
                            });
                        }
                        for (var ri = rings.length - 1; ri >= 0; ri--) {
                            rings[ri].r += 0.8 + features.rms * 1.5;
                            if (rings[ri].r > l.cols)
                                rings.splice(ri, 1);
                        }
                        if (rings.length && (fieldTick % 2 === 0 || beat))
                            drawRipples(margins, rings, features.zcr);
                    }
                }

                if (mode !== "off" && borderPulse > 0) {
                    drawBoxFrame(l, borderPulse >= 2 ? "1;36" : "0;36");
                    drawTitleLine(l, track);
                    borderPulse--;
                    if (borderPulse === 0) {
                        drawBoxFrame(l, "0;34");
                        drawTitleLine(l, track);
                    }
                }

                var glowOn = mode === "glow" || mode === "glow+art";
                drawGlow(l, l.glowRow1, paused ? 0 : features.rms, features.zcr, glowOn);
                drawGlow(l, l.glowRow2, paused ? 0 : features.rms, features.zcr, glowOn);

                // Floating avatars: physics every tick, redraw when they move.
                if (sprites.length && !paused) {
                    stepSprites(sprites, l, features.rms, beat);
                    drawSprites(sprites, l, blit, false);
                }

                // Synced lyric line between the strips.
                if (lyrics.length) {
                    var li = lyricIndexFor(lyrics, playMs / 1000, lyricIdx);
                    if (li !== lyricIdx) {
                        lyricIdx = li;
                        drawLyric(l, li >= 0 ? lyrics[li].text : "");
                    }
                }

                drawProgress(l, clamp(playMs / 1000, 0, totalSec), totalSec, paused, volumePct);
                console.write(gotoRC(l.rows, l.cols) + CLR);
            }
        }

        apc("A;Flush;C=" + CHANNEL + ";O=250");
        return result;
    }

    // ---- self test (jsexec, headless) ----------------------------------------
    export function selfTest(): void {
        // WAV round trip.
        var pcm = "";
        for (var i = 0; i < 2000; i++) {
            var v = Math.round(Math.sin(i / 8) * 12000);
            if (v < 0) v += 0x10000;
            pcm += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
            pcm += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
        }
        var wav = wavHeader(pcm.length, 22050, 2) + pcm;
        var info = parseWavHeader(wav.substr(0, 256), wav.length);
        if (!info) throw new Error("parseWavHeader failed");
        if (info.rate !== 22050 || info.channels !== 2)
            throw new Error("rate/channels mismatch: " + info.rate + "/" + info.channels);
        if (info.dataOffset !== 44 || info.dataBytes !== pcm.length)
            throw new Error("data chunk mismatch: " + info.dataOffset + "/" + info.dataBytes);

        // A WAV whose data chunk sits past 512 bytes (ffmpeg LIST INFO tags)
        // must still parse via the progressive reader's growth path.
        var fat = "RIFF" + le32(4 + 8 + 8 + 700 + 8 + pcm.length) + "WAVE" +
            "fmt " + le32(16) + le16(1) + le16(2) + le32(22050) +
            le32(22050 * 4) + le16(4) + le16(16) +
            "LIST" + le32(700) + repeatByte("x", 700) +
            "data" + le32(pcm.length) + pcm;
        var fatInfo = parseWavHeader(fat.substr(0, 512), fat.length);
        if (fatInfo !== null) throw new Error("512-byte read should NOT see data yet");
        fatInfo = parseWavHeader(fat.substr(0, 2048), fat.length);
        if (!fatInfo) throw new Error("fat header did not parse");
        if (fatInfo.dataOffset !== 12 + 24 + 8 + 700 + 8)
            throw new Error("fat data offset wrong: " + fatInfo.dataOffset);
        if (fatInfo.dataBytes !== pcm.length)
            throw new Error("fat data bytes wrong");

        // Feature extraction: a loud sine has high RMS and some crossings;
        // silence has neither.
        var loud = chunkFeatures(pcm, 2);
        if (!(loud.rms > 0.4)) throw new Error("sine rms too low: " + loud.rms);
        if (!(loud.zcr > 0)) throw new Error("sine zcr zero");
        var quiet = chunkFeatures(repeatByte("\x00", 4000), 2);
        if (quiet.rms !== 0 || quiet.raw !== 0) throw new Error("silence rms nonzero");
        if (!(loud.raw > 0.15)) throw new Error("sine raw rms too low: " + loud.raw);

        // ANSI grid: SAUCE strip, wrap-at-width, SGR attrs, cursor-forward.
        var sauced = "hello" + "\x1a" + repeatByte("\x00", 100) +
            "SAUCE00" + repeatByte("z", 121);
        if (FLAnsiGrid.stripSauce(sauced) !== "hello")
            throw new Error("SAUCE strip failed");
        var artSrc = "\x1b[1;31mAB\x1b[44m\x1b[3CC\r\nD";
        var g = FLAnsiGrid.render(artSrc, 4);
        if (g.height < 2) throw new Error("grid height: " + g.height);
        if ((g.rows[0][0] & 0xff) !== 65 || (g.rows[0][1] & 0xff) !== 66)
            throw new Error("grid chars wrong");
        var attrA = g.rows[0][0] >> 8;
        if ((attrA & 0x0f) !== (0x08 | 4)) // bright red (CGA red=4)
            throw new Error("grid attr wrong: " + attrA);
        var attrC = g.rows[0][3] >> 8;
        if (((attrC >> 4) & 0x07) !== 1)   // blue bg (CGA blue=1)
            throw new Error("grid bg wrong: " + attrC);
        if ((g.rows[1][0] & 0xff) !== 68)  // 'D' after CRLF
            throw new Error("grid newline wrong");
        // Wrap: 5 chars at width 4 flow onto row 1.
        var g2 = FLAnsiGrid.render("ABCDE", 4);
        if ((g2.rows[1][0] & 0xff) !== 69) throw new Error("wrap failed");
        // Emit: positions + chars + hue rotation changes output.
        var em0 = FLAnsiGrid.emit(g2, 5, 3, 0, 1, 0, 4, 0);
        if (em0.indexOf("\x1b[3;5H") !== 0) throw new Error("emit origin wrong");
        if (em0.indexOf("ABCD") < 0) throw new Error("emit chars wrong");
        var emRot = FLAnsiGrid.emit(g, 1, 1, 0, 1, 0, 4, 1);
        var emPlain = FLAnsiGrid.emit(g, 1, 1, 0, 1, 0, 4, 0);
        if (emRot === emPlain) throw new Error("hue rotation is a no-op");
        // BIN avatar decode: 10x6 cells, char+attr pairs.
        var bin = "";
        for (var bi = 0; bi < 60; bi++)
            bin += String.fromCharCode(65 + (bi % 26)) + String.fromCharCode(0x1f);
        var av = FLAnsiGrid.renderBin(bin, 10, 6);
        if (!av || av.height !== 6 || (av.rows[0][0] & 0xff) !== 65)
            throw new Error("renderBin failed");

        // Lyrics: timed lookup walks forward and resets after a back-seek;
        // distribution spaces untimed lines evenly.
        var ly = [{ time: 5, text: "one" }, { time: 10, text: "two" }, { time: 20, text: "three" }];
        if (lyricIndexFor(ly, 3, -1) !== -1) throw new Error("lyric before-first wrong");
        if (lyricIndexFor(ly, 12, 0) !== 1) throw new Error("lyric walk wrong");
        if (lyricIndexFor(ly, 6, 2) !== 0) throw new Error("lyric back-seek wrong");
        var dist = distributeLyrics("a\n\nb\nc", 40);
        if (dist.length !== 3 || Math.abs(dist[0].time - 10) > 0.01)
            throw new Error("lyric distribution wrong");

        // Base64 sanity over binary bytes.
        var rt = base64_decode(base64_encode(wav.substr(0, 200)));
        if (rt !== wav.substr(0, 200)) throw new Error("base64 round trip failed");

        // Reply parser: feature reply, drain notify, arrows, keys, lone ESC.
        var p = new InputPump();
        var res: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [] };
        (p as any).buf = "\x1b[=7;100;1nq\x1b[C\x1b[=7;2;0n\x1b";
        (p as any).drain(res, true);
        if (res.audio.length !== 2) throw new Error("audio events: " + res.audio.length);
        if (res.audio[0][0] !== 100 || res.audio[0][1] !== 1) throw new Error("feature reply parse");
        if (res.audio[1][0] !== 2 || res.audio[1][1] !== 0) throw new Error("drain notify parse");
        if (res.keys.length !== 1 || res.keys[0] !== "Q") throw new Error("key parse");
        if (res.arrows.length !== 1 || res.arrows[0] !== "right") throw new Error("arrow parse");
        if (!res.esc) throw new Error("lone ESC parse");
        var p3 = new InputPump();
        var r3: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [] };
        (p3 as any).buf = "\x1b[74;162R";
        (p3 as any).drain(r3, true);
        if (r3.cpr.length !== 1 || r3.cpr[0][0] !== 74 || r3.cpr[0][1] !== 162)
            throw new Error("CPR parse failed");

        // Every palette map must be a permutation of 0..7 (no color loss).
        for (var pi = 0; pi < FLAnsiGrid.PALETTES.length; pi++) {
            var seenIdx: { [k: number]: boolean } = {};
            for (var pj = 0; pj < 8; pj++)
                seenIdx[FLAnsiGrid.PALETTES[pi][pj]] = true;
            for (var pk = 0; pk < 8; pk++)
                if (!seenIdx[pk]) throw new Error("palette " + pi + " not a permutation");
        }

        // Split CSI across feeds must not produce phantom keys.
        var p2 = new InputPump();
        var r2: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [] };
        (p2 as any).buf = "\x1b[=7;2";
        (p2 as any).drain(r2, false);
        if (r2.keys.length || r2.audio.length || r2.esc) throw new Error("partial CSI leaked");
        (p2 as any).buf += ";0n";
        (p2 as any).drain(r2, true);
        if (r2.audio.length !== 1) throw new Error("resumed CSI lost");

        // Margin rects: bottom flanks exist beside the box and never cover
        // the box span itself.
        var fakeL: Layout = {
            cols: 120, rows: 40, boxTop: 36, boxLeft: 23, boxWidth: 76,
            glowRow1: 33, lyricRow: 34, glowRow2: 35, artTop: 1, artBottom: 32
        };
        var fakeBlit: ArtBlit = {
            grid: { width: 80, height: 30, rows: [] }, left: 21, top: 2,
            srcRow: 0, srcCol: 0, nRows: 30, nCols: 80, pal: 0
        };
        var mrs = marginRects(fakeL, fakeBlit);
        var flankL = false;
        var flankR = false;
        for (var mi = 0; mi < mrs.length; mi++) {
            var mr = mrs[mi];
            if (mr.y === 33 && mr.x === 1 && mr.x + mr.w - 1 === 22)
                flankL = true;
            if (mr.y === 33 && mr.x === 99 && mr.x + mr.w - 1 === 120)
                flankR = true;
            if (mr.y >= fakeL.glowRow1 &&
                mr.x <= fakeL.boxLeft + fakeL.boxWidth - 1 &&
                mr.x + mr.w - 1 >= fakeL.boxLeft)
                throw new Error("bottom flank overlaps the box span");
        }
        if (!flankL || !flankR) throw new Error("bottom flanks missing");

        writeln("FLPlayer self-test: OK");

        // Optional end-to-end leg: --selftest <mp3path> exercises the real
        // ffmpeg transcode + header parse + slicing on an actual track.
        var mp3 = "";
        if (typeof argv !== "undefined" && argv) {
            for (var ai = 0; ai < argv.length; ai++) {
                if (argv[ai] !== "--selftest" && file_exists(argv[ai]))
                    mp3 = argv[ai];
            }
        }
        if (mp3.length) {
            if (!ffmpegAvailable()) throw new Error("ffmpeg not available");
            var t: PlayableTrack = {
                path: mp3,
                name: "selftest.mp3",
                size: file_size(mp3),
                mtime: file_date(mp3),
                title: "Self Test",
                artist: "",
                ansiArt: ""
            };
            var wp = ensureTranscoded(t);
            if (wp === null) throw new Error("transcode failed");
            var tf = new File(wp);
            if (!tf.open("rb")) throw new Error("cache open failed");
            var inf = readWavInfo(tf);
            if (!inf) { tf.close(); throw new Error("ffmpeg WAV did not parse"); }
            var bps = inf.rate * inf.channels * 2;
            var chunkB = Math.floor(bps * CHUNK_MS / 1000);
            chunkB -= chunkB % (inf.channels * 2);
            // Slice a mid-song chunk and make sure it yields features + b64.
            var midChunk = Math.floor((inf.dataBytes / chunkB) / 2);
            tf.position = inf.dataOffset + midChunk * chunkB;
            var slice = tf.read(chunkB);
            tf.close();
            if (!slice || slice.length !== chunkB) throw new Error("slice read failed");
            var feats = chunkFeatures(slice, inf.channels);
            var b64len = base64_encode(wavHeader(slice.length, inf.rate, inf.channels) + slice).length;
            writeln(format("FLPlayer transcode test: OK  rate=%d ch=%d duration=%ds chunks=%d chunkB64=%d rms=%s zcr=%s",
                inf.rate, inf.channels, Math.round(inf.dataBytes / bps),
                Math.ceil(inf.dataBytes / chunkB), b64len,
                feats.rms.toFixed(2), feats.zcr.toFixed(2)));
        }
    }
}

declare function writeln(text: string): void;
