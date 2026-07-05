declare var argv: string[];
declare var js: {
    exec_dir: string;
    terminated: boolean;
};
declare var console: any;
declare var bbs: {
    online: boolean;
    sys_status: number;
    command_str: string;
};
declare var system: {
    mods_dir: string;
    name: string;
    ctrl_dir: string;
    data_dir: string;
    temp_dir: string;
    inet_addr: string;
    datestr(value: number): string;
    username(userNumber: number): string;
    matchuser(alias: string, sysopOk?: boolean): number;
    exec(commandLine: string): number;
    popen(commandLine: string): string[] | null;
};
declare function md5_calc(data: string, hex?: boolean): string;
declare function mswait(milliseconds: number): void;
declare var user: {
    number: number;
    alias: string;
    ip_address: string;
    compare_ars(ars: string): boolean;
};

interface UifcListContext {
    cur: number;
    bar: number;
    left: number;
    top: number;
    width: number;
}
interface UifcListFunction {
    (mode: number, title: string, options: string[], ctx?: UifcListContext): number;
    CTX: {
        new(): UifcListContext;
    };
}
declare var uifc: {
    init(title: string, mode?: string): boolean;
    bail(): void;
    msg(text: string): void;
    input(mode: number, prompt: string, initial?: string, maxLen?: number, keyMode?: number): string;
    list: UifcListFunction;
    showbuf(mode: number, title: string, text: string): void;
    help_text: string;
};

declare var file_area: {
    dir: {
        [code: string]: {
            code: string;
            name: string;
            lib_name: string;
            path: string;
            can_download: boolean;
            download_ars: string;
        };
    };
};

declare var msg_area: {
    sub: {
        [code: string]: any;
    };
};

declare class FileBase {
    constructor(code: string);
    open(): boolean;
    close(): boolean;
    get_list(filespec?: string, detail?: number, sinceTime?: number, sort?: boolean, order?: number): any[];
    get_path(file: string | any): string;
    get_size(file: string | any): number;
    get_time(file: string | any): number;
    get(file: string | any, detail?: number): any;
    error: string;
    status: number;
    static DETAIL: {
        MIN: number;
        NORM: number;
        EXTENDED: number;
        AUXDATA: number;
        MAX: number;
    };
    static SORT: {
        NATURAL: number;
        NAME_AI: number;
        NAME_DI: number;
        DATE_A: number;
        DATE_D: number;
        SIZE_A: number;
        SIZE_D: number;
    };
}

declare class File {
    constructor(name: string, shareable?: boolean);
    open(mode: string): boolean;
    close(): void;
    read(length?: number): string;
    write(text: string, length?: number): boolean;
    writeln(text?: string): boolean;
    readAll(length?: number): string[];
    iniGetValue(section: string | null, key: string, defaultValue?: any): any;
    iniGetSections(prefix?: string): string[];
    iniGetObject(section?: string | null): any;
    position: number;
    length: number;
    error: number;
    name: string;
}

declare class MsgBase {
    constructor(code: string);
    open(): boolean;
    close(): boolean;
    get_all_msg_headers(includeVotes?: boolean): any;
    get_msg_body(number: number): string;
}

declare class JSONClient {
    constructor(host: string, port: number);
    connect(): boolean;
    cycle(): void;
    subscribe(scope: string, location: string): any;
    unsubscribe(scope: string, location: string): any;
    write(scope: string, location: string, data: any, lock?: number): any;
    push(scope: string, location: string, data: any, lock?: number): any;
    slice(scope: string, location: string, start?: number, end?: number, lock?: number): any[];
    updates: any[];
    disconnect(): void;
}

declare class JSONChat {
    constructor(usernum: number, jsonclient: JSONClient, host?: string, port?: number);
    connect(): boolean;
    disconnect(): void;
    join(target: string): void;
    submit(target: string, text: string): boolean;
    cycle(): boolean;
    client: JSONClient;
    nick: any;   // { name, host, ip } -- set manually since connect() is skipped
    channels: {
        [name: string]: {
            name: string;
            messages: any[];
        };
    };
}

declare class JSONdb {
    constructor(fileName: string, scope?: string);
    masterData: { data: { [key: string]: any } };
    settings: { [k: string]: any };
    load(): void;
    save(): void;
}
declare function time(): number;

declare function load(...args: any[]): any;
declare function require(...args: any[]): any;
declare function log(level: number, message: string): void;
declare function file_exists(path: string): boolean;
declare function file_size(path: string): number;
declare function file_date(path: string): number;
declare function fullpath(path: string): string;
declare function backslash(path: string): string;
declare function directory(pattern: string): string[];
declare function mkpath(path: string): boolean;
declare function base64_decode(data: string): string;
declare function base64_encode(data: string): string;
declare function utf8_encode(data: string): string;
declare function utf8_decode(data: string): string;
declare function utf8_utf16(data: string): string;
declare function utf8_cp437(data: string): string;
declare function str_is_utf8(data: string): boolean;
declare function ascii(code: number | string): string;
declare function format(fmt: string, ...args: any[]): string;
declare function time(): number;
declare function ctrl(value: string): string;
declare function exit(code?: number): never;

declare var WIN_SAV: number;
declare var WIN_ACT: number;
declare var WIN_ESC: number;
declare var WIN_MID: number;
declare var WIN_HLP: number;
declare var K_EDIT: number;
declare var K_LINE: number;
declare var K_NUMBER: number;
declare var K_UPPER: number;
declare var K_NONE: number;
declare var USER_ANSI: number;
declare var USER_UTF8: number;
declare var MSG_DELETE: number;
declare var LOG_WARNING: number;
