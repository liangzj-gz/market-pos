#!/usr/bin/env bash
# 集市收银台 · 本地调试服务
#   - 绑定 0.0.0.0：同一 Wi-Fi / 热点下的 iPad、手机可直接打开
#   - 禁用所有缓存：改完文件刷新就生效，不用清缓存
# 用法：./dev.sh [端口]     默认 8080
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8080}"
PY="/Users/liangzj/.workbuddy/binaries/python/versions/3.13.12/bin/python3"
[ -x "$PY" ] || PY="$(command -v python3)"

exec "$PY" - "$PORT" <<'PYCODE'
import http.server, socket, socketserver, sys

port = int(sys.argv[1])


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("223.5.5.5", 80))
        ips.add(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()
    return sorted(i for i in ips if not i.startswith("127."))


print("集市收银台 · 本地调试服务")
print(f"  端口 {port}，缓存已关闭（改完刷新即生效）")
print(f"  本机    http://127.0.0.1:{port}")
for ip in lan_ips():
    print(f"  局域网  http://{ip}:{port}   <- iPad / 手机用这个")
print("  Ctrl+C 停止\n", flush=True)

socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.request_queue_size = 64
socketserver.ThreadingTCPServer.daemon_threads = True
with socketserver.ThreadingTCPServer(("0.0.0.0", port), Handler) as httpd:
    httpd.serve_forever()
PYCODE
