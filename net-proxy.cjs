const { net } = require('electron');
const { StringDecoder } = require('string_decoder');

/**
 * 主进程网络代理：渲染进程受跨域限制时，改由主进程发请求，边收边回传。
 * 在主进程里用 StringDecoder 解码，避免多字节汉字被切断。
 */
exports.startRequest = function startRequest(options, onEvent) {
    let url;
    try {
        url = new URL(options.url);
    } catch (e) {
        onEvent('error', { message: '地址格式不对：' + options.url });
        return { abort() {} };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        onEvent('error', { message: '只支持 http/https，当前是 ' + url.protocol });
        return { abort() {} };
    }

    const owner = options.owner;
    if (!owner || owner.isDestroyed()) {
        onEvent('error', { message: '请求所属窗口已关闭' });
        return { abort() {} };
    }

    const request = net.request({
        url: url.href,
        method: options.method || 'POST',
        session: owner.session,
        credentials: 'omit',
        useSessionCookies: false,
    });

    const decoder = options.binary ? null : new StringDecoder('utf8');
    const binChunks = options.binary ? [] : null;
    let finished = false;

    const cleanup = () => { owner.removeListener('destroyed', abort); };
    const send = (type, value) => {
        if (owner.isDestroyed()) { abort(); return; }
        try { onEvent(type, value); } catch { abort(); }
    };
    const fail = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        send('error', { message: (error && error.message) || String(error) });
        try { request.abort(); } catch {}
    };
    const abort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        try { request.abort(); } catch {}
    };

    owner.once('destroyed', abort);
    request.on('error', fail);

    request.on('response', (response) => {
        if (finished) return;
        send('response', { statusCode: response.statusCode, headers: response.headers });
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('连接被中断')));
        response.on('data', (chunk) => {
            if (finished) return;
            if (binChunks) {
                binChunks.push(Buffer.from(chunk));
                return;
            }
            const text = decoder.write(chunk);
            if (text) send('data', text);
        });
        response.on('end', () => {
            if (finished) return;
            finished = true;
            cleanup();
            if (binChunks) {
                // 二进制响应整包按 base64 回传，避免 UTF-8 解码把图片字节毁掉
                const b64 = Buffer.concat(binChunks).toString('base64');
                if (b64) send('binary', b64);
                send('end');
                return;
            }
            const tail = decoder.end();
            if (tail) send('data', tail);
            send('end');
        });
    });

    try {
        for (const [key, value] of Object.entries(options.headers || {})) {
            request.setHeader(key, String(value));
        }
        // 二进制请求体（图生图的 multipart）走 bodyBase64。
        // 不能直接用 options.body：字符串会被当 UTF-8 再转一次，图片字节就坏了。
        if (typeof options.bodyBase64 === "string" && options.bodyBase64) {
            request.end(Buffer.from(options.bodyBase64, 'base64'));
        } else {
            request.end(options.body || undefined);
        }
    } catch (error) {
        fail(error);
    }

    return { abort };
};
