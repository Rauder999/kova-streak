# Dev server: python http.server с отключенным кешем, чтобы правки было видно
# по обычной перезагрузке. File System Access API работает на localhost без https.
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class _Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = False


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    try:
        server = _Server(("127.0.0.1", port), NoCacheHandler)
    except OSError:
        sys.exit(0)  # уже запущен
    server.serve_forever()
