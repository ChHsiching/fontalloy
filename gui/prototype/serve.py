import os, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

class FastHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isfile(path):
            sz = os.path.getsize(path)
            self.send_response(200)
            ext = os.path.splitext(path)[1].lower()
            mimes = {'.html':'text/html','.css':'text/css','.js':'application/javascript',
                     '.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2',
                     '.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'}
            self.send_header('Content-Type', mimes.get(ext, 'application/octet-stream'))
            self.send_header('Content-Length', str(sz))
            self.send_header('Cache-Control', 'max-age=86400')
            self.end_headers()
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk: break
                    self.wfile.write(chunk)
        else:
            super().do_GET()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = HTTPServer(('', port), FastHandler)
    print(f'Serving on :{port}')
    server.serve_forever()
