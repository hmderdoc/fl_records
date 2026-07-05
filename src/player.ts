/*
 * FLPlayer — in-terminal MP3 playback for Futureland Records over the
 * SyncTERM APC audio protocol (APC SyncTERM:... ST), with album-art
 * backdrop, a counting-up progress overlay, and an audio-reactive
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

    // ---- shared state ---------------------------------------------------
    export type SinkKind = "syncterm" | "apc" | "none";
    var detectedSink: SinkKind | null = null;   // per-session cache

    export interface PlayableTrack {
        path: string;       // mp3 on disk
        name: string;       // filename (cache key component)
        title: string;
        artist: string;
        size: number;
        mtime: number;
        ansiArt: string;    // raw CP437 .ans bytes ("" when absent)
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
    // We always transcode to canonical PCM (pcm_s16le), so a fixed-layout
    // header writer/parser is sufficient; parse still walks RIFF chunks in
    // case ffmpeg adds a LIST before data.

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
            ":" + PCM_RATE + "x" + PCM_CHANNELS, true);
        var out = pcmDir() + "/" + key + ".wav";
        if (file_exists(out) && file_size(out) > 44)
            return out;
        if (!mkpath(pcmDir()))
            return null;
        var cmd = "ffmpeg -v quiet -y -i " + shellQuote(track.path) +
            " -ar " + PCM_RATE + " -ac " + PCM_CHANNELS +
            " -c:a pcm_s16le -f wav " + shellQuote(out) + " </dev/null";
        system.exec(cmd);
        if (file_exists(out) && file_size(out) > 44)
            return out;
        return null;
    }

    // ---- terminal input: keys + CSI audio notifications -------------------
    // A tiny decoder over console.inkey(): buffers ESC sequences whole, hands
    // back plain keys and decoded events. CSI = 7 ; a ; b n pairs become
    // audio events; arrows become "left"/"right"/"up"/"down"; a lone ESC (no
    // continuation within the poll) is the Esc key.

    export interface PumpResult {
        keys: string[];       // plain keys, uppercased ("Q", " ", "\r"...)
        arrows: string[];     // "up" | "down" | "left" | "right"
        esc: boolean;         // lone ESC key
        audio: number[][];    // [id, state] pairs from CSI =7;...n reports
    }

    export class InputPump {
        private buf: string = "";

        /** Poll for up to maxMs, decoding everything that arrives. */
        pump(maxMs: number): PumpResult {
            var res: PumpResult = { keys: [], arrows: [], esc: false, audio: [] };
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
    // Stride-sampled from the slice we already hold for base64 encoding:
    // ~256 sample points per chunk give a stable RMS (loudness) and zero
    // crossing rate (brightness proxy) without measurable CPU cost.
    export function chunkFeatures(slice: string, channels: number): { rms: number; zcr: number } {
        var frames = Math.floor(slice.length / (channels * 2));
        if (frames < 2)
            return { rms: 0, zcr: 0 };
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
            return { rms: 0, zcr: 0 };
        var rms = Math.sqrt(sumSq / count) / 32768;
        // Perceptual-ish lift: quiet music still moves the meter.
        rms = Math.sqrt(clamp(rms * 3.2, 0, 1));
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
        return { rms: rms, zcr: zcr };
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
        boxTop: number;    // first row of the overlay box
        boxLeft: number;
        boxWidth: number;
        glowRow: number;   // visualizer strip, directly above the box
    }

    function layout(): Layout {
        var cols = Math.max(40, console.screen_columns || 80);
        var rows = Math.max(12, console.screen_rows || 24);
        var width = Math.min(cols - 2, 76);
        return {
            cols: cols,
            rows: rows,
            boxTop: rows - 4,
            boxLeft: Math.max(1, Math.floor((cols - width) / 2) + 1),
            boxWidth: width,
            glowRow: rows - 5
        };
    }

    function drawBackdrop(track: PlayableTrack, l: Layout): void {
        console.write(CLR + "\x1b[2J\x1b[H");
        if (track.ansiArt.length) {
            console.write(track.ansiArt);
            console.write(CLR);
        } else {
            // No embedded art: a dim generated backdrop so the box isn't lonely.
            var mid = Math.max(2, Math.floor(l.rows / 2) - 3);
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
        var hints = "[Space]Pause  [\x1b/\x1a]Seek  [\x18/\x19]Vol  [N]ext [P]rev  [V]iz  [Q]uit";
        if (hints.length > l.boxWidth)
            hints = "[Spc]Pause [N/P]Trk [Q]uit";
        var col = Math.max(1, l.boxLeft + Math.floor((l.boxWidth - hints.length) / 2));
        console.write(gotoRC(Math.min(l.rows, l.boxTop + 4), col) + sgr("0;30;1") + hints + CLR);
    }

    // Audio-reactive glow strip: a mirrored bar of shade blocks whose reach
    // follows loudness and whose color follows brightness (ZCR): bass-heavy
    // reads red/magenta, bright reads cyan/white. Border pulses on beats.
    var VIS_MODES = ["glow", "glow+art", "border", "off"];

    function drawGlow(l: Layout, rms: number, zcr: number, mode: string): void {
        if (mode === "off") {
            console.write(gotoRC(l.glowRow, l.boxLeft) + repeatByte(" ", l.boxWidth));
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
        console.write(gotoRC(l.glowRow, l.boxLeft) + sgr(color) + strip.substr(0, l.boxWidth) + CLR);
    }

    // ---- art color-pulse variants -----------------------------------------
    // "Alpha color swap": rotate the chromatic SGR colors of the .ans art
    // (30/37/38/39 and the grays stay put so structure survives), giving 2-3
    // palette-shifted variants we can flash on beats. Built once per track.
    var HUE_ROT: { [code: string]: string } = {
        "31": "33", "33": "32", "32": "36", "36": "34", "34": "35", "35": "31",
        "41": "43", "43": "42", "42": "46", "46": "44", "44": "45", "45": "41"
    };

    function rotateSgr(art: string): string {
        return art.replace(/\x1b\[([0-9;]*)m/g, function (whole: string, body: string): string {
            var parts = body.split(";");
            for (var i = 0; i < parts.length; i++) {
                var mapped = HUE_ROT[parts[i]];
                if (mapped)
                    parts[i] = mapped;
            }
            return "\x1b[" + parts.join(";") + "m";
        });
    }

    export function buildArtVariants(art: string): string[] {
        if (!art.length)
            return [];
        var v1 = rotateSgr(art);
        var v2 = rotateSgr(v1);
        return [art, v1, v2];
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
            var head = f.read(512);
            var info = parseWavHeader(head, f.length);
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

        var l = layout();
        var pump = new InputPump();
        var visMode = 0;
        var volumePct = 80;
        var borderPulse = 0;          // decaying beat flash
        var lastRms = 0;
        var artVariants = buildArtVariants(track.ansiArt);
        var artFlashIdx = 0;
        var lastArtFlashAt = 0;

        drawBackdrop(track, l);
        drawBoxFrame(l, "0;34");
        drawTitleLine(l, track);
        drawHints(l);

        apc("A;Volume;C=" + CHANNEL + ";V=" + volumePct);
        apc("A;Update;C=" + CHANNEL);

        var chunk = 0;                 // next chunk to emit
        var t0 = nowMs();              // wall-clock anchor: chunk i plays at t0 + i*CHUNK_MS
        var paused = false;
        var lastUiAt = 0;
        var result: PlayResult = "ended";
        var features: { rms: number; zcr: number } = { rms: 0, zcr: 0 };
        var featForChunk: { rms: number; zcr: number }[] = [];

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
            apc("A;Flush;C=" + CHANNEL);
            apc("A;Update;C=" + CHANNEL);
        }

        while (bbs.online && !js.terminated) {
            var now = nowMs();
            var playMs = now - t0;
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
            for (var i = 0; i < ev.keys.length; i++) {
                var k = ev.keys[i];
                if (k === "Q")
                    quitReq = true;
                else if (k === " ") {
                    if (!paused) {
                        paused = true;
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
                    drawGlow(l, 0, 0, "off");
                    if (artVariants.length && artFlashIdx !== 0) {
                        artFlashIdx = 0;
                        console.write(CLR + "\x1b[H" + artVariants[0] + CLR);
                        drawBoxFrame(l, "0;34");
                        drawTitleLine(l, track);
                        drawHints(l);
                    }
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
                    } else {
                        // Underrun: the cushion ran dry (slow link / stall).
                        // Re-anchor and re-prime, exactly like lameboy does.
                        rePrime(playChunk);
                    }
                }
            }
            if (quitReq)
                break;

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
                var beat = !paused && features.rms > lastRms + 0.22;
                if (beat)
                    borderPulse = 3;    // beat: flash the border
                lastRms = features.rms;
                // Art color-pulse: on beats, redraw the art with a rotated
                // palette (rate-capped so slow links keep breathing room).
                if (mode === "glow+art" && beat && artVariants.length > 1 &&
                    now - lastArtFlashAt > 450) {
                    lastArtFlashAt = now;
                    artFlashIdx = (artFlashIdx + 1) % artVariants.length;
                    console.write(CLR + "\x1b[H" + artVariants[artFlashIdx] + CLR);
                    drawBoxFrame(l, "0;34");
                    drawTitleLine(l, track);
                    drawHints(l);
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
                drawGlow(l, paused ? 0 : features.rms, features.zcr,
                    (mode === "glow" || mode === "glow+art") ? "glow" : "off");
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

        // Feature extraction: a loud sine has high RMS and some crossings;
        // silence has neither.
        var loud = chunkFeatures(pcm, 2);
        if (!(loud.rms > 0.4)) throw new Error("sine rms too low: " + loud.rms);
        if (!(loud.zcr > 0)) throw new Error("sine zcr zero");
        var quiet = chunkFeatures(repeatByte("\x00", 4000), 2);
        if (quiet.rms !== 0) throw new Error("silence rms nonzero");

        // Art hue rotation: chromatic codes rotate, structure survives.
        var art = "\x1b[1;31mRED\x1b[0;44;33mYB\x1b[37mW\x1b[m.";
        var vars2 = buildArtVariants(art);
        if (vars2.length !== 3) throw new Error("variant count");
        if (vars2[1] !== "\x1b[1;33mRED\x1b[0;45;32mYB\x1b[37mW\x1b[m.")
            throw new Error("hue rotation wrong: " + vars2[1].replace(/\x1b/g, "^["));
        if (vars2[1] === vars2[0] || vars2[2] === vars2[1] || vars2[2] === vars2[0])
            throw new Error("variants not distinct");

        // Base64 sanity over binary bytes.
        var rt = base64_decode(base64_encode(wav.substr(0, 200)));
        if (rt !== wav.substr(0, 200)) throw new Error("base64 round trip failed");

        // Reply parser: feature reply, drain notify, arrows, keys, lone ESC.
        var p = new InputPump();
        var res: PumpResult = { keys: [], arrows: [], esc: false, audio: [] };
        (p as any).buf = "\x1b[=7;100;1nq\x1b[C\x1b[=7;2;0n\x1b";
        (p as any).drain(res, true);
        if (res.audio.length !== 2) throw new Error("audio events: " + res.audio.length);
        if (res.audio[0][0] !== 100 || res.audio[0][1] !== 1) throw new Error("feature reply parse");
        if (res.audio[1][0] !== 2 || res.audio[1][1] !== 0) throw new Error("drain notify parse");
        if (res.keys.length !== 1 || res.keys[0] !== "Q") throw new Error("key parse");
        if (res.arrows.length !== 1 || res.arrows[0] !== "right") throw new Error("arrow parse");
        if (!res.esc) throw new Error("lone ESC parse");

        // Split CSI across feeds must not produce phantom keys.
        var p2 = new InputPump();
        var r2: PumpResult = { keys: [], arrows: [], esc: false, audio: [] };
        (p2 as any).buf = "\x1b[=7;2";
        (p2 as any).drain(r2, false);
        if (r2.keys.length || r2.audio.length || r2.esc) throw new Error("partial CSI leaked");
        (p2 as any).buf += ";0n";
        (p2 as any).drain(r2, true);
        if (r2.audio.length !== 1) throw new Error("resumed CSI lost");

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
            var inf = parseWavHeader(tf.read(512), tf.length);
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
