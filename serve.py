# Dev server: python http.server with caching disabled so edits show up on
# a plain reload. File System Access API works on localhost without https.
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
        sys.exit(0)  # already running
    server.serve_forever()
