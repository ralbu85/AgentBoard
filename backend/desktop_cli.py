"""Agent CLI for the same Chromium tabs visible in AgentBoard Desktop."""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['clients', 'list', 'open', 'navigate', 'snapshot', 'screenshot', 'click', 'fill', 'key', 'scroll', 'back', 'forward', 'reload', 'stop', 'close'])
    parser.add_argument('--server', default='http://127.0.0.1:3002')
    parser.add_argument('--desktop', help='Required when multiple desktops are connected')
    for name in ('id', 'workspace', 'url', 'selector', 'text', 'key', 'output'):
        parser.add_argument('--'+name)
    parser.add_argument('--dy', type=float)
    args = parser.parse_args()
    token = os.getenv('AGENTBOARD_AUTH_TOKEN')
    if not token and args.server == 'http://127.0.0.1:3002':
        from . import config
        token = config.AUTH_TOKEN
    if not token:
        parser.error('이 서버의 인증 토큰을 AGENTBOARD_AUTH_TOKEN 환경 변수로 지정하세요.')

    def request(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(args.server.rstrip('/')+path, data=data,
                                     headers={'Cookie': 'token='+token, 'Content-Type': 'application/json'})
        # Never follow redirects carrying the authentication cookie to another host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **kw):
                return None
        with urllib.request.build_opener(NoRedirect).open(req, timeout=25) as response:
            return json.load(response)

    try:
        clients = request('/api/desktop/clients')['clients']
        if args.action == 'clients':
            print(json.dumps(clients, ensure_ascii=False, indent=2))
            return
        desktop = args.desktop
        if not desktop:
            if len(clients) != 1:
                parser.error('연결된 데스크톱이 한 개가 아닙니다. clients로 확인하고 --desktop을 지정하세요.')
            desktop = clients[0]['id']
        body = {'action': args.action}
        for name in ('id', 'workspace', 'url', 'selector', 'text', 'key', 'dy'):
            if getattr(args, name) is not None:
                body[name] = getattr(args, name)
        result = request('/api/desktop/clients/'+urllib.parse.quote(desktop, safe='')+'/command', body)['result']
        if args.action == 'screenshot' and args.output:
            with open(args.output, 'xb') as target:
                target.write(base64.b64decode(result['base64'], validate=True))
            print(json.dumps({'saved': args.output}))
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as exc:
        print(f'HTTP {exc.code}: {exc.read().decode()}', file=sys.stderr)
        sys.exit(1)
    except (urllib.error.URLError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
