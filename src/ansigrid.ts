/*
 * FLAnsiGrid — interpret CP437 ANSI art into a cell grid, then blit
 * arbitrary windows of it anywhere on screen.
 *
 * Classic .ans art has no newlines: it relies on the terminal wrapping at
 * column 80. Dumping it raw onto a wider terminal skews every row (and a
 * trailing SAUCE metadata record prints as garbage). Interpreting into a
 * grid fixes both, and gives us free extras: center/trim to any terminal
 * size, palette rotation for the beat visualizer without re-parsing, and
 * the same cell/attr model for 10x6 BIN avatars.
 *
 * Cell attr byte = CGA convention: fg 0-7 | bright 0x08 | bg<<4 | blink 0x80.
 */

namespace FLAnsiGrid {

    export interface Grid {
        width: number;
        height: number;
        // rows[y][x] = (attr << 8) | charcode, packed to keep ES5 arrays cheap
        rows: number[][];
    }

    var DEFAULT_ATTR = 0x07;
    var MAX_ROWS = 200;

    // CGA color index -> ANSI SGR foreground code (bg = +10).
    var CGA_TO_SGR = [30, 34, 32, 36, 31, 35, 33, 37];
    // SGR 30-37 parameter -> CGA index.
    var SGR_TO_CGA = [0, 4, 2, 6, 1, 5, 3, 7];
    // Palette maps: permutations of the CGA indices. Structure-preserving
    // (multicolor art stays multicolor — unlike a single-color strobe), with
    // black/white anchored so silhouettes and highlights survive the swap.
    export var PALETTES: number[][] = [
        [0, 1, 2, 3, 4, 5, 6, 7],   // 0 identity (the real art)
        [0, 5, 3, 1, 6, 4, 2, 7],   // 1 hue rotate
        [0, 4, 1, 5, 2, 6, 3, 7],   // 2 hue rotate, second step
        [0, 6, 5, 4, 3, 2, 1, 7],   // 3 complement (cool<->warm)
        [0, 3, 6, 2, 5, 1, 4, 7],   // 4 scramble (high contrast)
        // Colorizers: these MOVE the grays (7, and 8 even black), so
        // grayscale-heavy art gets washed in color instead of sitting still.
        [0, 1, 2, 3, 4, 5, 7, 6],   // 5 amber: white <-> brown (bright = gold)
        [0, 1, 2, 7, 4, 5, 6, 3],   // 6 ice: white <-> cyan
        [0, 1, 2, 3, 4, 7, 6, 5],   // 7 neon: white <-> magenta
        [7, 1, 2, 3, 4, 5, 6, 0],   // 8 negative: black <-> white flash
        // Black-movers: the void itself takes color, flooding the canvas.
        [1, 0, 2, 3, 4, 5, 6, 7],   // 9 midnight: black <-> blue
        [1, 0, 2, 7, 4, 5, 6, 3],   // 10 abyss duotone: black<->blue, white<->cyan
        [4, 1, 2, 3, 0, 5, 6, 7]    // 11 ember: black <-> red
    ];

    /** Remove a trailing SAUCE record (and the EOF marker it follows). */
    export function stripSauce(art: string): string {
        if (art.length >= 128 && art.substr(art.length - 128, 7) === "SAUCE00") {
            var eof = art.lastIndexOf("\x1a");
            return eof >= 0 ? art.substr(0, eof) : art.substr(0, art.length - 128);
        }
        var bare = art.indexOf("\x1a");
        return bare >= 0 ? art.substr(0, bare) : art;
    }

    function blankRow(width: number): number[] {
        var row: number[] = [];
        for (var i = 0; i < width; i++)
            row.push((DEFAULT_ATTR << 8) | 0x20);
        return row;
    }

    /** Interpret ANSI/CP437 bytes into a grid, wrapping at `width`. */
    export function render(art: string, width: number): Grid {
        var grid: Grid = { width: width, height: 0, rows: [] };
        var x = 0;
        var y = 0;
        var attr = DEFAULT_ATTR;
        var savedX = 0;
        var savedY = 0;

        function row(yy: number): number[] {
            while (grid.rows.length <= yy)
                grid.rows.push(blankRow(width));
            if (yy + 1 > grid.height)
                grid.height = yy + 1;
            return grid.rows[yy];
        }

        function put(ch: number): void {
            // Lazy wrap (last-column-flag semantics): a char written in the
            // final column leaves the cursor "hanging" and only wraps when
            // the NEXT printable arrives. Eager wrapping would double-space
            // art whose rows end exactly at the wrap column before a CRLF.
            if (x >= width) {
                x = 0;
                y++;
            }
            if (y >= MAX_ROWS)
                return;
            row(y)[x] = (attr << 8) | ch;
            x++;
        }

        function sgr(params: string): void {
            var parts = params.length ? params.split(";") : ["0"];
            for (var i = 0; i < parts.length; i++) {
                var n = parts[i].length ? parseInt(parts[i], 10) : 0;
                if (isNaN(n)) continue;
                if (n === 0) attr = DEFAULT_ATTR;
                else if (n === 1) attr |= 0x08;
                else if (n === 2 || n === 22) attr &= ~0x08;
                else if (n === 5 || n === 6) attr |= 0x80;
                else if (n === 25) attr &= ~0x80;
                else if (n === 7) attr = ((attr & 0x07) << 4) | ((attr >> 4) & 0x07) | (attr & 0x88);
                else if (n >= 30 && n <= 37) attr = (attr & 0xf8) | SGR_TO_CGA[n - 30];
                else if (n === 39) attr = (attr & 0xf8) | 0x07;
                else if (n >= 40 && n <= 47) attr = (attr & 0x8f) | (SGR_TO_CGA[n - 40] << 4);
                else if (n === 49) attr = attr & 0x8f;
            }
        }

        var i = 0;
        var n = art.length;
        while (i < n && y < MAX_ROWS) {
            var c = art.charCodeAt(i) & 0xff;
            if (c === 0x1b && i + 1 < n && art.charAt(i + 1) === "[") {
                var j = i + 2;
                var body = "";
                while (j < n) {
                    var cc = art.charAt(j);
                    if (cc >= "@" && cc <= "~")
                        break;
                    body += cc;
                    j++;
                }
                var fin = j < n ? art.charAt(j) : "";
                i = j + 1;
                var p1 = parseInt(body, 10);
                if (isNaN(p1)) p1 = 1;
                if (fin === "m") sgr(body);
                else if (fin === "C") x = Math.min(width - 1, x + Math.max(1, p1));
                else if (fin === "D") x = Math.max(0, x - Math.max(1, p1));
                else if (fin === "A") y = Math.max(0, y - Math.max(1, p1));
                else if (fin === "B") y = Math.min(MAX_ROWS - 1, y + Math.max(1, p1));
                else if (fin === "G") x = Math.max(0, Math.min(width - 1, p1 - 1));
                else if (fin === "H" || fin === "f") {
                    var seg = body.split(";");
                    var rr = parseInt(seg[0], 10);
                    var ccol = parseInt(seg[1], 10);
                    y = Math.max(0, (isNaN(rr) ? 1 : rr) - 1);
                    x = Math.max(0, Math.min(width - 1, (isNaN(ccol) ? 1 : ccol) - 1));
                } else if (fin === "J") {
                    if (body === "2") {
                        grid.rows = [];
                        grid.height = 0;
                        x = 0;
                        y = 0;
                    }
                } else if (fin === "K") {
                    var r = row(y);
                    for (var k = x; k < width; k++)
                        r[k] = (attr << 8) | 0x20;
                } else if (fin === "s") { savedX = x; savedY = y; }
                else if (fin === "u") { x = savedX; y = savedY; }
                // anything else: ignored
                continue;
            }
            i++;
            if (c === 0x0d) { x = 0; continue; }
            if (c === 0x0a) { x = 0; y++; continue; }
            if (c === 0x1a) break;                       // EOF marker
            if (c === 0x09) {                            // tab -> next 8-col stop
                x = Math.min(width - 1, (Math.floor(x / 8) + 1) * 8);
                continue;
            }
            if (c === 0x0c) {                            // FF -> clear
                grid.rows = [];
                grid.height = 0;
                x = 0;
                y = 0;
                continue;
            }
            put(c);
        }
        return grid;
    }

    // Horizontal mirror glyph pairs: directional CP437 characters that must
    // swap when art is flipped across the vertical axis (half-blocks matter
    // most for avatar art; slashes/brackets/box corners for the rest).
    var MIRROR_PAIRS: number[][] = [
        [0x2f, 0x5c],  // / \
        [0x28, 0x29],  // ( )
        [0x5b, 0x5d],  // [ ]
        [0x7b, 0x7d],  // { }
        [0x3c, 0x3e],  // < >
        [0x62, 0x64],  // b d
        [0x70, 0x71],  // p q
        [0x11, 0x10],  // left/right triangles
        [0xae, 0xaf],  // << >>
        [0xdd, 0xde],  // left/right half blocks
        [0xda, 0xbf],  // single box corners (top)
        [0xc0, 0xd9],  // single box corners (bottom)
        [0xc3, 0xb4],  // single box tees
        [0xc9, 0xbb],  // double box corners (top)
        [0xc8, 0xbc],  // double box corners (bottom)
        [0xcc, 0xb9],  // double box tees
        [0xd5, 0xb8], [0xd4, 0xbe], [0xd6, 0xb7], [0xd3, 0xbd],
        [0xc6, 0xb5], [0xc7, 0xb6]
    ];
    var MIRROR_MAP: { [code: number]: number } = {};
    for (var mpi = 0; mpi < MIRROR_PAIRS.length; mpi++) {
        MIRROR_MAP[MIRROR_PAIRS[mpi][0]] = MIRROR_PAIRS[mpi][1];
        MIRROR_MAP[MIRROR_PAIRS[mpi][1]] = MIRROR_PAIRS[mpi][0];
    }

    /** Flip a grid across the vertical axis (cells reversed per row, and
     *  directional glyphs swapped for their mirror twins). */
    export function mirror(grid: Grid): Grid {
        var out: Grid = { width: grid.width, height: grid.height, rows: [] };
        for (var y = 0; y < grid.rows.length; y++) {
            var row = grid.rows[y];
            var rev: number[] = [];
            for (var x = row.length - 1; x >= 0; x--) {
                var cell = row[x];
                var ch = cell & 0xff;
                var mapped = MIRROR_MAP[ch];
                rev.push(mapped ? ((cell & 0xff00) | mapped) : cell);
            }
            out.rows.push(rev);
        }
        return out;
    }

    /** Decode a 10x6 BIN avatar (char+attr pairs) into a grid. */
    export function renderBin(data: string, width: number, height: number): Grid | null {
        if (data.length < width * height * 2)
            return null;
        var grid: Grid = { width: width, height: height, rows: [] };
        var p = 0;
        for (var y = 0; y < height; y++) {
            var row: number[] = [];
            for (var x = 0; x < width; x++) {
                var ch = data.charCodeAt(p++) & 0xff;
                var at = data.charCodeAt(p++) & 0xff;
                row.push((at << 8) | (ch === 0 ? 0x20 : ch));
            }
            grid.rows.push(row);
        }
        return grid;
    }

    export function attrToSgr(attr: number, palIdx: number): string {
        var pal = PALETTES[palIdx >= 0 && palIdx < PALETTES.length ? palIdx : 0];
        var fg = pal[attr & 0x07];
        var bg = pal[(attr >> 4) & 0x07];
        var out = "0";
        if (attr & 0x08) out += ";1";
        if (attr & 0x80) out += ";5";
        out += ";" + CGA_TO_SGR[fg] + ";" + (CGA_TO_SGR[bg] + 10);
        return out;
    }

    // Full 16-colour rotation with BLACK pinned. The PALETTES model only
    // permutes the 3-bit BASE colour (so DARKGRAY = base-0 + bright shares a
    // slot with BLACK and can't move independently, and LIGHTGRAY/WHITE stay
    // put in most maps). This rotates all 15 non-black foreground colours (and
    // the 7 non-black backgrounds) by `rot`, so grayscale strobes through
    // colour on a beat while BLACK stays black.
    function rotFg(full: number, rot: number): number {
        return full === 0 ? 0 : (((full - 1 + rot) % 15) + 15) % 15 + 1;
    }
    function rotBg(base: number, rot: number): number {
        return base === 0 ? 0 : (((base - 1 + rot) % 7) + 7) % 7 + 1;
    }
    function flashSgr(attr: number, rot: number): string {
        var fgFull = (attr & 0x07) | ((attr & 0x08) ? 8 : 0);
        var nfg = rotFg(fgFull, rot);
        var nbg = rotBg((attr >> 4) & 0x07, rot);
        var out = "0";
        if (nfg & 0x08) out += ";1";
        if (attr & 0x80) out += ";5";
        out += ";" + CGA_TO_SGR[nfg & 0x07] + ";" + (CGA_TO_SGR[nbg] + 10);
        return out;
    }

    /** emit(), but colours are rotated by `rot` (BLACK pinned) -- the grayscale-
     *  inclusive palette strobe used for avatar flashes. */
    export function emitFlash(grid: Grid, left: number, top: number,
        srcRow: number, nRows: number, srcCol: number, nCols: number,
        rot: number): string {
        var out = "";
        var lastSgr = "";
        for (var r = 0; r < nRows; r++) {
            var gy = srcRow + r;
            if (gy < 0 || gy >= grid.rows.length)
                continue;
            var row = grid.rows[gy];
            out += "\x1b[" + (top + r) + ";" + left + "H";
            for (var cIdx = 0; cIdx < nCols; cIdx++) {
                var gx = srcCol + cIdx;
                var cell = gx >= 0 && gx < row.length ? row[gx] : ((DEFAULT_ATTR << 8) | 0x20);
                var code = flashSgr(cell >> 8, rot);
                if (code !== lastSgr) {
                    out += "\x1b[" + code + "m";
                    lastSgr = code;
                }
                out += String.fromCharCode(cell & 0xff);
            }
        }
        return out + "\x1b[0m";
    }

    /** emit(), but the palette index is chosen PER CELL by palFor(screenX,
     *  screenY) -- lets a caller sweep one palette in over another (a spatial
     *  "fill" transition) instead of recolouring the whole art at once. */
    export function emitWipe(grid: Grid, left: number, top: number,
        srcRow: number, nRows: number, srcCol: number, nCols: number,
        palFor: (screenX: number, screenY: number) => number): string {
        var out = "";
        var lastSgr = "";
        for (var r = 0; r < nRows; r++) {
            var gy = srcRow + r;
            if (gy < 0 || gy >= grid.rows.length)
                continue;
            var row = grid.rows[gy];
            var sy = top + r;
            out += "\x1b[" + sy + ";" + left + "H";
            for (var cIdx = 0; cIdx < nCols; cIdx++) {
                var gx = srcCol + cIdx;
                var cell = gx >= 0 && gx < row.length ? row[gx] : ((DEFAULT_ATTR << 8) | 0x20);
                var code = attrToSgr(cell >> 8, palFor(left + cIdx, sy));
                if (code !== lastSgr) {
                    out += "\x1b[" + code + "m";
                    lastSgr = code;
                }
                out += String.fromCharCode(cell & 0xff);
            }
        }
        return out + "\x1b[0m";
    }

    /**
     * Blit a window of the grid to the screen: source rows [srcRow, srcRow+nRows)
     * and cols [srcCol, srcCol+nCols) drawn with the top-left at screen
     * (top,left) (1-based). Emits minimal SGR runs; palIdx remaps colors.
     */
    export function emit(grid: Grid, left: number, top: number,
        srcRow: number, nRows: number, srcCol: number, nCols: number,
        palIdx: number): string {
        var out = "";
        var lastSgr = "";
        for (var r = 0; r < nRows; r++) {
            var gy = srcRow + r;
            if (gy < 0 || gy >= grid.rows.length)
                continue;
            var row = grid.rows[gy];
            out += "\x1b[" + (top + r) + ";" + left + "H";
            for (var cIdx = 0; cIdx < nCols; cIdx++) {
                var gx = srcCol + cIdx;
                var cell = gx >= 0 && gx < row.length ? row[gx] : ((DEFAULT_ATTR << 8) | 0x20);
                var code = attrToSgr(cell >> 8, palIdx);
                if (code !== lastSgr) {
                    out += "\x1b[" + code + "m";
                    lastSgr = code;
                }
                out += String.fromCharCode(cell & 0xff);
            }
        }
        return out + "\x1b[0m";
    }
}
