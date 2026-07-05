/*
 * uifc console shim — makes the uifc-based UI run in-process (`cmd=?fl_records.js`).
 *
 * The real `uifc` object only exists under jsexec; the terminal server's JS
 * runtime does not provide it. This file installs a console-backed
 * implementation of the subset this door uses (init/bail/msg/input/list/
 * showbuf/help_text + list.CTX) when — and only when — `uifc` is undefined,
 * so the door behaves identically under jsexec and in-process.
 *
 * Lives in src/ deliberately: the previous fix for this lived as hand edits
 * in the BUILT fl_records.js and was lost by a rebuild. Everything must be
 * in src/ so `tsc` output is always the whole program.
 */

namespace FLUifcShim {

    // Self-provide sbbsdefs constants (K_NONE/K_EDIT/K_LINE): load() scopes
    // to the caller, so the door IIFE's own load is invisible here. See the
    // matching note in player.ts.
    load("sbbsdefs.js");

    var ESC = "\x1b";

    function scrCols(): number {
        return Math.max(40, console.screen_columns || 80);
    }

    function scrRows(): number {
        return Math.max(10, console.screen_rows || 24);
    }

    function sgr(codes: string): string {
        return "\x1b[" + codes + "m";
    }

    function gotoRC(row: number, col: number): string {
        return "\x1b[" + row + ";" + col + "H";
    }

    function rep(ch: string, n: number): string {
        var out = "";
        while (out.length < n)
            out += ch;
        return out.substr(0, n);
    }

    function fit(text: string, width: number): string {
        var t = String(text === undefined || text === null ? "" : text);
        if (t.length > width)
            t = width > 3 ? t.substr(0, width - 3) + "..." : t.substr(0, width);
        return t + rep(" ", width - t.length);
    }

    // A centered double-line box; returns the interior origin/size.
    function drawBox(title: string, innerRows: number, innerCols: number):
        { top: number; left: number; rows: number; cols: number } {
        var cols = Math.min(innerCols + 4, scrCols() - 2);
        var inner = cols - 4;
        var rows = Math.min(innerRows, scrRows() - 4);
        var top = Math.max(1, Math.floor((scrRows() - (rows + 2)) / 2));
        var left = Math.max(1, Math.floor((scrCols() - cols) / 2) + 1);
        var t = " " + String(title || "") + " ";
        if (t.length > inner)
            t = t.substr(0, inner);
        var head = rep("\xCD", Math.floor((cols - 2 - t.length) / 2)) + t;
        head += rep("\xCD", cols - 2 - head.length);
        console.write(sgr("0;1;36") + gotoRC(top, left) + "\xC9" + head + "\xBB");
        for (var r = 0; r < rows; r++) {
            console.write(gotoRC(top + 1 + r, left) + "\xBA" +
                sgr("0") + rep(" ", cols - 2) + sgr("0;1;36") + "\xBA");
        }
        console.write(gotoRC(top + 1 + rows, left) + "\xC8" + rep("\xCD", cols - 2) + "\xBC" + sgr("0"));
        return { top: top + 1, left: left + 2, rows: rows, cols: inner };
    }

    function waitKey(): string {
        return String(console.getkey(K_NONE) || "");
    }

    // ---- the shim object ----------------------------------------------------
    function CTX(this: any): void {
        this.cur = 0;
        this.bar = 0;
        this.left = 0;
        this.top = 0;
        this.width = 0;
    }

    function shimList(mode: number, title: string, options: string[], ctx?: any): number {
        if (!options || !options.length)
            return -1;
        var widest = 10;
        for (var i = 0; i < options.length; i++)
            widest = Math.max(widest, String(options[i]).length);
        widest = Math.min(widest, scrCols() - 8);
        var visible = Math.min(options.length, scrRows() - 6);
        var cur = ctx && typeof ctx.cur === "number" ? ctx.cur : 0;
        cur = cur < 0 ? 0 : (cur >= options.length ? options.length - 1 : cur);
        var top = Math.max(0, Math.min(cur - Math.floor(visible / 2),
            options.length - visible));

        console.clear();
        var box = drawBox(title, visible, widest);
        var helpText = shim.help_text || "";
        if (helpText.length) {
            var hint = helpText.length > scrCols() - 4 ? helpText.substr(0, scrCols() - 4) : helpText;
            console.write(gotoRC(scrRows(), Math.max(1, Math.floor((scrCols() - hint.length) / 2))) +
                sgr("0;30;1") + hint + sgr("0"));
            shim.help_text = "";
        }

        function paint(): void {
            for (var r = 0; r < visible; r++) {
                var idx = top + r;
                var line = idx < options.length ? fit(String(options[idx]), box.cols) : rep(" ", box.cols);
                console.write(gotoRC(box.top + r, box.left) +
                    (idx === cur ? sgr("0;37;44") : sgr("0;37")) + line + sgr("0"));
            }
        }

        paint();
        while (bbs.online && !js.terminated) {
            var k = waitKey();
            if (k === "\x1e" || k === "8") {              // up
                cur = cur > 0 ? cur - 1 : options.length - 1;
            } else if (k === "\x0a" || k === "2") {       // down
                cur = cur + 1 < options.length ? cur + 1 : 0;
            } else if (k === "\x10") {                    // page up (KEY_PAGEUP)
                cur = Math.max(0, cur - visible);
            } else if (k === "\x0e") {                    // page down (KEY_PAGEDN)
                cur = Math.min(options.length - 1, cur + visible);
            } else if (k === "\x02") {                    // home
                cur = 0;
            } else if (k === "\x03") {                    // end
                cur = options.length - 1;
            } else if (k === "\r" || k === "\n") {
                if (ctx) ctx.cur = cur;
                return cur;
            } else if (k === ESC || k === "q" || k === "Q") {
                if (ctx) ctx.cur = cur;
                return -1;
            } else if (ctx && ctx.actionKeys && k &&
                ctx.actionKeys[k.toUpperCase()] !== undefined) {
                // Caller-defined hotkey: remember the row and return its
                // sentinel so the caller can act on the highlighted item
                // (e.g. "T" opens track details from the song list).
                ctx.cur = cur;
                return ctx.actionKeys[k.toUpperCase()];
            }
            if (cur < top) top = cur;
            if (cur >= top + visible) top = cur - visible + 1;
            paint();
        }
        return -1;
    }

    var shim: any = {
        help_text: "",
        init: function (title: string, mode?: string): boolean {
            console.clear();
            return true;
        },
        bail: function (): void {
            console.write(sgr("0"));
        },
        msg: function (text: string): void {
            console.clear();
            var lines = String(text).split("\n");
            var widest = 10;
            for (var i = 0; i < lines.length; i++)
                widest = Math.max(widest, lines[i].length);
            var box = drawBox("Message", Math.min(lines.length + 1, scrRows() - 6), widest);
            for (var r = 0; r < Math.min(lines.length, box.rows); r++)
                console.write(gotoRC(box.top + r, box.left) + sgr("0;37") +
                    fit(lines[r], box.cols) + sgr("0"));
            console.write(gotoRC(box.top + box.rows - 1, box.left) + sgr("0;30;1") +
                fit("[ Press any key ]", box.cols) + sgr("0"));
            waitKey();
        },
        input: function (mode: number, prompt: string, initial?: string, maxLen?: number): string {
            console.clear();
            var max = maxLen && maxLen > 0 ? maxLen : 60;
            var box = drawBox(prompt, 2, Math.min(max + 2, scrCols() - 10));
            console.write(gotoRC(box.top, box.left) + sgr("0;37"));
            // K_EDIT preloads the initial value for editing when supported.
            var got = console.getstr(String(initial || ""), max, K_EDIT | K_LINE);
            console.write(sgr("0"));
            if (got === null || got === undefined)
                return "";
            return String(got);
        },
        showbuf: function (mode: number, title: string, text: string): void {
            console.clear();
            var lines = String(text).split("\n");
            var page = scrRows() - 5;
            var offset = 0;
            for (; ;) {
                console.clear();
                var box = drawBox(title, page, scrCols() - 8);
                for (var r = 0; r < page; r++) {
                    var idx = offset + r;
                    console.write(gotoRC(box.top + r, box.left) + sgr("0;37") +
                        fit(idx < lines.length ? lines[idx] : "", box.cols) + sgr("0"));
                }
                console.write(gotoRC(scrRows(), 2) + sgr("0;30;1") +
                    "[Up/Down/PgUp/PgDn scroll, Q/Esc done]" + sgr("0"));
                var k = waitKey();
                if (k === ESC || k === "q" || k === "Q" || k === "\r")
                    return;
                if ((k === "\x1e" || k === "8") && offset > 0) offset--;
                else if ((k === "\x0a" || k === "2") && offset + page < lines.length) offset++;
                else if (k === "\x10") offset = Math.max(0, offset - page);
                else if (k === "\x0e") offset = Math.min(Math.max(0, lines.length - page), offset + page);
            }
        },
        list: null as any
    };
    shim.list = shimList;
    (shimList as any).CTX = CTX;

    // Install only where the real uifc is absent (in-process door runs).
    if (typeof uifc === "undefined") {
        (js as any).global.uifc = shim;
    }
}
