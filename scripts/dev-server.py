#!/usr/bin/env python3
"""Static dev server that refuses to be cached.

`python3 -m http.server` sends no cache headers, so browsers hold on to ES
modules across edits and you end up debugging code you already replaced.
This serves the same files with `no-store` and the right module MIME type.
"""
import functools
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "GET" in (args[0] if args else ""):
            return                       # keep the console readable
        super().log_message(fmt, *args)

    def handle_one_request(self):
        """A reload mid-transfer aborts the socket. Untrapped, that kills
        the serving thread and — often enough — takes the server with it,
        which shows up as ERR_CONNECTION_RESET and a stale module cache."""
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        """Never let one bad connection end the process."""
        import sys
        exc = sys.exc_info()[0]
        if exc in (BrokenPipeError, ConnectionResetError):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), functools.partial(Handler)) as httpd:
        print(f"serving http://127.0.0.1:{PORT}  (no-store)")
        httpd.serve_forever()
